# FORK-NOTES — Nuvo-Software-Pty-Ltd/paseo

This is a living fork of [`getpaseo/paseo`](https://github.com/getpaseo/paseo) (AGPL-3.0) for the **Orchestra** SaaS cloud-mode deployment. Upstream copyright is preserved; the AGPL-3.0 license carries through unchanged.

Forked at upstream commit `4141c762` (release tag `v0.1.73`), 2026-05-11.

This file is the source of truth for **what we changed and why**. Upstream merges follow the cadence and conflict-resolution policy in `paseo-cloud-daemon/90-cloud-considerations/repo-topology.md` § (3); the upstream-merge owner consults this file before resolving conflicts.

## How to merge from upstream

```
git fetch upstream
git checkout main
git merge upstream/main
# Resolve conflicts per policy below
npm install
npm run typecheck:daemon
git push origin main
```

**Conflict policy (from `repo-topology.md` § (3))**:

| Conflict location                                                | Default winner                            | Override                                                         |
| ---------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| File present in both, our diff is small or stylistic             | Upstream                                  | If we have a documented reason here, keep ours                   |
| File present in both, our diff is substantive (cloud-mode logic) | Ours, but reconcile with upstream changes | If upstream's change is a security/correctness fix, integrate it |
| File present only in upstream                                    | Take upstream                             | Always                                                           |
| File present only in our fork (cloud-mode-only files)            | Ours                                      | Upstream merge cannot delete our files                           |
| Lockfile / generated artifact                                    | Regenerate (`npm install` after merge)    | —                                                                |

## Cloud-mode additions (D-0)

Cloud-mode is gated by a **single boolean** env var `PASEO_CLOUD_MODE=1`. Anything else (`"true"`, `"yes"`, `"0"`, unset) is on-host mode. This is deliberate — overloaded discriminators silently collapse, as F11 in the prior-attempt postmortem (`paseo-cloud-daemon/.audit/2026-05-07-prior-attempt-postmortem.md` § "Pattern 2") demonstrated. Cloud-mode is **additive only**: no on-host behavior is removed.

D-0's `PASEO_CLOUD_MODE=1` changes exactly three observable behaviors. Nothing else.

### 1. `packages/server/src/server/paseo-env.ts` — `isPaseoCloudMode()` helper

New export. The single source of truth for "is the daemon in cloud-mode?" Every cloud-mode branch in the codebase MUST go through this helper (never inline-check `process.env.PASEO_CLOUD_MODE`). This is the design-out for the F11 footgun.

Tested in `paseo-env.test.ts` § "isPaseoCloudMode".

### 2. `packages/server/src/server/pid-lock.ts` — `acquirePidLock` bypass

In cloud mode, `acquirePidLock` is a no-op. The container _is_ the workspace singleton (one daemon per workspace per `agent-host-topology.md`); a per-host pid file would be either redundant (single-container) or incorrect (a stale pid from a sibling process must not block startup).

Tested in `pid-lock.test.ts` § "pid-lock under PASEO_CLOUD_MODE".

### 3. `packages/server/src/server/config.ts` — listen default `0.0.0.0:6767`

In cloud mode, when neither `PASEO_LISTEN` env nor `--listen` CLI flag is set, the daemon binds on `0.0.0.0:6767` instead of `127.0.0.1:6767`. The ALB target group health check needs the bind to be reachable from the host network namespace. Cloud-mode also overrides `persisted.daemon.listen` (which upstream writes as `127.0.0.1:6767` on first start) because containers don't carry persisted config across restarts.

Tested in `config-cloud-mode.test.ts` § "listen defaults to 0.0.0.0…".

### 4. `packages/server/src/server/config.ts` — hostname allowlist bypass

In cloud mode, `resolveStaticLoadConfigSettings` injects `true` as the first input to `mergeHostnames`, which short-circuits the allowlist (existing `mergeHostnames` semantics: any `true` input wins). The localhost-rebinding mitigation does not apply when the daemon is reachable only via the ALB at a public DNS name; per `paseo-cloud-daemon/90-cloud-considerations/aws-native-mapping.md` § "Inbound: HTTP routes" the Host-allowlist behavior is "Drop … in cloud."

Tested in `config-cloud-mode.test.ts` § "hostnames resolves to `true`…".

## Cloud-mode containerization (D-0)

- `Dockerfile` — multi-stage Node 22 build of the daemon. `ENV PASEO_CLOUD_MODE=1` is set at image level so the cloud-mode toggle is implicit in any container that pulls the image. Override at runtime with `-e PASEO_CLOUD_MODE=` (empty) for on-host smoke testing.
- `.github/workflows/build-and-publish-daemon.yml` — builds the image on push to `main`, pushes to private ECR (`paseo-daemon`) in the Nuvo account in `ap-southeast-2`. Tag scheme: `<upstream-version>+cloud.<git-sha>` plus a rolling `dev-latest`.

## Cloud-mode additions (web SPA deployment)

The Expo web SPA (`packages/app`) is deployed via AWS S3 + CloudFront in the fork — upstream's Cloudflare Pages deploy was never wired into live traffic and is currently failing. Design: `paseo-cloud-daemon/90-cloud-considerations/web-spa-deployment.md`. Fork-side implementation plan: `docs/plans/web-spa-deployment-plan.md` (in the operator-owned `plan-web-spa-deployment` branch).

### Files present only in the fork

- `packages/infra-web/` — new package containing the reusable `StaticSpaSite` CDK v2 construct (`lib/static-spa-site.ts`) and the runnable CDK app (`bin/web-deploy.ts`). Marked `"private": true`. Distributed via `npm pack` + S3 tarball (see below), never published to npm.

### Files modified in the fork

- `.github/workflows/deploy-app.yml` — **deleted**. The upstream Cloudflare Pages workflow has no successor in the fork's CI; SPA deploys are owned by `orchestra-cloud-private` (out of scope of the fork).
- `.github/workflows/publish-infra-web.yml` — **new**. Single-job workflow in nuvo-ai (`437906455141`, `ap-southeast-2`): builds the construct, `npm pack`s, and uploads the tarball via `aws s3api put-object --if-none-match '*'` to `s3://orchestra-internal-packages/infra-web-static/<version>.tgz`. Immutable — re-uploads of the same version fail with 412. Triggered only on `app-v*` non-beta tags. Orchestra's CI vendors the tarball pre-`npm install`.
- `packages/app/package.json` — `deploy:web` script removed; `wrangler` devDep removed.
- `package.json` (root) — workspace list includes `packages/infra-web`.
- `knip.json` — workspace entry for `packages/infra-web`; `wrangler` removed from `ignoreBinaries`; `cdk` added.

### Secrets / variables removed

- GH Actions secret `CLOUDFLARE_API_TOKEN` — drop after the workflow merges. (`packages/website/`'s deploy still uses `CLOUDFLARE_API_TOKEN`; leave the secret alone if `deploy-website.yml` still references it. As of this fork the marketing site stays on Cloudflare Workers per the design doc § "Out of scope".)
- GH Actions inline env `CLOUDFLARE_ACCOUNT_ID` — removed at the same time as `CLOUDFLARE_API_TOKEN`'s deploy-app usage (it was hardcoded in the deleted workflow, not stored as a secret).

### Cloudflare project decommissioning

The `paseo-app` Cloudflare Pages project consumes a slot in the CF account but takes no traffic. Delete at convenience; no rush. Document the deletion in this section once done.

### Construct version bumps

`packages/infra-web/package.json` `version` bumps are **manual** and independent of the root repo version. Bump on every PR that changes the construct's public API (`StaticSpaSiteProps`) or its CloudFormation output. Patch for cosmetic; minor for additive; major for breaking. Orchestra's `file:` dependency on the tarball pins the consumed version exactly — a missed bump means Orchestra never pulls the change (or hits the 412 overwrite guard if the version is reused).

### Cross-stream contracts

- IAM role assumed by fork CI: `arn:aws:iam::437906455141:role/gh-actions-paseo-fork-publish-infra-web` (created by the proprietary side).
- S3 bucket published to: `orchestra-internal-packages` in nuvo-ai (`437906455141`, region `ap-southeast-2`).
- S3 key pattern: `infra-web-static/<semver>.tgz`.
- Package name: `@orchestra/infra-web-static`.
- Initial version: `0.1.0`.
- CDK peer-dep range: `aws-cdk-lib ^2.252.0`, `constructs ^10.5.0`.
- Orchestra hosted zone (self-host docs reference): `Z01217434D0NSDNWF69T` / `orchestra.nuvo.software`.

### Upstream-merge conflict policy

`packages/infra-web/` and `.github/workflows/publish-infra-web.yml` are **fork-only**; upstream merges cannot resurrect them or delete them (per `paseo-cloud-daemon/90-cloud-considerations/repo-topology.md` § (3) row "File present only in our fork"). `.github/workflows/deploy-app.yml` is **deleted in the fork**; if upstream changes that file, drop the upstream-side change on merge. `packages/app/package.json` — the `deploy:web` and `wrangler` deletions stand; upstream's `wrangler` upgrades during a merge are dropped.

## What we did NOT change (Day-0)

This is the smallest possible cloud-mode delta. Things that are deferred to D-1+:

- **Workspace token validation.** The bcrypt-Bearer path stays active under cloud-mode. Workspace tokens are D-1.
- **DynamoDB / Secrets Manager / EFS / EBS** state stores. D-1+.
- **GitHub OAuth, session tokens, cloud auth service** — those live in the proprietary monorepo, not here.
- **The relay code**. Stays in the AGPL core for self-host operators; cloud SaaS does not use it (per `relay-vs-direct.md`).
- **Removal of any on-host code paths.** Every upstream feature still works in on-host mode.

## Tagging conventions

- **Cloud-aware ECR tags:** `<upstream-version>-cloud.<sha>` — e.g., `0.1.73-cloud.d908984`. Docker image tags forbid `+`, so `-` is used as the separator. Published to ECR with both the immutable tag and the rolling `dev-latest`.
- **Upstream merges:** keep upstream's `v0.1.X` and `v0.2.X` tags; do NOT delete them.

## See also

- Upstream: https://github.com/getpaseo/paseo
- License: `LICENSE` (AGPL-3.0; unchanged from upstream)
- Spec volume: `paseo-cloud-daemon/` in the proprietary monorepo (currently a separate working dir)
- D-0 plan: `~/.claude/plans/ok-let-s-plan-out-refactored-pebble.md`
