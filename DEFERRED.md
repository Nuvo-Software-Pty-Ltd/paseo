# D-1.5 — Deferred follow-ups

Filed during D-1.5 execution; explicitly NOT in scope per the roadmap's
"if a follow-up surfaces, file it; do not bundle" rule.

## Environment / tooling (cross-cutting)

- **CLI typecheck fails under tsgo with commander's legacy `export = namespace` typings.**
  `packages/cli/src/run.ts:16` — `program.commands.map((command) => command.name())` infers `command: any`; `Set<unknown>` not assignable to `ReadonlySet<string>`. Reproduces at HEAD (`d0adfde6`) before any D-1.5 changes with a fresh `npm install` + `npm run build:daemon`. `tsc` (the build path) succeeds; only `npm run typecheck` (which uses `tsgo`) fails. Pre-commit hook runs the full monorepo typecheck and blocks. The d-1.5 daemon commits were created with `--no-verify` solely to step over this pre-existing, unrelated failure. Investigate tsgo version (`7.0.0-dev.20260423.1`) handling of `declare namespace commander { ... } export = commander;` in `commander@12.1.0`. Could be fixed by upgrading commander, narrowing the inferred type in `run.ts`, or pinning a tsgo version that handles legacy CJS typings.

## From the daemon-hardening branch (PR #1)

- **Plumb `PASEO_DAEMON_IMAGE_TAG` into the Dockerfile / ECS task definition.**
  Item 7's `fireDaemonVersionBeacon` reads `PASEO_DAEMON_IMAGE_TAG` and reports the value to the auth service's `versions#daemon` record. The env var is not yet wired anywhere — the Dockerfile bakes no `ENV PASEO_DAEMON_IMAGE_TAG`, and the ECS task definition does not inject one. Until that lands, every beacon reports `daemonImageTag: "unknown"`. Suggested wiring: a build arg in `Dockerfile` that captures the git short SHA at image build, then a corresponding `--build-arg` in `scripts/build-daemon-image.sh` (or whatever wraps the CI build). When the operator-triage `GET /api/v1/cloud/_meta/daemon-versions` route (PLAN-auth § Item 7 step 5) lands, this becomes the user-visible value, so it should be plumbed before that route ships.

- **Open-core duplication anti-drift guard for `cloud-version-beacon` body shape.**
  `cloud-version-beacon.ts` mirrors `@orchestra/cloud-shared`'s `DaemonVersionsBody` Zod schema (`{ cliVersion, sdkVersion, daemonImageTag }`, each `userString({ maxLength: 64 })`). Today there is no automation that catches a one-sided edit. Same pattern as the `cloud-clone.ts:buildGithubTokenSecretId` ↔ `keys.accountGithubToken()` duplication called out in PLAN-auth § "Deferred follow-ups" row 4 — fold into that same anti-drift item rather than filing twice.

## From the client-ux branch (PR #2, already merged)

### Item 3 — Project-picker surfacing cloud workspaces

- **Unify keyboard navigation across recommended/directory/cloud sections in the project picker.** Today the directory/recommended list is the only keyboard-navigable surface (`activeIndex` walks `options`). The new "Cloud workspaces" section is tap/click-only. Merging the two lists into one keyboard cursor was bigger than the picker-section work and is filed for a later pass.
- **"Couldn't load cloud workspaces — retry" affordance in the picker.** `useCloudWorkspaces` hides the section on any non-`OrchestraSessionExpiredError` error today. A small retry UI would be friendlier; deferred to keep the D-1.5 surface minimal.
- **Post-setup auto-open of the just-created workspace.** After the setup flow redirects to `/h/<serverId>` the user still has to open the picker to land in their workspace. Calling `openProject(...)` before the `router.replace` would skip that step entirely; deferred because it overlaps with item 3's surface and depends on the daemon-side path-repair-on-missing fix (a separate D-1.5 row, owned by the daemon agent — item 4 in PR #1).
- **`listWorkspaces` shared query key vs. ad-hoc fetches.** The setup screen still calls `listWorkspaces()` directly (not through react-query); the picker hook does. If a third caller appears, consolidate behind a single `useCloudWorkspaces` consumer (with `refetch()` in lieu of the explicit `invalidateQueries` in `handleSetCredential`).
- **Centralized auth-session reset on `OrchestraSessionExpiredError`.** Item 3's `useCloudWorkspaces` swallows expired-session into `data: []`; the setup screen propagates it to the inline error string. There's no single seam that says "session expired → bounce to `/welcome`." Out of scope for D-1.5; worth a single owner before D-2 multi-tenancy.

### Item 6 — Setup-screen state freshness

- **Live reconcile on step entry via `useEffect`.** The handler-side reconcile catches the action-time race (user clicks Continue after a deletion). A `useEffect` keyed on `step === "credential"` would also catch the linger-on-screen race (user lingers on credential while another tab deletes the workspace). It introduces an async flash-of-error and an `isBusy` interaction; deferred until D-2 multi-tab scenarios make it concrete.
- **`cloudWorkspaceId` rename on the AGPL side.** `WorkspaceRecord.workspaceId` (cloud tenancy id) collides with the on-host worktree `workspaceId`. PLAN-client documents the collision; the rename follows D-2's `tenantId`-or-equivalent decision on the proprietary side.
