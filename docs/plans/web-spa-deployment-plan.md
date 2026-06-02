# Web SPA deployment — fork-side implementation plan

Scope: AGPL fork (`Nuvo-Software-Pty-Ltd/paseo`, branch `plan-web-spa-deployment`). The fork-side work to replace the upstream Cloudflare Pages deploy of the Expo SPA with an AWS-native S3 + CloudFront pipeline backed by a reusable CDK construct (`StaticSpaSite`), distributed to the proprietary Orchestra monorepo via a tarball-in-S3 mechanism.

Design source of truth: [`paseo-cloud-daemon/90-cloud-considerations/web-spa-deployment.md`](../../../../Documents/paseo-cloud-daemon/90-cloud-considerations/web-spa-deployment.md) (operator-committed). This plan does **not** re-derive design choices; it specifies how to land them.

Out of scope (covered by a sibling planning agent against `orchestra-cloud-private`): `packages/infra/lib/web-stack.ts`, the vendoring CI step (`aws s3 cp ... vendor/`), and the helper `npm run fetch:vendored-packages`. Cross-references in this plan name the Orchestra-side dependency where it touches the fork's deliverable but do not specify the Orchestra-side implementation.

## Day-1 scope: dev environment only

Day-1 deploys **only the dev SPA** at `dev.app.orchestra.nuvo.software`. The production domain `app.orchestra.nuvo.software` is **out of scope** for Day-1 — it will be wired up by a future change against `orchestra-cloud-private/packages/infra/lib/web-stack.ts`. The fork's `deploy-web` CI job is the canonical writer of the dev SPA: it deploys the construct to nuvo-ai on every release tag, producing a live, user-facing dev environment (not merely a "construct-exercise" smoke deploy as earlier drafts of this plan implied).

Both CI jobs (`deploy-web` and `package-infra-web`) run against the **single nuvo-ai AWS account, `437906455141`, in `ap-southeast-2`** — the same account the daemon ECR push (`build-and-publish-daemon.yml`) targets today. The earlier "fork-owned test account" framing is dropped; there is no separate test account.

## Why this file is not under `D-N-plans/`

The repo's existing plan convention is `D-N-plans/PLAN-{stream}.md`, where `D-N` is a roadmap phase from `paseo-cloud-daemon/IMPLEMENTATION-ROADMAP.md`. Web SPA deployment is not a roadmap phase — it is a one-shot fork divergence (single PR per design doc § "Cutover"). Filing it under a new `D-X-plans/` would collide with the phase-numbered convention. Filing under `docs/plans/` parallels how `docs/` already hosts long-lived system docs and matches the design doc's posture: this is operational infrastructure, not feature-roadmap work. The folder is new; one file lives in it today.

---

## Stream summary

This plan owns:

1. **New `packages/infra-web/` package** — CDK v2 reusable construct (`lib/static-spa-site.ts`) + runnable CDK app (`bin/web-deploy.ts`) + package metadata + README.
2. **Workflow replacement** — `.github/workflows/deploy-app.yml` replaced wholesale; two jobs, both in the nuvo-ai account (`437906455141`, `ap-southeast-2`): `deploy-web` deploys the dev SPA to `dev.app.orchestra.nuvo.software`; `package-infra-web` publishes the construct tarball to `s3://orchestra-internal-packages/infra-web-static/`.
3. **Cleanup of upstream Cloudflare config in the fork** — `wrangler` devDep + `deploy:web` script removed from `packages/app/package.json`; `wrangler` removed from `knip.json` `ignoreBinaries`; secrets removed from GH Actions.
4. **Workspace plumbing** — root `package.json` workspace addition; `knip.json` workspace entry; lefthook ergonomics; release scripts updated for the new workspace.
5. **FORK-NOTES.md divergence entry** — under a new "Cloud-mode additions (web SPA deployment)" section.
6. **IAM / OIDC** — reuses the existing GH OIDC trust in nuvo-ai (`437906455141`). Two new IAM roles in that single account: `gh-actions-paseo-fork-deploy-web` (CDK deploy of `StaticSpaSite`) and `gh-actions-paseo-fork-infra-web-publisher` (least-privilege `s3:PutObject` on the `infra-web-static/` key prefix only, with deny-overwrite).

This plan does **not** own:

- `packages/infra/lib/web-stack.ts` in `orchestra-cloud-private` — sibling planning agent.
- The production `app.orchestra.nuvo.software` SPA — Day-N, out of scope.
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
    "constructs": "^10.4.0",
    "source-map-support": "^0.5.21"
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
- **CDK version coordination (manual, pre-T-1):** `aws-cdk-lib` MUST match the pin in `orchestra-cloud-private/packages/infra/package.json`. They share a compiled construct that embeds peerDeps; mismatched majors will fail Orchestra's `cdk synth`. Before starting T-1, read `orchestra-cloud-private/packages/infra/package.json` and copy the exact `aws-cdk-lib` and `constructs` ranges into this package. The `^2.170.0`/`^10.4.0` values above are placeholders; replace them with the orchestra-cloud-private values at T-1 time. If `orchestra-cloud-private` has no CDK code yet, pin to the latest v2 minor and tell the sibling agent the chosen pin.
- `source-map-support` is a runtime dependency (not devDep): `bin/web-deploy.ts` imports `source-map-support/register` and is invoked by self-host operators after install, when devDeps are not present.
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
    //    Must be in us-east-1; CDK's `acm.Certificate` honors the stack region.
    //    Resolution: bin/web-deploy.ts forces CDK_DEPLOY_REGION=us-east-1 whenever WEB_DOMAIN is set,
    //    so a hostedZone+domainName invocation always creates the cert in us-east-1. The S3 bucket
    //    and CloudFront origin live in the same stack (us-east-1) under this constraint. Operators
    //    who need a different region for the bucket must supply WEB_CERT_ARN explicitly and deploy
    //    the cert out-of-band.
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
const requestedRegion = requireEnv("CDK_DEPLOY_REGION");
const domainName = process.env.WEB_DOMAIN;

// CloudFront requires its certificate in us-east-1. When WEB_DOMAIN is set the construct creates
// the cert in the same region as the stack — so the stack MUST be us-east-1 in that branch.
// If the operator supplies a different region together with WEB_DOMAIN, hard-fail with a clear
// message rather than silently relocating their stack. Operators who need a non-us-east-1 region
// for the bucket can pass WEB_CERT_ARN (a pre-created us-east-1 cert) to opt out of this constraint.
if (domainName && !process.env.WEB_CERT_ARN && requestedRegion !== "us-east-1") {
  throw new Error(
    `WEB_DOMAIN is set but CDK_DEPLOY_REGION="${requestedRegion}". When a domain is supplied without WEB_CERT_ARN, the stack must deploy to us-east-1 so the auto-created ACM cert is in the CloudFront-required region. Set CDK_DEPLOY_REGION=us-east-1, or supply WEB_CERT_ARN pointing at a pre-existing us-east-1 cert.`,
  );
}
const region = requestedRegion;

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
  domainName,
  hostedZoneId: process.env.HOSTED_ZONE_ID,
  hostedZoneName: process.env.HOSTED_ZONE_NAME,
  certificateArn: process.env.WEB_CERT_ARN,
  priceClass,
});
```

Env-var contract (this is the documented surface for self-host operators and Orchestra):

| Env var                               | Required                                                                      | Used by                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `CDK_DEPLOY_ACCOUNT`                  | yes                                                                           | CDK env binding                                                                      |
| `CDK_DEPLOY_REGION`                   | yes (must be `us-east-1` whenever `WEB_DOMAIN` is set without `WEB_CERT_ARN`) | CDK env binding                                                                      |
| `SPA_DIST_PATH`                       | optional (defaults to `../app/dist`)                                          | construct `sourcePath`                                                               |
| `WEB_DOMAIN`                          | optional                                                                      | construct `domainName`                                                               |
| `HOSTED_ZONE_ID` + `HOSTED_ZONE_NAME` | optional (both required together)                                             | construct `hostedZone`                                                               |
| `WEB_CERT_ARN`                        | optional                                                                      | construct `certificate` (skips auto-create; also relaxes the us-east-1 region check) |
| `WEB_PRICE_CLASS`                     | optional, one of `PRICE_CLASS_ALL`/`PRICE_CLASS_100`/`PRICE_CLASS_200`        | construct `priceClass`                                                               |
| `WEB_STACK_NAME`                      | optional (defaults to `PaseoWebSpa`)                                          | CloudFormation stack name                                                            |

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
# Both jobs run in the single nuvo-ai account (437906455141, ap-southeast-2).
#
# Two jobs:
#  - deploy-web:        builds the SPA, runs `cdk deploy` to host dev.app.orchestra.nuvo.software.
#                       This is the Day-1 user-facing dev environment (NOT just a smoke deploy).
#                       The stack is forced to us-east-1 because WEB_DOMAIN is set (CloudFront cert
#                       must live in us-east-1; the construct auto-creates the cert in the stack region).
#  - package-infra-web: `npm pack` the construct, then `aws s3api put-object --if-none-match '*'`
#                       to the internal-packages bucket. Orchestra's CI vendors the tarball.
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
  AWS_ACCOUNT_ID: "437906455141" # nuvo-ai — the same account daemon ECR uses
  AWS_REGION_BUCKET: ap-southeast-2 # region for orchestra-internal-packages (matches daemon ECR region)
  AWS_REGION_STACK: us-east-1 # forced for the SPA stack because WEB_DOMAIN is set (CF cert constraint)
  OIDC_ROLE_ARN_DEPLOY_WEB: arn:aws:iam::437906455141:role/gh-actions-paseo-fork-deploy-web
  OIDC_ROLE_ARN_PACKAGE_PUBLISH: arn:aws:iam::437906455141:role/gh-actions-paseo-fork-infra-web-publisher
  INFRA_WEB_PACKAGE_BUCKET: orchestra-internal-packages
  INFRA_WEB_PACKAGE_PREFIX: infra-web-static
  WEB_DOMAIN_DEV: dev.app.orchestra.nuvo.software
  HOSTED_ZONE_NAME: orchestra.nuvo.software
  # HOSTED_ZONE_ID is read from a GH Actions variable so the workflow stays portable across forks.
  # See § 3 — set vars.ORCHESTRA_HOSTED_ZONE_ID to the existing zone's ID in nuvo-ai.

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

      - name: Configure AWS credentials (OIDC, nuvo-ai)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ env.OIDC_ROLE_ARN_DEPLOY_WEB }}
          aws-region: ${{ env.AWS_REGION_STACK }}

      - name: CDK deploy (nuvo-ai, dev domain)
        working-directory: packages/infra-web
        env:
          CDK_DEPLOY_ACCOUNT: ${{ env.AWS_ACCOUNT_ID }}
          CDK_DEPLOY_REGION: ${{ env.AWS_REGION_STACK }}
          SPA_DIST_PATH: ${{ github.workspace }}/packages/app/dist
          WEB_STACK_NAME: PaseoWebSpaDev
          WEB_DOMAIN: ${{ env.WEB_DOMAIN_DEV }}
          HOSTED_ZONE_ID: ${{ vars.ORCHESTRA_HOSTED_ZONE_ID }}
          HOSTED_ZONE_NAME: ${{ env.HOSTED_ZONE_NAME }}
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

      - name: Configure AWS credentials (OIDC, nuvo-ai)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ env.OIDC_ROLE_ARN_PACKAGE_PUBLISH }}
          aws-region: ${{ env.AWS_REGION_BUCKET }}

      - name: Upload tarball to internal-packages bucket (immutable; refuses overwrite)
        env:
          VERSION: ${{ steps.pkg.outputs.version }}
          TARBALL: ${{ steps.pack.outputs.tarball }}
        run: |
          # `aws s3api put-object --if-none-match '*'` is the explicit form. The IAM policy on the
          # role pairs with this: it denies s3:PutObject when the If-None-Match header is absent.
          # If `packages/infra-web/package.json` `version` was not bumped, this call fails with a
          # 412 Precondition Failed and the workflow stops.
          aws s3api put-object \
            --bucket "${INFRA_WEB_PACKAGE_BUCKET}" \
            --key "${INFRA_WEB_PACKAGE_PREFIX}/${VERSION}.tgz" \
            --body "$TARBALL" \
            --if-none-match '*' \
            --server-side-encryption AES256 \
            --content-type application/gzip

      - name: Confirmation
        env:
          VERSION: ${{ steps.pkg.outputs.version }}
        run: |
          echo "Published infra-web tarball version ${VERSION} to s3://${INFRA_WEB_PACKAGE_BUCKET}/${INFRA_WEB_PACKAGE_PREFIX}/${VERSION}.tgz"
```

Notes:

- The two jobs are independent — they can run in parallel.
- `deploy-web` sets `WEB_DOMAIN=dev.app.orchestra.nuvo.software`. The construct creates an ACM cert (DNS-validated against `orchestra.nuvo.software`) and a Route53 A-alias under that zone. CloudFront serves the dev SPA at the dev subdomain.
- The version-overwrite guard is **explicit**: the workflow calls `aws s3api put-object --if-none-match '*'`. S3 returns `412 Precondition Failed` if the object already exists. The IAM role's deny statement enforces that this header is always present (so an alternate caller cannot bypass the guard).

### EDITED: `FORK-NOTES.md`

Add a new section before "What we did NOT change":

```markdown
## Cloud-mode additions (web SPA deployment)

The Expo web SPA (`packages/app`) is deployed via AWS S3 + CloudFront in the fork — upstream's Cloudflare Pages deploy was never wired into live traffic and is currently failing. Design: `paseo-cloud-daemon/90-cloud-considerations/web-spa-deployment.md`. Fork-side implementation plan: `docs/plans/web-spa-deployment-plan.md`.

### Files present only in the fork

- `packages/infra-web/` — new package containing the reusable `StaticSpaSite` CDK v2 construct (`lib/static-spa-site.ts`) and the runnable CDK app (`bin/web-deploy.ts`). Marked `"private": true`. Distributed via `npm pack` + S3 tarball (see below), never published to npm.
- `docs/plans/web-spa-deployment-plan.md` — implementation plan for the divergence.

### Files modified in the fork

- `.github/workflows/deploy-app.yml` — replaces upstream's Cloudflare Pages deploy with two AWS-native jobs, both in the nuvo-ai account (`437906455141`, `ap-southeast-2`):
  - `deploy-web` — runs `cdk deploy bin/web-deploy.ts` on every release tag to host the **Day-1 dev SPA at `dev.app.orchestra.nuvo.software`**. The stack is forced to `us-east-1` because the ACM cert must live there (CloudFront constraint). Production `app.orchestra.nuvo.software` is Day-N, out of scope.
  - `package-infra-web` — `npm pack`s the construct and uploads the tarball via `aws s3api put-object --if-none-match '*'` to `s3://orchestra-internal-packages/infra-web-static/<version>.tgz`. Immutable: re-uploads of the same version fail with 412. Orchestra's CI vendors the tarball pre-`npm install`.
- `packages/app/package.json` — `deploy:web` script removed; `wrangler` devDep removed.
- `package.json` (root) — workspace list includes `packages/infra-web`.
- `knip.json` — workspace entry for `packages/infra-web`; `wrangler` removed from `ignoreBinaries`; `cdk` added.

### Secrets / variables removed

- GH Actions secret `CLOUDFLARE_API_TOKEN` — drop after the workflow merges. (`packages/website/`'s deploy still uses `CLOUDFLARE_API_TOKEN`; leave the secret alone if `deploy-website.yml` still references it. As of this fork the marketing site stays on Cloudflare Workers per the design doc § "Out of scope".)
- GH Actions inline env `CLOUDFLARE_ACCOUNT_ID` — removed at the same time as `CLOUDFLARE_API_TOKEN`'s deploy-app usage.

### Cloudflare project decommissioning

The `paseo-app` Cloudflare Pages project consumes a slot in the CF account but takes no traffic. Delete at convenience; no rush. Document the deletion in this section once done.

### Construct version bumps

`packages/infra-web/package.json` `version` bumps are **manual** and independent of the root repo version. Bump on every PR that changes the construct's public API (`StaticSpaSiteProps`) or its CFN output (any change that materially alters the generated template). Patch for cosmetic; minor for additive; major for breaking. Orchestra's `file:` dependency on the tarball pins the consumed version exactly — a missed bump means Orchestra never pulls the change (or, worse, hits the 412 overwrite guard if the version is reused).

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

### T-2 — Implement `lib/static-spa-site.ts` + snapshot test

Write the construct per the sketch in § 1. Include the `// TODO(security-headers):` comment. Verify `npm run typecheck --workspace=@orchestra/infra-web-static` and `npm run build --workspace=@orchestra/infra-web-static` produce a clean `dist/` directory.

Add **one CDK snapshot test** at `packages/infra-web/lib/static-spa-site.test.ts` using `aws-cdk-lib/assertions`. Pin the load-bearing invariants:

- `BlockPublicAccess` is `BLOCK_ALL` on the bucket.
- `errorResponses` includes both 403→/index.html and 404→/index.html with `responseHttpStatus: 200`.
- `additionalBehaviors` includes both `_expo/*` and `assets/*` with `CACHING_OPTIMIZED`.
- `minimumProtocolVersion` is `TLSv1.2_2021`.
- Default behavior uses `CACHING_DISABLED`.

Wire vitest into `packages/infra-web/package.json` only if a `test` script is added; the construct test can run inline via `tsx --test` to avoid pulling vitest into a non-test workspace. Operator decision deferred to the implementer; the failure mode either way is "snapshot drift caught at PR review."

**Size:** M (snapshot test adds ~½ day).
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

- `deploy-web` produces CloudFormation stack `PaseoWebSpaDev` in `437906455141`/`us-east-1`, the bucket has the SPA artifacts, Route53 has the A-alias, and `https://dev.app.orchestra.nuvo.software/` serves the SPA.
- `package-infra-web` produces `s3://orchestra-internal-packages/infra-web-static/<version>.tgz` (whatever `packages/infra-web/package.json` `version` is at tag time).

**Size:** S.
**Depends on:** T-1–T-8 all landed; T-7 IAM in place; `cdk bootstrap` (§ 3.5) executed in nuvo-ai/us-east-1.

### Parallelism summary

- T-1, T-4, T-7, T-8 can run in parallel from day 1.
- T-2 unblocks once T-1 lands; T-3 unblocks once T-2 lands; T-5 unblocks once T-3 lands; T-6 unblocks once T-2/T-3/T-4 land.
- T-9 is the acceptance gate; it depends on everything.

A reasonable single-author sequencing is: (T-1 → T-2 → T-3) in series, with (T-4, T-7, T-8) interleaved opportunistically, finishing on T-5 → T-6 → T-9.

---

## 3. Infra / IAM setup tasks

All resources live in the single nuvo-ai account (`437906455141`). The GH OIDC provider already exists in this account (created for `build-and-publish-daemon.yml`'s `gh-actions-paseo-fork` role) — both new roles attach to the same provider; no new OIDC trust to create.

### 3.1 IAM role: `gh-actions-paseo-fork-deploy-web`

Used by the `deploy-web` job to `cdk deploy` the SPA stack to `us-east-1`.

- **Trust policy:** `token.actions.githubusercontent.com` with `sub` claim matched to `repo:Nuvo-Software-Pty-Ltd/paseo:ref:refs/tags/v*` and `repo:Nuvo-Software-Pty-Ltd/paseo:ref:refs/tags/app-v*` (mirrors the existing `gh-actions-paseo-fork` role's pattern). During development, also accept `repo:Nuvo-Software-Pty-Ltd/paseo:ref:refs/heads/plan-web-spa-deployment` so the workflow can be exercised with `workflow_dispatch` before any tag is cut.
- **Permissions:** minimum required for `cdk deploy` of `StaticSpaSite` with WEB_DOMAIN set:
  - `cloudformation:*` on stacks matching `PaseoWebSpaDev*` and `CDKToolkit*` (the bootstrap stack).
  - `s3:*` on `cdk-*-assets-437906455141-us-east-1` (CDK assets bucket — region matches stack region per § 3.5) and on buckets created by the stack (best expressed via tag-based conditions: CDK tags created buckets with `aws-cdk:auto-delete-objects` when applicable).
  - `cloudfront:*` on distributions (no resource-level ARN support for most CF actions; this is a known CDK pain).
  - `route53:ChangeResourceRecordSets`, `route53:GetChange`, `route53:ListHostedZonesByName` — scoped to the `orchestra.nuvo.software` hosted zone (resource ARN form: `arn:aws:route53:::hostedzone/<ZONE_ID>`).
  - `acm:RequestCertificate`, `acm:DescribeCertificate`, `acm:DeleteCertificate`, `acm:AddTagsToCertificate`, `acm:ListCertificates` — in `us-east-1` (the only region the construct creates certs in).
  - `iam:PassRole` only on roles tagged `aws-cdk:bootstrap-role` (CDK bootstrap pattern).
  - `lambda:*` + `iam:CreateRole`/`iam:AttachRolePolicy` for the `BucketDeployment` custom-resource Lambda (CDK creates these on first deploy).
  - `sts:GetCallerIdentity` (always).
- **Recommended scoping mechanism:** scope via `cdk bootstrap`'s `--trust` flag rather than hand-rolling the policy. The CDK bootstrap stack creates five typed roles (`deploy`, `lookup`, `file-publishing`, `image-publishing`, `cfn-exec`) and grants them on the assets bucket; the workflow's GH OIDC role merely needs `sts:AssumeRole` on the `deploy` role plus `iam:PassRole` on `cfn-exec`. See § 3.5 for the bootstrap command.

### 3.2 IAM role: `gh-actions-paseo-fork-infra-web-publisher`

Used by the `package-infra-web` job. Least-privilege: **`s3:PutObject` on `arn:aws:s3:::orchestra-internal-packages/infra-web-static/*` only**, with an immutable-upload guarantee.

- **Trust policy:** identical to § 3.1's tag-pattern trust.
- **Permissions policy:**
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
        "Sid": "DenyOverwriteWithoutIfNoneMatch",
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
  The deny statement requires every upload to carry an `If-None-Match` header; combined with the workflow's `aws s3api put-object --if-none-match '*'`, this means S3 returns `412 Precondition Failed` when the version already exists. No alternate caller (a one-off `aws s3 cp` from an operator's laptop, for example) can bypass the guard via this role.
- **Bucket policy on `orchestra-internal-packages`:** since the bucket and role live in the same account, the IAM allow is sufficient by default — no bucket-policy edit is required unless the bucket has an explicit deny that excludes this principal. Verify the current bucket policy posture before T-9; add an allow only if a deny is in the way.

### 3.3 GH Actions repository variables / secrets

In `Nuvo-Software-Pty-Ltd/paseo` repo settings:

- **Add variable** `ORCHESTRA_HOSTED_ZONE_ID` = `<the existing zone ID for orchestra.nuvo.software>` — used by `deploy-web` to pass `HOSTED_ZONE_ID` to the CDK app. Variable (not secret) — zone IDs are not sensitive.
- **No** `NUVO_AI_ACCOUNT_ID` variable needed (single account is hardcoded to `437906455141` in the workflow `env:` block).
- **Remove secret** `CLOUDFLARE_API_TOKEN` only after `deploy-website.yml` is audited — if it still references the secret, leave it (the marketing site stays on Cloudflare per design doc § "Out of scope").
- The `CLOUDFLARE_ACCOUNT_ID` value was inlined in the workflow, not stored as a secret; deletion is mechanical.

### 3.4 S3 bucket sanity check

`orchestra-internal-packages` exists in nuvo-ai per design doc § "Distribution mechanism". Before T-9, verify:

- Bucket region: the workflow's `aws-region` is set to `ap-southeast-2` (the value used in § 3.1). `aws s3api put-object` works across-region transparently, but matching the region avoids cross-region request latency. If the bucket is actually in a different region, set `AWS_REGION_BUCKET` in the workflow `env:` block to match.
- Versioning enabled (recommended; not required for correctness — the IAM deny-overwrite is the primary guard).
- `BlockPublicAccess: BLOCK_ALL`.

### 3.5 `cdk bootstrap` in nuvo-ai/us-east-1 (pre-acceptance)

CDK requires a one-time `cdk bootstrap` per `account+region` pair to create the assets bucket and the five typed bootstrap roles. The SPA stack deploys to `us-east-1`, so that region must be bootstrapped in nuvo-ai. **This is a pre-T-9 operator action.**

Run once, from an operator's machine with admin credentials in nuvo-ai:

```bash
npx cdk@^2.170 bootstrap aws://437906455141/us-east-1 \
  --trust arn:aws:iam::437906455141:role/gh-actions-paseo-fork-deploy-web \
  --trust-for-lookup arn:aws:iam::437906455141:role/gh-actions-paseo-fork-deploy-web \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
```

The `cfn-exec` policy is the standard CDK bootstrap default; tighten if/when nuvo-ai's security posture requires it.

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
   - `deploy-web` should complete in ~10–15 minutes (CDK deploy + ACM cert DNS validation on first run; subsequent runs ~5 min).
   - `package-infra-web` should complete in ~1–2 minutes.
3. Verify `deploy-web` outputs in the AWS Console:
   - CloudFormation stack `PaseoWebSpaDev` is `UPDATE_COMPLETE` (or `CREATE_COMPLETE` on first run) in `us-east-1`.
   - The S3 bucket contains `index.html`, `_expo/static/js/web/<hash>.js`, etc.
   - A Route53 A-alias for `dev.app.orchestra.nuvo.software` points at the CloudFront distribution.
   - `curl -sI https://dev.app.orchestra.nuvo.software/` returns `200` with `Content-Type: text/html`.
   - `curl -sI https://dev.app.orchestra.nuvo.software/some-nonexistent-route` returns `200` (SPA routing).
   - `curl -sI https://dev.app.orchestra.nuvo.software/_expo/static/js/web/<hash>.js` returns a `Cache-Control: public, max-age=...` header consistent with `CACHING_OPTIMIZED`.
4. Verify `package-infra-web` outputs:
   - `aws s3 ls s3://orchestra-internal-packages/infra-web-static/` shows `<version>.tgz` with the expected version.
   - `aws s3 cp s3://orchestra-internal-packages/infra-web-static/<version>.tgz - | tar -tzf - | head` reveals `package/dist/lib/static-spa-site.js`, `package/dist/lib/static-spa-site.d.ts`, `package/package.json`.

### 4.4 Overwrite-guard verification

Re-run `package-infra-web` without bumping `packages/infra-web/package.json` `version`:

- Expected: the `aws s3api put-object --if-none-match '*'` step fails with `412 Precondition Failed`. The role's deny-without-If-None-Match guarantees no alternate caller can bypass.
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
- [ ] `npx cdk synth` with `WEB_DOMAIN` + `HOSTED_ZONE_ID` + `HOSTED_ZONE_NAME` set (and `CDK_DEPLOY_REGION=us-east-1`) emits a template with an additional `AWS::CertificateManager::Certificate` (DNS-validated) and `AWS::Route53::RecordSet` (A alias to the distribution).
- [ ] `npx cdk synth` with `WEB_DOMAIN` set but `CDK_DEPLOY_REGION` ≠ `us-east-1` (and no `WEB_CERT_ARN`) **fails fast** with the documented error message.
- [ ] CDK snapshot test in `lib/static-spa-site.test.ts` passes and pins: BlockPublicAccess BLOCK_ALL, both 403/404 → /index.html error responses, `_expo/*` + `assets/*` cache behaviors with CACHING_OPTIMIZED, TLS 1.2+, default behavior CACHING_DISABLED.
- [ ] `packages/app/package.json` no longer contains `deploy:web` script or `wrangler` devDep.
- [ ] Root `package.json` `workspaces` array includes `packages/infra-web`.
- [ ] `knip.json` has a workspace entry for `packages/infra-web` and no longer lists `wrangler` in `ignoreBinaries`.
- [ ] `.github/workflows/deploy-app.yml` is replaced wholesale; two jobs (`deploy-web`, `package-infra-web`); both authenticate via OIDC into the same account (`437906455141`); no `CLOUDFLARE_*` references in this file.
- [ ] `FORK-NOTES.md` has a "Cloud-mode additions (web SPA deployment)" section documenting all of the above.
- [ ] IAM role `gh-actions-paseo-fork-deploy-web` exists in account `437906455141`, scoped to the SPA stack.
- [ ] IAM role `gh-actions-paseo-fork-infra-web-publisher` exists in account `437906455141`, scoped to `s3:PutObject` on the `infra-web-static/` prefix of `orchestra-internal-packages`, with a deny-without-If-None-Match guard.
- [ ] GH Actions variable `ORCHESTRA_HOSTED_ZONE_ID` is set to the existing `orchestra.nuvo.software` zone ID.
- [ ] GH Actions secret `CLOUDFLARE_API_TOKEN` is deleted (or scheduled for deletion after `deploy-website.yml` is audited).
- [ ] `cdk bootstrap aws://437906455141/us-east-1` has been executed (§ 3.5).
- [ ] First post-merge release tag drives both jobs to green. `deploy-web` produces a working SPA at `https://dev.app.orchestra.nuvo.software/`; `package-infra-web` produces `s3://orchestra-internal-packages/infra-web-static/<version>.tgz` whose tarball, when extracted, exposes `dist/lib/static-spa-site.js`.
- [ ] Re-running `package-infra-web` without bumping version fails with `412 Precondition Failed` (overwrite guard works).
- [ ] `aws-cdk-lib` pin in `packages/infra-web/package.json` matches `orchestra-cloud-private/packages/infra/package.json` (manual coordination check; sibling planning agent's responsibility to honor).
- [ ] Cloudflare `paseo-app` Pages project is either deleted or has a documented owner/disposition in FORK-NOTES.md.

---

## 6. Open questions / risks

Operator resolutions from the cross-plan tension review (see § "Operator resolutions" below) closed Q-1…Q-12; the corresponding decisions are folded into the body of this plan. Items that remain genuinely open after those resolutions:

### Open — O-1: `app-v*` tag-pattern cross-fire with other workflows

The trigger patterns `v*` and `app-v*` are shared by several workflows in `.github/workflows/` (`deploy-relay.yml`, `desktop-release.yml`, `desktop-rollout.yml`, `release-notes-sync.yml`). Verify at T-5 time that an `app-v*` tag does not over-trigger them. If any cross-fires, narrow `deploy-app.yml`'s trigger to `app-v*` only (drop `v*`); leave the other workflows alone. **Operator confirmation at T-5.**

### Open — O-2: Orchestra-side `aws-cdk-lib` pin discovery

The CDK version coordination requirement (see § "NEW: `packages/infra-web/package.json`") asks the implementer to read the Orchestra pin manually. If `orchestra-cloud-private/packages/infra/package.json` does not exist yet (sibling planning agent has not landed it), the implementer must choose a pin and tell the sibling agent. **Action at T-1.**

### Operator resolutions (closed)

| Item                               | Resolution                                                                                                                                                                         | Folded into                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Q-1 — CDK version pin**          | Manual coordination; match `orchestra-cloud-private/packages/infra/package.json` at T-1.                                                                                           | § "NEW: `packages/infra-web/package.json`" key-points block.                                                     |
| **Q-2 — ACM cert region**          | Force stack to `us-east-1` when `WEB_DOMAIN` is set without `WEB_CERT_ARN`. `bin/web-deploy.ts` hard-fails otherwise.                                                              | `lib/static-spa-site.ts` cert block comment; `bin/web-deploy.ts` region-validation sketch; env-var contract row. |
| **Q-3 — "nuvo-ai" identity**       | nuvo-ai IS `437906455141`. Single-account setup; no cross-account assume.                                                                                                          | § "Day-1 scope: dev environment only"; § 3 IAM setup.                                                            |
| **Q-4 — Bucket region**            | Set `AWS_REGION_BUCKET=ap-southeast-2` in the workflow `env:` block to match the daemon ECR / nuvo-ai default. Operator verifies actual bucket region at T-7; adjust if different. | Workflow sketch `env:` block; § 3.4 bucket sanity check.                                                         |
| **Q-5 — Overwrite guard**          | Use `aws s3api put-object --if-none-match '*'` (explicit); IAM denies put without that header.                                                                                     | Workflow sketch (`Upload tarball` step); § 3.2 IAM policy DenyOverwriteWithoutIfNoneMatch sid.                   |
| **Q-6 — Construct unit tests**     | Add a single CDK snapshot test in T-2 pinning the load-bearing invariants.                                                                                                         | T-2 task body; acceptance checklist.                                                                             |
| **Q-7 — `source-map-support` dep** | Add to `dependencies` (not devDeps).                                                                                                                                               | `packages/infra-web/package.json` sketch.                                                                        |
| **Q-8 — Tarball `dist` path**      | Orchestra always sets `SPA_DIST_PATH`. Sibling planning agent confirms.                                                                                                            | Captured in `bin/web-deploy.ts` env-var contract.                                                                |
| **Q-9 — Workflow file rename**     | Keep `deploy-app.yml` filename for git-log continuity.                                                                                                                             | Workflow sketch retains filename.                                                                                |
| **Q-10 — Tag cross-fire**          | Reopened as **O-1** above — pending T-5 verification.                                                                                                                              | (See O-1.)                                                                                                       |
| **Q-11 — `cdk bootstrap`**         | Pre-T-9 operator action; bootstrap `aws://437906455141/us-east-1`.                                                                                                                 | § 3.5; T-9 dependency.                                                                                           |
| **Q-12 — Construct version bumps** | Manual semver bumps in `packages/infra-web/package.json`; document in FORK-NOTES.md.                                                                                               | FORK-NOTES sketch (add bumping note when this section lands).                                                    |

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
