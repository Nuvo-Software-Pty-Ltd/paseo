# Web SPA deployment — fork-side implementation plan

Scope: AGPL fork (`Nuvo-Software-Pty-Ltd/paseo`, branch `plan-web-spa-deployment`). The fork-side work to replace the upstream Cloudflare Pages deploy of the Expo SPA with an AWS-native S3 + CloudFront pipeline backed by a reusable CDK construct (`StaticSpaSite`), distributed to the proprietary Orchestra monorepo via a tarball-in-S3 mechanism.

Design source of truth: [`paseo-cloud-daemon/90-cloud-considerations/web-spa-deployment.md`](../../../../Documents/paseo-cloud-daemon/90-cloud-considerations/web-spa-deployment.md) (operator-committed). This plan does **not** re-derive design choices; it specifies how to land them.

Out of scope (covered by a sibling planning agent against `orchestra-cloud-private`): `packages/infra/lib/web-stack.ts`, the vendoring CI step (`aws s3 cp ... vendor/`), and the helper `npm run fetch:vendored-packages`. Cross-references in this plan name the Orchestra-side dependency where it touches the fork's deliverable but do not specify the Orchestra-side implementation.

## Day-1 scope

**The fork's CI publishes the construct tarball; it does NOT deploy the SPA.** Both the dev and prod SPA deploys are owned by `orchestra-cloud-private` — Orchestra's CI consumes the published tarball, wraps it in `packages/infra/lib/web-stack.ts`, and runs `cdk deploy`. The dev SPA at `dev.app.orchestra.nuvo.software` and the future prod SPA at `app.orchestra.nuvo.software` are both Orchestra-side concerns.

The fork's `bin/web-deploy.ts` runnable CDK app stays in the repo for **self-host operators** to run manually — `git clone <fork>` → `cd packages/infra-web` → `npx cdk deploy`. The fork's CI does **not** exercise it beyond `typecheck`/`build`. Drift in `bin/web-deploy.ts` is caught by, in order of likelihood: (a) the workspace typecheck at PR time, (b) Orchestra's CI breaking when the construct under it changes shape, (c) a self-host operator reporting a problem. Day-1 accepts this exposure for simplicity; revisit if any of the three signals proves slow.

The fork's CI runs against the **single nuvo-ai AWS account, `437906455141`, in `ap-southeast-2`** — the same account the daemon ECR push (`build-and-publish-daemon.yml`) targets today. The earlier "fork-owned test account" framing is dropped; there is no separate test account.

## Why this file is not under `D-N-plans/`

The repo's existing plan convention is `D-N-plans/PLAN-{stream}.md`, where `D-N` is a roadmap phase from `paseo-cloud-daemon/IMPLEMENTATION-ROADMAP.md`. Web SPA deployment is not a roadmap phase — it is a one-shot fork divergence (single PR per design doc § "Cutover"). Filing it under a new `D-X-plans/` would collide with the phase-numbered convention. Filing under `docs/plans/` parallels how `docs/` already hosts long-lived system docs and matches the design doc's posture: this is operational infrastructure, not feature-roadmap work. The folder is new; one file lives in it today.

---

## Stream summary

This plan owns:

1. **New `packages/infra-web/` package** — CDK v2 reusable construct (`lib/static-spa-site.ts`) + runnable CDK app (`bin/web-deploy.ts`, self-host-only) + package metadata + README.
2. **Workflow replacement** — `.github/workflows/deploy-app.yml` is **deleted**; a new single-job workflow `.github/workflows/publish-infra-web.yml` runs in nuvo-ai (`437906455141`, `ap-southeast-2`) to publish the construct tarball to `s3://orchestra-internal-packages/infra-web-static/`.
3. **Cleanup of upstream Cloudflare config in the fork** — `wrangler` devDep + `deploy:web` script removed from `packages/app/package.json`; `wrangler` removed from `knip.json` `ignoreBinaries`; secrets removed from GH Actions.
4. **Workspace plumbing** — root `package.json` workspace addition; `knip.json` workspace entry; lefthook ergonomics; release scripts updated for the new workspace.
5. **FORK-NOTES.md divergence entry** — under a new "Cloud-mode additions (web SPA deployment)" section.
6. **IAM / OIDC** — reuses the existing GH OIDC trust in nuvo-ai (`437906455141`). **One** new IAM role in that account: `gh-actions-paseo-fork-infra-web-publisher` (least-privilege `s3:PutObject` on the `infra-web-static/` key prefix only, with deny-overwrite).

This plan does **not** own:

- `packages/infra/lib/web-stack.ts` in `orchestra-cloud-private` — sibling planning agent.
- The dev SPA at `dev.app.orchestra.nuvo.software` and the future prod SPA at `app.orchestra.nuvo.software` — both are deployed by Orchestra's CI; out of scope here.
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

Runnable CDK app for **self-host operators only**. The fork's CI does NOT invoke this file beyond typecheck/build (see § "Day-1 scope"). Reads config from env per the design doc § "Self-host operator deploy path"; the same env-var contract applies if Orchestra ever wraps `bin/web-deploy.ts` directly (Orchestra is expected to use the construct via `web-stack.ts` instead).

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

### DELETED: `.github/workflows/deploy-app.yml`

The upstream Cloudflare-Pages workflow is removed in the same PR. There is no replacement-in-place — its functions are split: SPA deploys move to Orchestra's CI (out of scope here); the construct-tarball publish moves to a new workflow below.

### NEW: `.github/workflows/publish-infra-web.yml`

Single-job workflow. Builds the construct and publishes the tarball to S3. No SPA deploy, no CDK deploy. Runs in nuvo-ai (`437906455141`, `ap-southeast-2`).

```yaml
# Build the @orchestra/infra-web-static CDK construct and publish the tarball to
# s3://orchestra-internal-packages/infra-web-static/<version>.tgz so orchestra-cloud-private
# can vendor it pre-`npm install`.
#
# Single job — the fork does NOT deploy the SPA; Orchestra's CI does that, by consuming
# this tarball. The fork's `bin/web-deploy.ts` runnable CDK app stays in the repo for
# self-host operators to run manually; it is not exercised by this workflow beyond the
# typecheck on every PR (via lefthook + repo-root `npm run typecheck`).
#
# Auth: GitHub OIDC. The job assumes the `gh-actions-paseo-fork-infra-web-publisher`
# role by ARN. No long-lived AWS keys.

name: Publish infra-web tarball

on:
  push:
    tags:
      # Construct release cadence: only `app-v*` tags trigger a publish. Daemon-only releases
      # (`v*`) do not touch the SPA construct, so they don't fire this workflow — this also
      # avoids cross-fire with daemon/relay/desktop release workflows (closes O-1 from the
      # earlier draft).
      - "app-v*"
      - "!app-v*-beta.*"
  workflow_dispatch:

permissions:
  id-token: write # required for OIDC
  contents: read

env:
  AWS_REGION_BUCKET: ap-southeast-2 # region for orchestra-internal-packages (matches daemon ECR region)
  OIDC_ROLE_ARN: arn:aws:iam::437906455141:role/gh-actions-paseo-fork-infra-web-publisher
  INFRA_WEB_PACKAGE_BUCKET: orchestra-internal-packages
  INFRA_WEB_PACKAGE_PREFIX: infra-web-static

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Typecheck infra-web
        run: npm run typecheck --workspace=@orchestra/infra-web-static

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
          role-to-assume: ${{ env.OIDC_ROLE_ARN }}
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

- Trigger is restricted to `app-v*` (not `v*`); daemon-only releases don't touch the construct. This closes the cross-fire concern from the earlier draft.
- The version-overwrite guard is **explicit**: `aws s3api put-object --if-none-match '*'` returns `412 Precondition Failed` if the object exists. The IAM role's deny statement enforces the header is always present, so no alternate caller (a one-off `aws s3 cp` from a laptop) can bypass.

### EDITED: `FORK-NOTES.md`

Add a new section before "What we did NOT change":

```markdown
## Cloud-mode additions (web SPA deployment)

The Expo web SPA (`packages/app`) is deployed via AWS S3 + CloudFront in the fork — upstream's Cloudflare Pages deploy was never wired into live traffic and is currently failing. Design: `paseo-cloud-daemon/90-cloud-considerations/web-spa-deployment.md`. Fork-side implementation plan: `docs/plans/web-spa-deployment-plan.md`.

### Files present only in the fork

- `packages/infra-web/` — new package containing the reusable `StaticSpaSite` CDK v2 construct (`lib/static-spa-site.ts`) and the runnable CDK app (`bin/web-deploy.ts`). Marked `"private": true`. Distributed via `npm pack` + S3 tarball (see below), never published to npm.
- `docs/plans/web-spa-deployment-plan.md` — implementation plan for the divergence.

### Files modified in the fork

- `.github/workflows/deploy-app.yml` — **deleted**. The upstream Cloudflare Pages workflow has no successor in the fork's CI; SPA deploys are owned by `orchestra-cloud-private`.
- `.github/workflows/publish-infra-web.yml` — **new**. Single-job workflow in nuvo-ai (`437906455141`, `ap-southeast-2`): builds the construct, `npm pack`s, and uploads the tarball via `aws s3api put-object --if-none-match '*'` to `s3://orchestra-internal-packages/infra-web-static/<version>.tgz`. Immutable — re-uploads of the same version fail with 412. Triggered only on `app-v*` release tags. Orchestra's CI vendors the tarball pre-`npm install`.
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

`packages/infra-web/` and `.github/workflows/publish-infra-web.yml` are **fork-only**; upstream merges cannot resurrect them or delete them (per `paseo-cloud-daemon/90-cloud-considerations/repo-topology.md` § (3) row "File present only in our fork"). `.github/workflows/deploy-app.yml` is **deleted in the fork**; if upstream changes that file, drop the upstream-side change on merge (the fork has no equivalent). `packages/app/package.json` — the `deploy:web` and `wrangler` deletions stand; upstream's `wrangler` upgrades during a merge are dropped.
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

### T-5 — Delete `.github/workflows/deploy-app.yml`; add `.github/workflows/publish-infra-web.yml`

Delete the upstream Cloudflare-Pages workflow file (single `git rm`). Add the new single-job workflow per § 1.

**Size:** S.
**Depends on:** T-7 (the publisher role + `ORCHESTRA_HOSTED_ZONE_ID` are no longer used; the only required GH-side artifact is the publisher role itself — landing the workflow file before the role exists is fine; the workflow simply fails until the role is in place).

### T-6 — Update `knip.json`

Apply the diff in § 1. Run `npm run knip` to verify no new dead-code warnings.

**Size:** S.
**Depends on:** T-2, T-3, T-4 (knip will flag mismatches if either source file is missing or if `wrangler` is still referenced).

### T-7 — IAM / OIDC / GH Actions vars

See § 3 below. Single IAM role; single OIDC trust (already exists). Much shorter than earlier drafts of this plan.

**Size:** S.
**Depends on:** nothing; can run on day 1.
**Parallel with:** T-1, T-2, T-3, T-4, T-8.

### T-8 — Update `FORK-NOTES.md`

Apply the diff in § 1. Skip the "Cloudflare project decommissioning" note's "Document the deletion in this section once done" until the project is actually deleted (post-merge).

**Size:** S.
**Depends on:** none directly; can be written before code lands.

### T-9 — Acceptance run

Tag a fork release (`app-vX.Y.Z`, NOT beta) and watch the workflow. Verify:

- `publish-infra-web.yml` job `publish` succeeds and uploads `s3://orchestra-internal-packages/infra-web-static/<version>.tgz` (whatever `packages/infra-web/package.json` `version` is at tag time).
- A local `npx cdk synth` of `bin/web-deploy.ts` succeeds (the construct synthesizes cleanly). See § 4.1.
- Re-running the workflow without bumping the construct version fails with `412 Precondition Failed`. See § 4.4.

**Size:** S.
**Depends on:** T-1–T-8 all landed; T-7 IAM in place.

### Parallelism summary

- T-1, T-4, T-7, T-8 can run in parallel from day 1.
- T-2 unblocks once T-1 lands; T-3 unblocks once T-2 lands; T-5 unblocks once T-7 lands (workflow file references the role); T-6 unblocks once T-2/T-3/T-4 land.
- T-9 is the acceptance gate; it depends on everything.

A reasonable single-author sequencing is: (T-1 → T-2 → T-3) in series, with (T-4, T-7, T-8) interleaved opportunistically, finishing on T-5 → T-6 → T-9.

---

## 3. Infra / IAM setup tasks

All resources live in the single nuvo-ai account (`437906455141`). The GH OIDC provider already exists in this account (created for `build-and-publish-daemon.yml`'s `gh-actions-paseo-fork` role); the one new role attaches to the same provider — no new OIDC trust to create.

The fork no longer runs `cdk deploy` from CI, so there is no need to bootstrap CDK in nuvo-ai/us-east-1 for fork-CI purposes (Orchestra's CI handles its own bootstrap in `orchestra-cloud-private`'s scope).

### 3.1 IAM role: `gh-actions-paseo-fork-infra-web-publisher`

Used by the `publish` job in `publish-infra-web.yml`. Least-privilege: **`s3:PutObject` on `arn:aws:s3:::orchestra-internal-packages/infra-web-static/*` only**, with an immutable-upload guarantee.

- **Trust policy:** `token.actions.githubusercontent.com` with `sub` claim matched to `repo:Nuvo-Software-Pty-Ltd/paseo:ref:refs/tags/app-v*` (mirrors the existing `gh-actions-paseo-fork` role's pattern, but narrowed to the SPA construct's release cadence — daemon `v*` tags do not fire this workflow). During development, also accept `repo:Nuvo-Software-Pty-Ltd/paseo:ref:refs/heads/plan-web-spa-deployment` so the workflow can be exercised with `workflow_dispatch` before any tag is cut.
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

### 3.2 GH Actions repository variables / secrets

In `Nuvo-Software-Pty-Ltd/paseo` repo settings:

- **No** new variables or secrets required (single account hardcoded; no hosted-zone, cert, or stack params used by `publish-infra-web.yml`).
- **Remove secret** `CLOUDFLARE_API_TOKEN` only after `deploy-website.yml` is audited — if it still references the secret, leave it (the marketing site stays on Cloudflare per design doc § "Out of scope").
- The `CLOUDFLARE_ACCOUNT_ID` value was inlined in the deleted `deploy-app.yml`, not stored as a secret; deletion is mechanical when the workflow file is removed.

### 3.3 S3 bucket sanity check

`orchestra-internal-packages` exists in nuvo-ai per design doc § "Distribution mechanism". Before T-9, verify:

- Bucket region: the workflow's `aws-region` is set to `ap-southeast-2`. `aws s3api put-object` works across-region transparently, but matching the region avoids cross-region request latency. If the bucket is actually in a different region, set `AWS_REGION_BUCKET` in the workflow `env:` block to match.
- Versioning enabled (recommended; not required for correctness — the IAM deny-overwrite is the primary guard).
- `BlockPublicAccess: BLOCK_ALL`.

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

1. Push a release tag (`app-vX.Y.Z`, non-beta).
2. Watch `publish-infra-web.yml` in GH Actions UI; the `publish` job should complete in ~1–2 minutes.
3. Verify outputs:
   - `aws s3 ls s3://orchestra-internal-packages/infra-web-static/` shows `<version>.tgz` with the expected version.
   - `aws s3 cp s3://orchestra-internal-packages/infra-web-static/<version>.tgz - | tar -tzf - | head` reveals `package/dist/lib/static-spa-site.js`, `package/dist/lib/static-spa-site.d.ts`, `package/package.json`.

### 4.4 Overwrite-guard verification

Re-run `publish-infra-web.yml` (via `workflow_dispatch`) without bumping `packages/infra-web/package.json` `version`:

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
- [ ] **`bin/web-deploy.ts` synthesizes locally without errors** via `npx cdk synth` (env: empty `SPA_DIST_PATH`, no domain). Emits a template with: 1 S3 bucket (BlockPublicAccess BLOCK_ALL, SSE-S3, versioned), 1 CloudFront distribution with `_expo/*` + `assets/*` long-cache behaviors and 403/404 → `/index.html` rules, TLS 1.2+, OAC, no Route53/ACM resources.
- [ ] `npx cdk synth` with `WEB_DOMAIN` + `HOSTED_ZONE_ID` + `HOSTED_ZONE_NAME` set (and `CDK_DEPLOY_REGION=us-east-1`) emits a template with an additional `AWS::CertificateManager::Certificate` (DNS-validated) and `AWS::Route53::RecordSet` (A alias to the distribution).
- [ ] `npx cdk synth` with `WEB_DOMAIN` set but `CDK_DEPLOY_REGION` ≠ `us-east-1` (and no `WEB_CERT_ARN`) **fails fast** with the documented error message.
- [ ] CDK snapshot test in `lib/static-spa-site.test.ts` passes and pins: BlockPublicAccess BLOCK_ALL, both 403/404 → /index.html error responses, `_expo/*` + `assets/*` cache behaviors with CACHING_OPTIMIZED, TLS 1.2+, default behavior CACHING_DISABLED.
- [ ] `packages/app/package.json` no longer contains `deploy:web` script or `wrangler` devDep.
- [ ] Root `package.json` `workspaces` array includes `packages/infra-web`.
- [ ] `knip.json` has a workspace entry for `packages/infra-web` and no longer lists `wrangler` in `ignoreBinaries`.
- [ ] `.github/workflows/deploy-app.yml` is **deleted**.
- [ ] `.github/workflows/publish-infra-web.yml` exists, has a single `publish` job authenticating via OIDC into account `437906455141`, and triggers only on `app-v*` (non-beta) tags.
- [ ] `FORK-NOTES.md` has a "Cloud-mode additions (web SPA deployment)" section documenting all of the above.
- [ ] IAM role `gh-actions-paseo-fork-infra-web-publisher` exists in account `437906455141`, scoped to `s3:PutObject` on the `infra-web-static/` prefix of `orchestra-internal-packages`, with a deny-without-If-None-Match guard.
- [ ] GH Actions secret `CLOUDFLARE_API_TOKEN` is deleted (or scheduled for deletion after `deploy-website.yml` is audited).
- [ ] First post-merge `app-v*` tag drives `publish-infra-web.yml` to green and produces `s3://orchestra-internal-packages/infra-web-static/<version>.tgz` whose tarball, when extracted, exposes `dist/lib/static-spa-site.js`.
- [ ] Re-running `publish-infra-web.yml` without bumping version fails with `412 Precondition Failed` (overwrite guard works).
- [ ] `aws-cdk-lib` pin in `packages/infra-web/package.json` matches `orchestra-cloud-private/packages/infra/package.json` (manual coordination check; sibling planning agent's responsibility to honor).
- [ ] Cloudflare `paseo-app` Pages project is either deleted or has a documented owner/disposition in FORK-NOTES.md.

---

## 6. Open questions / risks

Operator resolutions closed Q-1…Q-12 and O-1; the corresponding decisions are folded into the body of this plan. Items that remain genuinely open:

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
| **Q-10 / O-1 — Tag cross-fire**    | Closed by the simplification: `publish-infra-web.yml` only triggers on `app-v*` (the construct's own cadence). Daemon `v*` tags don't touch the construct.                         | Workflow `on:` block.                                                                                            |
| **Q-11 — `cdk bootstrap`**         | **Dropped.** The fork's CI no longer runs `cdk deploy`; no bootstrap needed in nuvo-ai. Orchestra-side bootstrap lives in `orchestra-cloud-private`'s scope.                       | § 3 preamble.                                                                                                    |
| **Q-12 — Construct version bumps** | Manual semver bumps in `packages/infra-web/package.json`; document in FORK-NOTES.md.                                                                                               | FORK-NOTES sketch (add bumping note when this section lands).                                                    |

### R-1 — Failing CI on the first release tag merge

If T-7 (IAM) is not complete when the first `app-v*` tag lands, the `publish` job will fail at the `configure-aws-credentials` step. This is non-destructive (no partial deploys, no orphaned resources — there's no deploy at all) but visible. **Mitigation:** land T-7 in nuvo-ai BEFORE landing T-5 (workflow file). Order matters.

### R-2 — Orchestra-side coupling drift

The fork's `lib/static-spa-site.ts` is the single source of truth for the construct API. If Orchestra wraps it with their own `web-stack.ts` and the fork later renames a prop (e.g., `hostedZone` → `zone`), Orchestra silently breaks. **Mitigation:** the construct's `StaticSpaSiteProps` interface is the contract; treat it as semver. Bump the construct's `version` major on breaking changes. Document in `packages/infra-web/README.md`.

### R-3 — `bin/web-deploy.ts` drift goes uncaught by fork CI

The fork no longer exercises `bin/web-deploy.ts` beyond typecheck. A subtle bug — wrong env-var name, region check that silently no-ops, a sourcePath default that no longer resolves — would not be caught by the fork's CI; it would surface only when (a) Orchestra's CI deploys the underlying construct and exposes an indirect dependency on `bin/`'s behavior, or (b) a self-host operator hits it. **Mitigation:** when changing `bin/web-deploy.ts`, run `npx cdk synth` locally with at least the two env-var combos in §§ 4.1 and 4.2, and verify the new failure-fast path in § 4.2's second variant. The acceptance checklist's "synthesizes locally without errors" item exists for this reason.

### R-4 — Expo `_expo/` asset path assumption

The design doc says hashed assets live under `_expo/`. Expo's `expo export --platform web` actually emits to `_expo/static/js/web/` and `_expo/static/css/` plus an `assets/` directory for fonts/images. The construct's `_expo/*` + `assets/*` cache behaviors cover both. **Verify empirically once Orchestra deploys the first dev SPA** by inspecting bucket contents; if Expo emits assets under a different prefix in a future major (Expo 55+), the construct's cache behaviors need updating. The fork's CI cannot catch this directly because it no longer runs the deploy.

### R-5 — `BucketDeployment` Lambda runtime limits

`s3Deployment.BucketDeployment` uses an internal Lambda to copy assets from the CDK staging bucket to the destination bucket. The Lambda has a 15-minute timeout. For an Expo web bundle the asset count is small (~hundreds of files, <50 MB total typical), so this is unlikely to bite. Flag for monitoring if the SPA grows substantially. Risk surfaces on Orchestra's side, not the fork's.

---

## Cross-references

- Design doc: `paseo-cloud-daemon/90-cloud-considerations/web-spa-deployment.md` — operator-committed; rereading is unnecessary for execution.
- Existing OIDC pattern: `.github/workflows/build-and-publish-daemon.yml` — the daemon ECR push job; reuses the `gh-actions-paseo-fork` role pattern.
- Cloud-mode rules: `FORK-NOTES.md` (this repo) — the divergence is a "Cloud-mode addition", not a refactor of existing on-host paths.
- `paseo-cloud-daemon/90-cloud-considerations/repo-topology.md` § (3) — conflict policy for cross-fork merges; `packages/infra-web/` is "ours-only" / "ours wins".
- `D-3-plans/PLAN-daemon.md` — format reference for the plan; same numbered-task + acceptance-criteria style.
