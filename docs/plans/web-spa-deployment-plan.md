# Web SPA deployment — fork-side implementation plan

Scope: AGPL fork (`Nuvo-Software-Pty-Ltd/paseo`, branch `plan-web-spa-deployment`). The fork-side work to replace the upstream Cloudflare Pages deploy of the Expo SPA with an AWS-native S3 + CloudFront pipeline backed by a reusable CDK construct (`StaticSpaSite`), distributed to the proprietary Orchestra monorepo via a tarball-in-S3 mechanism.

Design source of truth: [`paseo-cloud-daemon/90-cloud-considerations/web-spa-deployment.md`](../../../../Documents/paseo-cloud-daemon/90-cloud-considerations/web-spa-deployment.md) (operator-committed). This plan does **not** re-derive design choices; it specifies how to land them.

Out of scope (covered by a sibling planning agent against `orchestra-cloud-private`): `packages/infra/lib/web-stack.ts`, the vendoring CI step (`aws s3 cp ... vendor/`), and the helper `npm run fetch:vendored-packages`. Cross-references in this plan name the Orchestra-side dependency where it touches the fork's deliverable but do not specify the Orchestra-side implementation.

## Why this file is not under `D-N-plans/`

The repo's existing plan convention is `D-N-plans/PLAN-{stream}.md`, where `D-N` is a roadmap phase from `paseo-cloud-daemon/IMPLEMENTATION-ROADMAP.md`. Web SPA deployment is not a roadmap phase — it is a one-shot fork divergence (single PR per design doc § "Cutover"). Filing it under a new `D-X-plans/` would collide with the phase-numbered convention. Filing under `docs/plans/` parallels how `docs/` already hosts long-lived system docs and matches the design doc's posture: this is operational infrastructure, not feature-roadmap work. The folder is new; one file lives in it today.

---

## Stream summary

This plan owns:

1. **New `packages/infra-web/` package** — CDK v2 reusable construct (`lib/static-spa-site.ts`) + runnable CDK app (`bin/web-deploy.ts`) + package metadata + README.
2. **Workflow replacement** — `.github/workflows/deploy-app.yml` replaced wholesale; two jobs (`deploy-web` against a fork-owned test AWS account; `package-infra-web` cross-account into `nuvo-ai`).
3. **Cleanup of upstream Cloudflare config in the fork** — `wrangler` devDep + `deploy:web` script removed from `packages/app/package.json`; `wrangler` removed from `knip.json` `ignoreBinaries`; secrets removed from GH Actions.
4. **Workspace plumbing** — root `package.json` workspace addition; `knip.json` workspace entry; lefthook ergonomics; release scripts updated for the new workspace.
5. **FORK-NOTES.md divergence entry** — under a new "Cloud-mode additions (web SPA deployment)" section.
6. **IAM / OIDC** — GH OIDC trust into `nuvo-ai` (cross-account assume for the tarball publish); least-privilege IAM role scoped to `s3:PutObject` on the `infra-web-static/` key prefix only; existing fork-owned test account role gets `cdk deploy` permissions for the SPA stack.

This plan does **not** own:

- `packages/infra/lib/web-stack.ts` in `orchestra-cloud-private` — sibling planning agent.
- `app.orchestra.nuvo.software` Route53 records or ACM certs — created at first Orchestra `cdk deploy`, not from this repo.
- `packages/website/` (marketing site) — stays on Cloudflare Workers per design doc § "Out of scope".

---

## 1. File-by-file changes

### NEW: `packages/infra-web/package.json`

```json
{
  "name": "@orchestra/infra-web-static",
  "version": "0.1.0",
  "private": true,
  "description": "Reusable CDK v2 construct + runnable app for the Paseo SPA on S3 + CloudFront. Distributed as a tarball in s3://orchestra-internal-packages/infra-web-static/ — NEVER published to npm.",
  "main": "dist/lib/static-spa-site.js",
  "types": "dist/lib/static-spa-site.d.ts",
  "exports": {
    ".": {
      "types": "./dist/lib/static-spa-site.d.ts",
      "default": "./dist/lib/static-spa-site.js"
    }
  },
  "files": ["dist", "lib", "bin", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "cdk": "cdk",
    "deploy": "cdk deploy --app 'npx tsx bin/web-deploy.ts'",
    "synth": "cdk synth --app 'npx tsx bin/web-deploy.ts'",
    "pack": "npm run build && npm pack"
  },
  "dependencies": {
    "aws-cdk-lib": "^2.170.0",
    "constructs": "^10.4.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "aws-cdk": "^2.170.0",
    "tsx": "^4.19.0",
    "typescript": "~5.9.2"
  }
}
```

Key points:

- `"private": true` and no `publishConfig`: distribution is via S3 tarball only (design doc § "Package layout").
- `"files"` ships compiled JS (`dist/`) plus original `lib/`/`bin/` sources for human inspection. Orchestra imports from `dist/`.
- `aws-cdk-lib` is pinned to the first stable major-minor selected for this fork — see § "Open questions" Q-1 about exact version.
- `tsx` is already a known binary in the repo's `knip.json` ignoreBinaries; reused here.

### NEW: `packages/infra-web/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": ".",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "module": "CommonJS",
    "moduleResolution": "node",
    "target": "ES2022",
    "lib": ["ES2023"],
    "types": ["node"]
  },
  "include": ["lib/**/*.ts", "bin/**/*.ts"]
}
```

Rationale: CDK constructs ship as CJS (the AWS CDK runtime expects this). Overriding `module`/`moduleResolution` from the root `tsconfig.base.json` (which sets `ESNext`/`bundler`) is necessary; document the override in the file's nearby README. Targets `ES2022` because aws-cdk-lib requires it.

### NEW: `packages/infra-web/cdk.json`

```json
{
  "app": "npx tsx bin/web-deploy.ts",
  "watch": { "include": ["lib/**", "bin/**"], "exclude": ["dist/**", "node_modules/**"] },
  "context": {
    "@aws-cdk/aws-cloudfront:defaultSecurityPolicyTLSv1_2_2021": true,
    "@aws-cdk/aws-iam:minimizePolicies": true,
    "@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy": true,
    "@aws-cdk/customresources:installLatestAwsSdkDefault": false
  }
}
```

### NEW: `packages/infra-web/lib/static-spa-site.ts`

Content sketch — the reusable construct. Exports:

```ts
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3Deployment from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

export interface StaticSpaSiteProps {
  /** Local path to the `dist/` directory from `npm run build:web --workspace=@getpaseo/app`. */
  sourcePath: string;
  /** e.g. "app.orchestra.nuvo.software". Optional; if absent, only the `dxyz.cloudfront.net` URL is reachable. */
  domainName?: string;
  /** Route53 zone for the A alias. Optional. If `domainName` is set but this is not, no record is created. */
  hostedZone?: route53.IHostedZone;
  /** ACM cert in us-east-1. Optional; created automatically when `hostedZone` is provided and this is absent. */
  certificate?: acm.ICertificate;
  /** Default `PriceClass_All`. Orchestra sets `PriceClass_100`. */
  priceClass?: cloudfront.PriceClass;
}

export class StaticSpaSite extends Construct {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly distributionId: string;
  readonly distributionDomainName: string;

  constructor(scope: Construct, id: string, props: StaticSpaSiteProps) {
    super(scope, id);

    // 1. Private S3 bucket — BlockPublicAccess.BLOCK_ALL, SSE-S3, versioning enabled.
    //    RemovalPolicy.RETAIN (this is asset storage — destroy must be explicit operator action).
    this.bucket = new s3.Bucket(this, "Bucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      enforceSSL: true,
    });

    // 2. Certificate — auto-create iff a hostedZone is provided and no cert was supplied.
    //    Must be in us-east-1; CDK's `acm.Certificate` honors the stack region — bin/web-deploy.ts
    //    pins the stack to us-east-1 OR uses DnsValidatedCertificate via a cross-region reference.
    //    See § "Open questions" Q-2.
    let certificate = props.certificate;
    if (!certificate && props.hostedZone && props.domainName) {
      certificate = new acm.Certificate(this, "Certificate", {
        domainName: props.domainName,
        validation: acm.CertificateValidation.fromDns(props.hostedZone),
      });
    }
    if (props.domainName && !certificate) {
      throw new Error(
        "StaticSpaSite: when `domainName` is set without `hostedZone`, `certificate` must be supplied explicitly (DNS validation needs the zone).",
      );
    }

    // 3. CloudFront distribution with Origin Access Control.
    //    Two cache behaviors:
    //      - default (no-cache, for index.html and routes)
    //      - `_expo/*` long-cache (1 year, immutable) for hashed assets.
    //    SPA routing: 403 + 404 → /index.html with 200.
    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        compress: true,
      },
      additionalBehaviors: {
        "_expo/*": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
        },
        // Expo also emits `assets/*` for static fonts/images; mirror the long-cache rule.
        "assets/*": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
        },
      },
      defaultRootObject: "index.html",
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: Duration.seconds(0),
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: Duration.seconds(0),
        },
      ],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: props.priceClass ?? cloudfront.PriceClass.PRICE_CLASS_ALL,
      domainNames: props.domainName ? [props.domainName] : undefined,
      certificate,
      enableLogging: false, // CloudFront access logs deferred — see design doc § "Out of scope".
    });

    // 4. Sync the dist/ contents into the bucket on every deploy, then invalidate index.html.
    new s3Deployment.BucketDeployment(this, "Deployment", {
      sources: [s3Deployment.Source.asset(props.sourcePath)],
      destinationBucket: this.bucket,
      distribution: this.distribution,
      distributionPaths: ["/index.html"],
      // Long-cache assets are content-hashed by Expo, so a stale CloudFront object survives only
      // until its TTL expires; index.html is the only path we must invalidate on every deploy.
      prune: true,
    });

    // 5. Route53 A-alias — only when both hostedZone and domainName are supplied.
    if (props.hostedZone && props.domainName) {
      new route53.ARecord(this, "AliasRecord", {
        zone: props.hostedZone,
        recordName: props.domainName,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.CloudFrontTarget(this.distribution),
        ),
      });
    }

    this.distributionId = this.distribution.distributionId;
    this.distributionDomainName = this.distribution.distributionDomainName;
  }
}
```

Notes on the sketch:

- The construct intentionally does **not** accept a `bucket` prop (Orchestra never reuses an existing bucket; design doc is silent — assume create-only).
- `prune: true` removes orphaned objects from previous builds; combined with bucket versioning, prior builds are recoverable from S3 versioning if needed.
- Security response headers (CSP, HSTS, Permissions-Policy) are deferred per design doc § "Out of scope". Leave a `// TODO(security-headers):` comment at the construct head pointing to the design doc section.

### NEW: `packages/infra-web/bin/web-deploy.ts`

Runnable CDK app — the entry point both `cdk deploy` and the GH Actions `deploy-web` job invoke. Reads config from env so self-host operators and CI use the same code path (design doc § "Self-host operator deploy path").

```ts
#!/usr/bin/env node
import "source-map-support/register";
import * as path from "node:path";
import { App, Stack, StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
import { StaticSpaSite } from "../lib/static-spa-site";

interface WebSpaStackProps extends StackProps {
  sourcePath: string;
  domainName?: string;
  hostedZoneId?: string;
  hostedZoneName?: string;
  certificateArn?: string;
  priceClass?: cloudfront.PriceClass;
}

class WebSpaStack extends Stack {
  constructor(scope: Construct, id: string, props: WebSpaStackProps) {
    super(scope, id, props);
    const hostedZone =
      props.hostedZoneId && props.hostedZoneName
        ? route53.HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
            hostedZoneId: props.hostedZoneId,
            zoneName: props.hostedZoneName,
          })
        : undefined;
    const certificate = props.certificateArn
      ? acm.Certificate.fromCertificateArn(this, "Cert", props.certificateArn)
      : undefined;

    new StaticSpaSite(this, "Site", {
      sourcePath: props.sourcePath,
      domainName: props.domainName,
      hostedZone,
      certificate,
      priceClass: props.priceClass,
    });
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const account = requireEnv("CDK_DEPLOY_ACCOUNT");
const region = requireEnv("CDK_DEPLOY_REGION"); // operator-supplied; not pinned to us-east-1 because the bucket
// lives in the operator's region; the cert path requires us-east-1
// separately — see § "Open questions" Q-2.

const sourcePath = process.env.SPA_DIST_PATH
  ? path.resolve(process.env.SPA_DIST_PATH)
  : path.resolve(__dirname, "../../app/dist");

const stackName = process.env.WEB_STACK_NAME ?? "PaseoWebSpa";

const priceClassEnv = process.env.WEB_PRICE_CLASS;
const priceClass =
  priceClassEnv === "PRICE_CLASS_100"
    ? cloudfront.PriceClass.PRICE_CLASS_100
    : priceClassEnv === "PRICE_CLASS_200"
      ? cloudfront.PriceClass.PRICE_CLASS_200
      : cloudfront.PriceClass.PRICE_CLASS_ALL;

const app = new App();
new WebSpaStack(app, stackName, {
  env: { account, region },
  sourcePath,
  domainName: process.env.WEB_DOMAIN,
  hostedZoneId: process.env.HOSTED_ZONE_ID,
  hostedZoneName: process.env.HOSTED_ZONE_NAME,
  certificateArn: process.env.WEB_CERT_ARN,
  priceClass,
});
```

Env-var contract (this is the documented surface for self-host operators and Orchestra):

| Env var                               | Required                                                               | Used by                                     |
| ------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------- |
| `CDK_DEPLOY_ACCOUNT`                  | yes                                                                    | CDK env binding                             |
| `CDK_DEPLOY_REGION`                   | yes                                                                    | CDK env binding                             |
| `SPA_DIST_PATH`                       | optional (defaults to `../app/dist`)                                   | construct `sourcePath`                      |
| `WEB_DOMAIN`                          | optional                                                               | construct `domainName`                      |
| `HOSTED_ZONE_ID` + `HOSTED_ZONE_NAME` | optional (both required together)                                      | construct `hostedZone`                      |
| `WEB_CERT_ARN`                        | optional                                                               | construct `certificate` (skips auto-create) |
| `WEB_PRICE_CLASS`                     | optional, one of `PRICE_CLASS_ALL`/`PRICE_CLASS_100`/`PRICE_CLASS_200` | construct `priceClass`                      |
| `WEB_STACK_NAME`                      | optional (defaults to `PaseoWebSpa`)                                   | CloudFormation stack name                   |

### NEW: `packages/infra-web/README.md`

Short README documenting:

- What the package is (reusable construct + runnable CDK app).
- Self-host operator deploy path (verbatim from design doc § "Self-host operator deploy path").
- Distribution mechanism note: "This package is **never** published to npm. It is packed (`npm pack`) and uploaded to `s3://orchestra-internal-packages/infra-web-static/<version>.tgz` by the fork's CI. Orchestra consumes the tarball via a `file:` dependency."
- Env-var contract table (above).
- A pointer to the design doc.

### NEW: `packages/infra-web/.gitignore`

```
cdk.out/
dist/
*.tgz
```

### EDITED: `packages/app/package.json`

Diff:

```diff
   "scripts": {
     ...
-    "deploy:web": "npm run build:web && wrangler pages deploy dist --project-name paseo-app --branch main"
   },
   ...
   "devDependencies": {
     ...
-    "wrangler": "^4.75.0",
     "ws": "^8.20.0"
   }
```

No other changes to this file. The `build:web` script remains — it produces the artifact the new pipeline deploys.

### EDITED: `package.json` (root)

Diff:

```diff
   "workspaces": [
     "packages/expo-two-way-audio",
     "packages/highlight",
     "packages/server",
     "packages/app",
     "packages/relay",
     "packages/website",
     "packages/desktop",
-    "packages/cli"
+    "packages/cli",
+    "packages/infra-web"
   ],
```

`typecheck` already runs `--workspaces --if-present`, so the new package's `typecheck` script is picked up automatically. No script renames; no `build:daemon` changes (infra-web is not part of the daemon).

### EDITED: `knip.json`

Add a workspace entry; remove `wrangler` from `ignoreBinaries`.

```diff
     "packages/expo-two-way-audio": {
       "entry": ["src/index.ts"],
       "project": ["src/**/*.ts"]
+    },
+    "packages/infra-web": {
+      "entry": ["bin/web-deploy.ts", "lib/static-spa-site.ts"],
+      "project": ["lib/**/*.ts", "bin/**/*.ts"]
     }
   },
   ...
   "ignoreBinaries": [
     "expo-module",
     "xed",
     "eas",
     "playwright",
-    "wrangler",
     "powershell",
     "tsx",
     "vitest",
     "open"
+    "cdk"
   ]
```

Adding `cdk` to `ignoreBinaries`: the `cdk` binary appears in `packages/infra-web/package.json` scripts but knip cannot resolve it through CDK's monorepo packaging without noise. Pattern matches existing `tsx`/`vitest`/`playwright` entries.

### EDITED: `.github/workflows/deploy-app.yml` (replacement, not diff)

Full file content sketch:

```yaml
# Deploy the Expo web SPA to AWS (S3 + CloudFront) via the StaticSpaSite construct,
# and publish the construct tarball to s3://orchestra-internal-packages/infra-web-static/.
#
# Two jobs:
#  - deploy-web:        builds the SPA, runs `cdk deploy` against a fork-owned test account.
#                       Purpose: exercise the construct on every release so it cannot silently rot.
#                       NOT a user-facing deploy.
#  - package-infra-web: `npm pack` the construct + cross-account `aws s3 cp` into nuvo-ai's
#                       internal-packages bucket. Orchestra's CI vendors the tarball.
#
# Auth: GitHub OIDC. Both jobs assume IAM roles by ARN, no long-lived AWS keys.

name: Deploy App

on:
  push:
    tags:
      - "v*"
      - "!v*-beta.*"
      - "app-v*"
      - "!app-v*-beta.*"
  workflow_dispatch:

permissions:
  id-token: write # required for OIDC
  contents: read

env:
  AWS_REGION_FORK_TEST: ap-southeast-2
  # Fork-owned test account (re-uses the same Nuvo dev account ECR uses today; see § Open questions Q-3).
  OIDC_ROLE_ARN_DEPLOY_WEB: arn:aws:iam::437906455141:role/gh-actions-paseo-fork-deploy-web
  # Cross-account into nuvo-ai for the tarball publish.
  OIDC_ROLE_ARN_PACKAGE_PUBLISH: arn:aws:iam::${{ vars.NUVO_AI_ACCOUNT_ID }}:role/gh-actions-paseo-fork-infra-web-publisher
  INFRA_WEB_PACKAGE_BUCKET: orchestra-internal-packages
  INFRA_WEB_PACKAGE_PREFIX: infra-web-static

jobs:
  deploy-web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Build highlight dependency
        run: npm run build --workspace=@getpaseo/highlight

      - name: Typecheck app + infra-web
        run: |
          npm run typecheck --workspace=@getpaseo/app
          npm run typecheck --workspace=@orchestra/infra-web-static

      - name: Build SPA
        run: npm run build:web --workspace=@getpaseo/app

      - name: Build infra-web construct
        run: npm run build --workspace=@orchestra/infra-web-static

      - name: Configure AWS credentials (OIDC, fork test account)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ env.OIDC_ROLE_ARN_DEPLOY_WEB }}
          aws-region: ${{ env.AWS_REGION_FORK_TEST }}

      - name: CDK deploy (fork test account, no custom domain)
        working-directory: packages/infra-web
        env:
          CDK_DEPLOY_ACCOUNT: "437906455141"
          CDK_DEPLOY_REGION: ${{ env.AWS_REGION_FORK_TEST }}
          SPA_DIST_PATH: ${{ github.workspace }}/packages/app/dist
          WEB_STACK_NAME: PaseoForkTestWebSpa
        run: npx cdk deploy --require-approval never

  package-infra-web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Build infra-web construct
        run: npm run build --workspace=@orchestra/infra-web-static

      - name: Read package version
        id: pkg
        run: |
          VERSION=$(node -p "require('./packages/infra-web/package.json').version")
          echo "version=${VERSION}" >> "$GITHUB_OUTPUT"

      - name: npm pack
        id: pack
        working-directory: packages/infra-web
        run: |
          TARBALL=$(npm pack --silent | tail -n1)
          echo "tarball=packages/infra-web/${TARBALL}" >> "$GITHUB_OUTPUT"

      - name: Configure AWS credentials (OIDC, cross-account into nuvo-ai)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ env.OIDC_ROLE_ARN_PACKAGE_PUBLISH }}
          aws-region: ${{ env.AWS_REGION_FORK_TEST }} # role is region-agnostic; bucket is regional — see § Q-4.

      - name: Upload tarball to internal-packages bucket
        env:
          VERSION: ${{ steps.pkg.outputs.version }}
          TARBALL: ${{ steps.pack.outputs.tarball }}
        run: |
          aws s3 cp "$TARBALL" \
            "s3://${INFRA_WEB_PACKAGE_BUCKET}/${INFRA_WEB_PACKAGE_PREFIX}/${VERSION}.tgz" \
            --no-progress

      - name: Refuse to overwrite an existing version (sanity)
        env:
          VERSION: ${{ steps.pkg.outputs.version }}
        run: |
          # The IAM role's policy denies s3:PutObject when the key already exists (see § "IAM scoping"),
          # so this step is informational. If the upload succeeded above, the version is new.
          echo "Published infra-web tarball version ${VERSION} to s3://${INFRA_WEB_PACKAGE_BUCKET}/${INFRA_WEB_PACKAGE_PREFIX}/${VERSION}.tgz"
```

Notes:

- The two jobs are independent — they can run in parallel.
- `deploy-web` does **not** set `WEB_DOMAIN` or `HOSTED_ZONE_ID`; it deploys to the bare CloudFront URL in the fork's test account. The point is to exercise the construct, not to host a real user-facing site from the fork.
- The version-overwrite guard lives in the IAM policy (`s3:PutObject` with `s3:If-None-Match: "*"` condition — see § "IAM scoping"). If the operator forgets to bump `packages/infra-web/package.json` version before tagging, the upload fails fast with an IAM error.

### EDITED: `FORK-NOTES.md`

Add a new section before "What we did NOT change":

```markdown
## Cloud-mode additions (web SPA deployment)

The Expo web SPA (`packages/app`) is deployed via AWS S3 + CloudFront in the fork — upstream's Cloudflare Pages deploy was never wired into live traffic and is currently failing. Design: `paseo-cloud-daemon/90-cloud-considerations/web-spa-deployment.md`. Fork-side implementation plan: `docs/plans/web-spa-deployment-plan.md`.

### Files present only in the fork

- `packages/infra-web/` — new package containing the reusable `StaticSpaSite` CDK v2 construct (`lib/static-spa-site.ts`) and the runnable CDK app (`bin/web-deploy.ts`). Marked `"private": true`. Distributed via `npm pack` + S3 tarball (see below), never published to npm.
- `docs/plans/web-spa-deployment-plan.md` — implementation plan for the divergence.

### Files modified in the fork

- `.github/workflows/deploy-app.yml` — replaces upstream's Cloudflare Pages deploy with two AWS-native jobs:
  - `deploy-web` — runs `cdk deploy bin/web-deploy.ts` against the fork-owned test account (OIDC-federated) on every release tag. Purpose: exercise the construct so it cannot silently rot.
  - `package-infra-web` — `npm pack`s the construct and uploads the tarball to `s3://orchestra-internal-packages/infra-web-static/<version>.tgz` in the nuvo-ai account (cross-account OIDC assume). Orchestra's CI vendors the tarball pre-`npm install`.
- `packages/app/package.json` — `deploy:web` script removed; `wrangler` devDep removed.
- `package.json` (root) — workspace list includes `packages/infra-web`.
- `knip.json` — workspace entry for `packages/infra-web`; `wrangler` removed from `ignoreBinaries`; `cdk` added.

### Secrets / variables removed

- GH Actions secret `CLOUDFLARE_API_TOKEN` — drop after the workflow merges. (`packages/website/`'s deploy still uses `CLOUDFLARE_API_TOKEN`; leave the secret alone if `deploy-website.yml` still references it. As of this fork the marketing site stays on Cloudflare Workers per the design doc § "Out of scope".)
- GH Actions inline env `CLOUDFLARE_ACCOUNT_ID` — removed at the same time as `CLOUDFLARE_API_TOKEN`'s deploy-app usage.

### Cloudflare project decommissioning

The `paseo-app` Cloudflare Pages project consumes a slot in the CF account but takes no traffic. Delete at convenience; no rush. Document the deletion in this section once done.

### Upstream-merge conflict policy

`packages/infra-web/` is **fork-only**; upstream merges cannot delete it (per `paseo-cloud-daemon/90-cloud-considerations/repo-topology.md` § (3) row "File present only in our fork"). `.github/workflows/deploy-app.yml` is "present in both, our diff is substantive (cloud-mode logic)" — ours wins on conflicts; integrate upstream changes only if they are security/correctness fixes. `packages/app/package.json` — the `deploy:web` and `wrangler` deletions stand; upstream's `wrangler` upgrades during a merge are dropped.
```

### EDITED: lefthook & root scripts

No edits required:

- `lefthook.yml` runs `npm run typecheck` (no `--workspace`), which already runs `typecheck` for every workspace `--if-present`. The new `packages/infra-web` has a `typecheck` script.
- `npm run format` (oxfmt) and `npm run lint` (oxlint) glob across the whole repo; the new `.ts` files are picked up automatically.

---

## 2. Ordered tasks with dependencies

Sizes: S ≈ ½ day, M ≈ 1–2 days, L ≈ 3+ days.

### T-1 — Scaffold `packages/infra-web/` package

Create `packages/infra-web/{package.json,tsconfig.json,cdk.json,.gitignore,README.md}` and empty `lib/`/`bin/` directories. Add the workspace entry in root `package.json` and `knip.json`. Run `npm install` from repo root to populate `node_modules` and verify `npm run typecheck` passes (with stub source files containing `export {}`).

**Size:** S.
**Depends on:** nothing.
**Parallel with:** T-7 (IAM/OIDC setup), T-8 (FORK-NOTES update — for the additions that don't depend on other artifacts).

### T-2 — Implement `lib/static-spa-site.ts`

Write the construct per the sketch in § 1. Include the `// TODO(security-headers):` comment. Verify `npm run typecheck --workspace=@orchestra/infra-web-static` and `npm run build --workspace=@orchestra/infra-web-static` produce a clean `dist/` directory.

**Size:** M.
**Depends on:** T-1.
**Parallel with:** T-7, T-8.

### T-3 — Implement `bin/web-deploy.ts`

Write the runnable CDK app per the sketch in § 1. Verify `npx cdk synth --app 'npx tsx bin/web-deploy.ts'` succeeds locally with `CDK_DEPLOY_ACCOUNT=000000000000 CDK_DEPLOY_REGION=us-east-1 SPA_DIST_PATH=/tmp/empty` (use an empty dir for synth-only).

**Size:** S.
**Depends on:** T-2.
**Parallel with:** T-7, T-8.

### T-4 — Remove `wrangler` + `deploy:web` from `packages/app/package.json`

Apply the diff in § 1. Run `npm install` to drop `wrangler` from the lockfile. Verify `npm run typecheck --workspace=@getpaseo/app` still passes.

**Size:** S.
**Depends on:** nothing (independent of `packages/infra-web/`).
**Parallel with:** T-1 through T-3, T-7, T-8.

### T-5 — Replace `.github/workflows/deploy-app.yml`

Apply the wholesale replacement in § 1. The workflow references `vars.NUVO_AI_ACCOUNT_ID` — that variable must exist in GH Actions before the workflow is exercised (T-7 covers).

**Size:** S.
**Depends on:** T-3 (the workflow invokes `bin/web-deploy.ts`); T-7 (the IAM roles and GH `vars.NUVO_AI_ACCOUNT_ID` must exist before the workflow runs successfully — landing the workflow file before the IAM is fine; the workflow simply fails until the IAM is in place, which is the normal sequencing on the next release tag).

### T-6 — Update `knip.json`

Apply the diff in § 1. Run `npm run knip` to verify no new dead-code warnings.

**Size:** S.
**Depends on:** T-2, T-3, T-4 (knip will flag mismatches if either source file is missing or if `wrangler` is still referenced).

### T-7 — IAM / OIDC / GH Actions vars

See § 3 below. This is the long pole of the project because it crosses AWS accounts.

**Size:** M.
**Depends on:** the fork-owned test account being available (already exists — `437906455141`); the nuvo-ai account ID (cross-stream).
**Parallel with:** T-1, T-2, T-3, T-4, T-8.

### T-8 — Update `FORK-NOTES.md`

Apply the diff in § 1. Skip the "Cloudflare project decommissioning" note's "Document the deletion in this section once done" until the project is actually deleted (post-merge).

**Size:** S.
**Depends on:** none directly; can be written before code lands.

### T-9 — Acceptance run

Tag a fork release (`v0.1.X` or `app-v0.1.X`, NOT beta) and watch both workflow jobs. Verify:

- `deploy-web` produces a CloudFormation stack `PaseoForkTestWebSpa` in `437906455141`/`ap-southeast-2`, the bucket has the SPA artifacts, and the bare CloudFront URL serves `index.html`.
- `package-infra-web` produces `s3://orchestra-internal-packages/infra-web-static/0.1.0.tgz` (or whatever `packages/infra-web/package.json` `version` is at tag time).

**Size:** S.
**Depends on:** T-1–T-8 all landed; T-7 IAM in place.

### Parallelism summary

- T-1, T-4, T-7, T-8 can run in parallel from day 1.
- T-2 unblocks once T-1 lands; T-3 unblocks once T-2 lands; T-5 unblocks once T-3 lands; T-6 unblocks once T-2/T-3/T-4 land.
- T-9 is the acceptance gate; it depends on everything.

A reasonable single-author sequencing is: (T-1 → T-2 → T-3) in series, with (T-4, T-7, T-8) interleaved opportunistically, finishing on T-5 → T-6 → T-9.

---

## 3. Infra / IAM setup tasks

### 3.1 GH OIDC trust into the fork test account (already exists)

The fork test account (`437906455141`, `ap-southeast-2`) already has a GH OIDC trust used by `build-and-publish-daemon.yml` (role `gh-actions-paseo-fork`). Reuse the same trust relationship; create a **new IAM role** named `gh-actions-paseo-fork-deploy-web` that:

- Trust policy: `token.actions.githubusercontent.com` with `sub` claim matched to `repo:Nuvo-Software-Pty-Ltd/paseo:ref:refs/tags/v*` and `repo:Nuvo-Software-Pty-Ltd/paseo:ref:refs/tags/app-v*` (mirrors the existing fork role's pattern). If easier, scope to the `plan-web-spa-deployment` branch during development and broaden to tag-based on first real release.
- Permissions: minimum required for `cdk deploy` of `StaticSpaSite`. Concretely:
  - `cloudformation:*` on stacks matching `PaseoForkTestWebSpa*` and `CDKToolkit*`.
  - `s3:*` on the CDK assets bucket (`cdk-*-assets-437906455141-ap-southeast-2`) and on buckets created by the stack (best expressed via tag-based conditions).
  - `cloudfront:*` on distributions (no resource-level ARN support for most CF actions; this is a known CDK pain).
  - `route53:*` (only used when `WEB_DOMAIN`/`HOSTED_ZONE_ID` are set; the fork test job does not set them, so this can be omitted for the fork role — see § "Open questions" Q-2 for the cross-region cert issue).
  - `iam:PassRole` only on roles tagged `aws-cdk:bootstrap-role` (CDK bootstrap pattern).
  - `acm:*` on us-east-1 — see § Q-2.
  - `sts:GetCallerIdentity` (always).
- Recommend: scope via `cdk bootstrap` with the new `--trust` flag rather than hand-rolling the policy. This is the documented AWS pattern. The trust target is the OIDC role.

### 3.2 GH OIDC trust into the nuvo-ai account (NEW)

In the **nuvo-ai** AWS account (account ID — see § Q-3), create:

1. **OIDC provider** for `token.actions.githubusercontent.com` (mirror what the fork test account already has — same thumbprint, same audience `sts.amazonaws.com`).
2. **IAM role** `gh-actions-paseo-fork-infra-web-publisher` with:
   - Trust policy:
     ```json
     {
       "Version": "2012-10-17",
       "Statement": [
         {
           "Effect": "Allow",
           "Principal": {
             "Federated": "arn:aws:iam::<NUVO_AI_ACCOUNT>:oidc-provider/token.actions.githubusercontent.com"
           },
           "Action": "sts:AssumeRoleWithWebIdentity",
           "Condition": {
             "StringEquals": {
               "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
             },
             "StringLike": {
               "token.actions.githubusercontent.com:sub": [
                 "repo:Nuvo-Software-Pty-Ltd/paseo:ref:refs/tags/v*",
                 "repo:Nuvo-Software-Pty-Ltd/paseo:ref:refs/tags/app-v*"
               ]
             }
           }
         }
       ]
     }
     ```
   - Permissions policy (least-privilege, **`s3:PutObject` on the `infra-web-static/` prefix only**):
     ```json
     {
       "Version": "2012-10-17",
       "Statement": [
         {
           "Sid": "PublishInfraWebTarball",
           "Effect": "Allow",
           "Action": ["s3:PutObject"],
           "Resource": "arn:aws:s3:::orchestra-internal-packages/infra-web-static/*",
           "Condition": {
             "StringEquals": { "s3:x-amz-server-side-encryption": "AES256" }
           }
         },
         {
           "Sid": "DenyOverwrite",
           "Effect": "Deny",
           "Action": ["s3:PutObject"],
           "Resource": "arn:aws:s3:::orchestra-internal-packages/infra-web-static/*",
           "Condition": {
             "Null": { "s3:If-None-Match": "true" }
           }
         }
       ]
     }
     ```
     The deny statement enforces that uploads include the `If-None-Match: *` header → S3 rejects overwrites of an existing key. The workflow's `aws s3 cp` call must add `--metadata-directive REPLACE` is **not** the right knob; instead the workflow should use `aws s3api put-object` with `--if-none-match '*'` if guarding against overwrites in the CLI directly. **Caveat — see § "Open questions" Q-5: the IAM-condition approach to "deny overwrite" via `s3:If-None-Match` is supported, but I have not verified that `aws s3 cp` injects the header automatically. If it doesn't, the workflow should use `aws s3api put-object --if-none-match '*'` instead. Flag for verification.**
3. **Bucket policy on `orchestra-internal-packages`** allowing the role principal to `s3:PutObject` on the `infra-web-static/*` prefix. (Bucket-side allow is required because the bucket and role live in the same account — the IAM policy is sufficient; bucket policy is only needed if the bucket explicitly denies non-allowlisted principals. Verify the bucket's current policy posture and add an allow if required.)

### 3.3 GH Actions repository secrets / variables

In `Nuvo-Software-Pty-Ltd/paseo` repo settings:

- **Add variable** `NUVO_AI_ACCOUNT_ID` = `<account ID>` (Variables, not Secrets — account IDs are not secret per AWS guidance, and using a variable makes the workflow ARN reference legible).
- **Remove secret** `CLOUDFLARE_API_TOKEN` (after `deploy-website.yml` is audited — if it still references the secret, leave it).
- The `CLOUDFLARE_ACCOUNT_ID` value was inlined in the workflow, not stored as a secret; deletion is mechanical.

### 3.4 S3 bucket (already exists per design doc)

`orchestra-internal-packages` exists in `nuvo-ai` per design doc § "Distribution mechanism". Verify:

- Bucket exists in the expected region (the workflow's `aws-region` arg sets the SDK region; if the bucket is in `us-east-1`, the upload still works as long as the SDK uses path-style or the URL resolves — `aws s3 cp` handles this transparently).
- Versioning is enabled (recommended; not required for correctness because the IAM deny-overwrite prevents stomping).
- BlockPublicAccess is BLOCK_ALL.

---

## 4. Test / verification steps

### 4.1 Local construct synth

```bash
cd packages/infra-web
npm run build
CDK_DEPLOY_ACCOUNT=000000000000 \
CDK_DEPLOY_REGION=us-east-1 \
SPA_DIST_PATH=/tmp/empty \
npx cdk synth
```

Expected: CFN template emitted to `cdk.out/` with one S3 bucket, one CloudFront distribution, one BucketDeployment custom resource, and no Route53/ACM resources (the env did not supply domain/zone). Confirm:

- The distribution has the `_expo/*` and `assets/*` cache behaviors.
- Error responses include 403 + 404 → `/index.html`.
- `BlockPublicAccess` is `BLOCK_ALL` on the bucket.

### 4.2 Local construct synth with custom domain (smoke-test the conditional branches)

```bash
CDK_DEPLOY_ACCOUNT=000000000000 \
CDK_DEPLOY_REGION=us-east-1 \
WEB_DOMAIN=spa-test.example.com \
HOSTED_ZONE_ID=ZXXXXXXXXXXXX \
HOSTED_ZONE_NAME=example.com \
SPA_DIST_PATH=/tmp/empty \
npx cdk synth
```

Expected: an `AWS::CertificateManager::Certificate` and `AWS::Route53::RecordSet` appear in the template; `domainNames` is populated on the distribution.

### 4.3 First end-to-end CI run (acceptance)

1. Push a release tag (`vX.Y.Z` or `app-vX.Y.Z`, non-beta).
2. Watch `deploy-app.yml` in GH Actions UI:
   - `deploy-web` should complete in ~5–10 minutes (CDK deploy + asset upload).
   - `package-infra-web` should complete in ~1–2 minutes.
3. Verify `deploy-web` outputs in the AWS Console:
   - CloudFormation stack `PaseoForkTestWebSpa` is `UPDATE_COMPLETE` (or `CREATE_COMPLETE` on first run).
   - The S3 bucket contains `index.html`, `_expo/static/js/web/<hash>.js`, etc.
   - `curl -sI https://<dxyz>.cloudfront.net/` returns `200` with `Content-Type: text/html`.
   - `curl -sI https://<dxyz>.cloudfront.net/some-nonexistent-route` returns `200` (SPA routing).
   - `curl -sI https://<dxyz>.cloudfront.net/_expo/static/js/web/<hash>.js` returns a `Cache-Control: public, max-age=...` header consistent with `CACHING_OPTIMIZED`.
4. Verify `package-infra-web` outputs:
   - `aws s3 ls s3://orchestra-internal-packages/infra-web-static/` shows `<version>.tgz` with the expected version.
   - `aws s3 cp s3://orchestra-internal-packages/infra-web-static/<version>.tgz - | tar -tzf - | head` reveals `package/dist/lib/static-spa-site.js`, `package/dist/lib/static-spa-site.d.ts`, `package/package.json`.

### 4.4 Overwrite-guard verification

Re-run `package-infra-web` without bumping `packages/infra-web/package.json` `version`:

- Expected: the upload step fails with an IAM error (or an If-None-Match conflict) — the role cannot overwrite the existing object.
- Bump the version and re-run; expected: success.

### 4.5 Self-host operator deploy verification

Document in `packages/infra-web/README.md`. A reviewer simulates an operator:

```bash
git clone <fork>
cd paseo-fork
npm ci
npm run build:web --workspace=@getpaseo/app
cd packages/infra-web
npm run build
CDK_DEPLOY_ACCOUNT=<their-account> \
CDK_DEPLOY_REGION=<their-region> \
WEB_STACK_NAME=MyOperatorSpa \
npx cdk deploy
```

Expected: a working deploy without WEB_DOMAIN/HOSTED_ZONE_ID, reachable at the bare `dxyz.cloudfront.net` URL.

### 4.6 Confirm Cloudflare cleanup

After the workflow lands:

- `grep -ri wrangler packages/app/` returns nothing relevant (the binary itself is gone from `knip.json` ignoreBinaries; the script is gone).
- `grep -ri CLOUDFLARE .github/workflows/` shows no references in `deploy-app.yml` (may remain in `deploy-website.yml` — the marketing site is out of scope per design doc).
- Optional: the `paseo-app` Cloudflare Pages project is deleted via the CF dashboard (or `wrangler pages project delete paseo-app` from a separate machine). Note in `FORK-NOTES.md` once done.

### 4.7 Existing test suite

`npm run typecheck` from repo root MUST pass (lefthook will block commit otherwise). The `packages/infra-web/typecheck` script runs as part of this. `npm run format` and `npm run lint` MUST pass on the new files. There are no unit tests for the construct itself — CDK constructs are typically tested via snapshot tests; defer per § "Out of scope" Q-6.

---

## 5. Acceptance criteria checklist

Closure of this divergence requires every item below to be true.

- [ ] `packages/infra-web/` package exists with `lib/static-spa-site.ts`, `bin/web-deploy.ts`, `package.json` (`"name": "@orchestra/infra-web-static"`, `"private": true`), `tsconfig.json`, `cdk.json`, `.gitignore`, `README.md`.
- [ ] `npm run typecheck` at repo root passes (covers infra-web's `typecheck` script via `--workspaces --if-present`).
- [ ] `npm run build --workspace=@orchestra/infra-web-static` produces a `dist/` with `dist/lib/static-spa-site.{js,d.ts}` and `dist/bin/web-deploy.js`.
- [ ] `npm pack` of `packages/infra-web/` produces a tarball that includes `dist/`, `lib/`, `bin/`, `README.md`, `package.json`, and **nothing else** (no `node_modules`, no `cdk.out`).
- [ ] `npx cdk synth` (env: empty `SPA_DIST_PATH`, no domain) emits a template with: 1 S3 bucket (BlockPublicAccess BLOCK_ALL, SSE-S3, versioned), 1 CloudFront distribution with `_expo/*` + `assets/*` long-cache behaviors and 403/404 → `/index.html` rules, TLS 1.2+, OAC, no Route53/ACM resources.
- [ ] `npx cdk synth` with `WEB_DOMAIN` + `HOSTED_ZONE_ID` + `HOSTED_ZONE_NAME` set emits a template with an additional `AWS::CertificateManager::Certificate` (DNS-validated) and `AWS::Route53::RecordSet` (A alias to the distribution).
- [ ] `packages/app/package.json` no longer contains `deploy:web` script or `wrangler` devDep.
- [ ] Root `package.json` `workspaces` array includes `packages/infra-web`.
- [ ] `knip.json` has a workspace entry for `packages/infra-web` and no longer lists `wrangler` in `ignoreBinaries`.
- [ ] `.github/workflows/deploy-app.yml` is replaced wholesale; two jobs (`deploy-web`, `package-infra-web`); both authenticate via OIDC; no `CLOUDFLARE_*` references in this file.
- [ ] `FORK-NOTES.md` has a "Cloud-mode additions (web SPA deployment)" section documenting all of the above.
- [ ] IAM role `gh-actions-paseo-fork-deploy-web` exists in account `437906455141`, scoped to the SPA stack.
- [ ] IAM role `gh-actions-paseo-fork-infra-web-publisher` exists in the nuvo-ai account, scoped to `s3:PutObject` on the `infra-web-static/` prefix of `orchestra-internal-packages`, with a deny-overwrite guard.
- [ ] GH Actions variable `NUVO_AI_ACCOUNT_ID` is set.
- [ ] GH Actions secret `CLOUDFLARE_API_TOKEN` is deleted (or scheduled for deletion after `deploy-website.yml` is audited).
- [ ] First post-merge release tag drives both jobs to green. `deploy-web` produces a working CloudFront URL serving the SPA; `package-infra-web` produces `s3://orchestra-internal-packages/infra-web-static/<version>.tgz` whose tarball, when extracted, exposes `dist/lib/static-spa-site.js`.
- [ ] Re-running `package-infra-web` without bumping version fails (overwrite guard works).
- [ ] Cloudflare `paseo-app` Pages project is either deleted or has a documented owner/disposition in FORK-NOTES.md.

---

## 6. Open questions / risks

Items where the design doc is silent or where a judgment call is required. **Each item below is flagged for operator decision before T-9 acceptance** unless marked otherwise.

### Q-1 — CDK v2 version pin

The design doc names "AWS CDK v2 (`aws-cdk-lib`)" but does not pin a version. The fork has no existing CDK code, so there's no constraint from elsewhere in the repo. **Recommendation:** pin to the latest v2 minor at the time of T-1 (current is around `^2.170`). Flag if Orchestra's `packages/infra/` pins a different version — they MUST resolve to the same major.minor at minimum because they share the construct (Orchestra imports our compiled construct, which embeds peerDeps).

### Q-2 — ACM cert region for CloudFront

CloudFront requires the cert in `us-east-1`. The construct currently has the cert created in the same region as the stack — **wrong** if the stack is deployed outside `us-east-1`. Two fix options:

(a) Force the entire stack to `us-east-1` (cleanest, but the S3 bucket then lives in `us-east-1` which is fine for CF origins but may be undesirable for self-host operators who want region affinity for compliance reasons).

(b) Use a `crossRegionReferences: true` stack and a secondary stack in `us-east-1` for the cert. CDK supports this via `Stack` props; it adds a CloudFormation export/import dance.

**Recommendation:** for v0.1.0 of the construct, accept option (a) by documenting that `CDK_DEPLOY_REGION` should be `us-east-1` when `WEB_DOMAIN` is set; provide `WEB_CERT_ARN` as an escape hatch for operators who want a different stack region. Revisit if Orchestra's `web-stack.ts` needs a non-`us-east-1` posture. **Operator decision required.**

### Q-3 — Is "nuvo-ai" the same as the existing fork test account?

The existing daemon ECR workflow uses account `437906455141` labelled "Nuvo dev account". The design doc says the tarball lives in the "nuvo-ai" account. **Are these the same account, or different?** If same, the cross-account assume is unnecessary and the `package-infra-web` job can use the existing `gh-actions-paseo-fork` role (after a policy extension). If different, the new role + cross-account OIDC trust in § 3.2 is required. **Operator clarification required before T-7.**

### Q-4 — Region for the internal-packages bucket

`s3:cp` works cross-region transparently, but the IAM role's `aws-region` arg in `configure-aws-credentials@v4` is set to `ap-southeast-2` in the sketch above. If `orchestra-internal-packages` is in `us-east-1`, this still works (S3 is global from an IAM/STS standpoint; bucket region only matters for data plane). **Recommendation:** set `aws-region` to the bucket's actual region for clarity. **Operator confirmation required.**

### Q-5 — Overwrite-guard mechanism

The proposed `s3:If-None-Match: *` IAM condition is the AWS-recommended way to enforce immutable tarball uploads. **However**, I have not verified that `aws s3 cp` (the high-level CLI) injects the `If-None-Match` header by default — it may not, in which case the IAM `Null` condition fires for every upload and nothing ever succeeds. Two mitigations:

(a) Switch the workflow to `aws s3api put-object --if-none-match '*'` (low-level API; the header is explicit).

(b) Keep `aws s3 cp` and verify the IAM condition empirically; relax to a list-based check (list the prefix, refuse to upload if the key exists) if the IAM approach is fragile.

**Recommendation:** use option (a) in the workflow — explicit beats implicit, and the low-level API call is one line. Flag for review.

### Q-6 — Construct unit tests

The plan does not specify CDK construct unit tests. The CDK community pattern is snapshot tests via `aws-cdk-lib/assertions` (`Template.fromStack(stack).hasResourceProperties(...)`). **Recommendation:** add one snapshot test in T-2 that pins the cache behaviors, the 403/404 routing rules, and the BlockPublicAccess setting. Adds ~½ day to T-2. **Operator decision required** — accept the snapshot test, defer it, or skip it.

### Q-7 — Source map / `source-map-support` dependency

`bin/web-deploy.ts` imports `source-map-support/register`. That package needs to be in `dependencies` (not `devDependencies`) since `bin/` is invoked at runtime by self-host operators after install. **Add `"source-map-support": "^0.5.21"` to `dependencies`** (omitted from the sketch above for brevity).

### Q-8 — Where does `bin/web-deploy.ts` get its `dist/` path when run from a tarball-installed package?

When Orchestra installs the tarball into `node_modules/@orchestra/infra-web-static`, the `__dirname` of the compiled `bin/web-deploy.js` is `node_modules/@orchestra/infra-web-static/dist/bin`. The fallback `path.resolve(__dirname, "../../app/dist")` reaches `node_modules/@orchestra/infra-web-static/dist/app/dist`, which does **not** exist. Orchestra is expected to set `SPA_DIST_PATH` explicitly (per design doc § "Orchestra-side wiring") so the fallback is only used in fork-internal contexts. **No action required in this plan** — flagged so the sibling planning agent for `orchestra-cloud-private` confirms the env var is always set.

### Q-9 — Workflow file rename?

The existing filename `deploy-app.yml` matches its old purpose (deploy app to Cloudflare). The new workflow does more (deploy SPA + package the construct). A rename to `deploy-app-and-publish-infra-web.yml` would be more accurate but breaks Git history continuity for the workflow. **Recommendation:** keep the existing filename to preserve `git log -p` continuity; the workflow's `name:` field already says "Deploy App" and the jobs inside it self-document. **Default to no rename unless operator overrides.**

### Q-10 — The `app-v*` tag pattern triggers both `deploy-app.yml` and `deploy-relay.yml`?

The trigger pattern `v*` is shared by several workflows in `.github/workflows/`. `deploy-app.yml` filters out beta. Verify that `app-v*`-tagged releases do not over-trigger `deploy-relay.yml` etc. **Recommendation:** check the other workflow trigger blocks at T-5 time; if any cross-fires, narrow the trigger to a tag pattern specific to the SPA (`app-v*` only, drop `v*`). **Operator decision required if cross-fire is found.**

### Q-11 — `cdk bootstrap` in the fork test account

CDK requires a one-time `cdk bootstrap` per account+region pair to create the CDK assets bucket and toolkit role. **Verify whether `437906455141`/`ap-southeast-2` is already bootstrapped.** If not, run `cdk bootstrap aws://437906455141/ap-southeast-2 --trust <github-oidc-role-arn> --trust-for-lookup <same>` once as an operator before T-9. **Pre-acceptance operator action.**

### Q-12 — Versioning of the construct package

`packages/infra-web/package.json` starts at `0.1.0`. The plan does not specify how it is bumped. Options:

(a) Manual bump as part of each release-tag PR (low ceremony, high discipline cost).

(b) Tie to the root `package.json` version (the existing `npm run version:sync-internal` script syncs workspace versions — verify whether it walks all workspaces or only the published-to-npm ones; if the latter, infra-web needs explicit addition).

(c) Independent semver (recommended for libraries; the construct is a library consumed by Orchestra).

**Recommendation:** option (c) — bump manually, document in FORK-NOTES.md. The construct's API surface changes infrequently, so manual bumps are cheap. **Operator decision required.**

### R-1 — Failing CI on the first release tag merge

If T-7 (IAM) is not complete when the first release tag lands, both workflow jobs will fail at the `configure-aws-credentials` step. This is non-destructive (no partial deploys, no orphaned resources) but visible. **Mitigation:** land T-7 in nuvo-ai BEFORE landing T-5 (workflow file). Order matters.

### R-2 — Orchestra-side coupling drift

The fork's `lib/static-spa-site.ts` is the single source of truth for the construct API. If Orchestra wraps it with their own `web-stack.ts` and the fork later renames a prop (e.g., `hostedZone` → `zone`), Orchestra silently breaks. **Mitigation:** the construct's `StaticSpaSiteProps` interface is the contract; treat it as semver. Bump the construct's `version` major on breaking changes. Document in `packages/infra-web/README.md`.

### R-3 — Expo `_expo/` asset path assumption

The design doc says hashed assets live under `_expo/`. Expo's `expo export --platform web` actually emits to `_expo/static/js/web/` and `_expo/static/css/` plus an `assets/` directory for fonts/images. The construct's `_expo/*` + `assets/*` cache behaviors cover both. **Verify empirically during T-9 — list bucket contents after the first deploy** and confirm the cache-behavior wildcards line up with the actual paths. If Expo emits assets under a different prefix in a future major (Expo 55+), the construct's cache behaviors need updating.

### R-4 — `BucketDeployment` Lambda runtime limits

`s3Deployment.BucketDeployment` uses an internal Lambda to copy assets from the CDK staging bucket to the destination bucket. The Lambda has a 15-minute timeout. For an Expo web bundle the asset count is small (~hundreds of files, <50 MB total typical), so this is unlikely to bite. Flag for monitoring if the SPA grows substantially.

---

## Cross-references

- Design doc: `paseo-cloud-daemon/90-cloud-considerations/web-spa-deployment.md` — operator-committed; rereading is unnecessary for execution.
- Existing OIDC pattern: `.github/workflows/build-and-publish-daemon.yml` — the daemon ECR push job; reuses the `gh-actions-paseo-fork` role pattern.
- Cloud-mode rules: `FORK-NOTES.md` (this repo) — the divergence is a "Cloud-mode addition", not a refactor of existing on-host paths.
- `paseo-cloud-daemon/90-cloud-considerations/repo-topology.md` § (3) — conflict policy for cross-fork merges; `packages/infra-web/` is "ours-only" / "ours wins".
- `D-3-plans/PLAN-daemon.md` — format reference for the plan; same numbered-task + acceptance-criteria style.
