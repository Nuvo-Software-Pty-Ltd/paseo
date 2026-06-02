# @orchestra/infra-web-static

Reusable AWS CDK v2 construct (`lib/static-spa-site.ts`) plus a runnable CDK app
(`bin/web-deploy.ts`) for deploying the Paseo Expo web SPA (`packages/app`) to
S3 + CloudFront.

**Never published to npm.** This package is `"private": true`. Fork CI packs it
(`npm pack`) and uploads the tarball to
`s3://orchestra-internal-packages/infra-web-static/<version>.tgz`. Orchestra
consumes it via a `file:` dependency. See the design doc:
`paseo-cloud-daemon/90-cloud-considerations/web-spa-deployment.md`.

## Self-host operator deploy path

```bash
git clone <fork>
cd paseo-fork
npm ci
npm run build:web --workspace=@getpaseo/app  # produces packages/app/dist/
cd packages/infra-web
npm run build
export CDK_DEPLOY_ACCOUNT=<your-account>
export CDK_DEPLOY_REGION=<your-region>   # must be us-east-1 if WEB_DOMAIN is set without WEB_CERT_ARN
# optional: WEB_DOMAIN, HOSTED_ZONE_ID + HOSTED_ZONE_NAME, WEB_CERT_ARN, WEB_PRICE_CLASS, WEB_STACK_NAME, SPA_DIST_PATH
npx cdk deploy
```

With no `WEB_DOMAIN`, the distribution is reachable at the bare
`dxyz.cloudfront.net` URL — useful for first-deploy without DNS.

For Orchestra SaaS the hosted zone is `Z01217434D0NSDNWF69T`
(`orchestra.nuvo.software`); self-host operators supply their own.

## Env-var contract

| Env var                               | Required                                                               | Used by                                             |
| ------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------- |
| `CDK_DEPLOY_ACCOUNT`                  | yes                                                                    | CDK env binding                                     |
| `CDK_DEPLOY_REGION`                   | yes (must be `us-east-1` when `WEB_DOMAIN` set without `WEB_CERT_ARN`) | CDK env binding                                     |
| `SPA_DIST_PATH`                       | optional (defaults to `../app/dist`)                                   | construct `sourcePath`                              |
| `WEB_DOMAIN`                          | optional                                                               | construct `domainName`                              |
| `HOSTED_ZONE_ID` + `HOSTED_ZONE_NAME` | optional (both required together)                                      | construct `hostedZone`                              |
| `WEB_CERT_ARN`                        | optional                                                               | construct `certificate` (also relaxes region check) |
| `WEB_PRICE_CLASS`                     | optional, `PRICE_CLASS_ALL`/`PRICE_CLASS_100`/`PRICE_CLASS_200`        | construct `priceClass`                              |
| `WEB_STACK_NAME`                      | optional (defaults to `PaseoWebSpa`)                                   | CloudFormation stack name                           |

## tsconfig override

CDK constructs ship as CJS. This package overrides the workspace's
`tsconfig.base.json` (`ESNext`/`bundler`) with `CommonJS`/`node` to produce
CDK-runtime-compatible output.

## Distribution / consumption

| Step              | Where                                                                              |
| ----------------- | ---------------------------------------------------------------------------------- |
| Build + pack      | `.github/workflows/publish-infra-web.yml` in the fork                              |
| Upload            | `s3://orchestra-internal-packages/infra-web-static/<version>.tgz` (deny-overwrite) |
| Consume           | Orchestra's CI vendors the tarball pre-`npm install`                               |
| Local development | Workspace consumers reference the construct directly                               |

`packages/infra-web/package.json` `version` bumps are manual and independent
of the root repo version. The publish step uses `aws s3api put-object
--if-none-match '*'` so re-uploading the same version fails with `412
Precondition Failed` — every published version is immutable. Bump on every PR
that changes `StaticSpaSiteProps` or materially changes the synthesized
template.
