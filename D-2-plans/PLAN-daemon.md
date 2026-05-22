# PLAN-daemon.md — Phase D-2 daemon-side stream

Scope: the AGPL daemon (this fork, `Nuvo-Software-Pty-Ltd/paseo` on branch `d-2-plan-daemon`) contributions to D-2 "Multi-tenancy isolation." Other streams (PLAN-app, PLAN-auth-and-shared, PLAN-lifecycle-worker, PLAN-cdk-infra) carry the client UX, auth-service routes, async lifecycle worker, and infra/CDK respectively. Cross-references to those streams live in § "Cross-stream dependencies."

D-2 architectural choices already locked (IMPLEMENTATION-ROADMAP.md:296-298, LEARNINGS.md:2412-2451):

- Host family: **Graviton (m7g)** — `linux/arm64` build matrix.
- Container runtime: **containerd** (ECS-on-EC2 AL2023 default).
- Working filesystem: **EBS per workspace** for `/paseo` and `/workspace`.
- Snapshot interval **5 min**; idle-suspend threshold **15 min** — both flat Day-1.
- Capacity manager: **hybrid** — synchronous `RunTask` in the auth service for workspace-create, standalone async worker for suspend/resume/hard-delete.
- Workspace lifecycle states: `active`, `suspended`, `billing_locked`, `archived`, `(purged)`.
- Forward-compat webhook: `workspace.hard_delete_imminent` at T-24h, no-op subscriber Day-1.

**Post-planning synthesis (LEARNINGS.md 2026-05-22) — three of the five plans' open questions resolved by the operator after cross-stream review:**

- **O-1 RESOLVED → Architecture B** (worker-emits-using-AGPL-primitive). The daemon ships schema (T-2) + emit primitive (T-3); the proprietary lifecycle worker is the physical caller at T-24h.
- **O-2 RESOLVED → DDB heartbeat.** Daemon writes `<accountId>#heartbeat / <workspaceId>` every 30s; lifecycle worker scans on a sparse GSI (`lastHeartbeat`). ALB-metric rejected (false-positive risk on long-running schedules/loops with no connected clients). See the new T-4 below.
- **O-3 RESOLVED → cloud archive does not traverse the daemon.** Cloud-workspace archive lands as a session-authed REST call (`POST /api/v1/cloud/workspaces/:id/archive`) directly on the auth service (PLAN-auth-and-shared Task 13). The on-host `archive_workspace_request` WS RPC is preserved unchanged for on-host worktree archive only. The old T-4 (daemon-side archive notification) is therefore dropped from this stream.

O-4 (snake_case vs camelCase) and O-5 (arm64 instance family) remain open below.

Roadmap citations:

- `paseo-cloud-daemon/IMPLEMENTATION-ROADMAP.md:147-176` — D-2 work-stream list.
- `paseo-cloud-daemon/90-cloud-considerations/workspace-lifecycle.md` — state machine + hard-delete sequence + webhook payload.
- `paseo-cloud-daemon/90-cloud-considerations/agent-host-topology.md` — per-workspace daemon container model; `§ Container working filesystem`.
- `paseo-cloud-daemon/90-cloud-considerations/subprocess-isolation.md` — per-spawn credential materialization properties under the per-workspace container model.
- `paseo-cloud-daemon/90-cloud-considerations/open-core-architecture.md:52-64` — webhook event catalog.
- `paseo-cloud-daemon/LEARNINGS.md:2350-2451` — D-1.5 closeout + D-2 kickoff decisions (the live state at gate-clear).

---

## Stream summary

What this stream owns:

1. **arm64 daemon image** — verify the existing `linux/arm64` Dockerfile build actually runs end-to-end on Graviton (the workflow already targets arm64; what is unverified is the runtime behavior on a real Graviton EC2 instance), and surface any x86-only deps not caught at build time.
2. **AGPL-core schema + emit primitive for the `workspace.hard_delete_imminent` webhook event** — define the payload shape, the outbound HTTP+HMAC delivery primitive, and the seam through which the proprietary lifecycle worker invokes it. See § "Open question O-1" for the F9-single-writer question.
3. **Per-spawn `~/.claude` materialization under the per-workspace container model** — re-verify isolation properties hold (the code already exists; D-1.5 shipped it). What's new in D-2 is the IAM scoping: confirm the per-workspace task role's Secrets Manager prefix forces the existing `fetchAnthropicCredential` path to fail-closed on cross-tenant reads.
4. **Wire-boundary lint** — re-run the D-1.5 design-out audit confirming the cloud tenancy identity (JWT-claim `workspaceId`, `accountId`, `repoUrl`) does not leak onto any WS RPC payload added since D-1.5. (Existing on-host `workspaceId` fields in `messages.ts` refer to worktree identity and are F-design-out-compliant — they're not cloud tenancy.)
5. **Daemon-side heartbeat write for the hybrid capacity manager's idle-suspend detection** — RESOLVED to DDB heartbeat per 2026-05-22 synthesis. The daemon writes `<accountId>#heartbeat / <workspaceId>` every 30s with `{ lastHeartbeat, activeAgents, connectedClients, daemonImageTag }` via an HMAC POST to the auth service. See T-4 below.
6. **D-1.5 daemon-side P0 carry-ins** — three specific items from LEARNINGS § "Deferred (filed as D-2 P0 or beyond)" that land on the AGPL fork.

What this stream does NOT own (cross-stream — see § "Cross-stream dependencies"):

- DDB tombstone for archive + EventBridge Scheduler registration → PLAN-auth-and-shared / PLAN-lifecycle-worker.
- The webhook subscriber for `workspace.hard_delete_imminent` → PLAN-lifecycle-worker.
- ECS task definition / IAM policy bodies / per-workspace KMS / per-workspace security group → PLAN-cdk-infra.
- Project-picker multi-workspace UI / "Archived" tab UX → PLAN-app.
- Auth-service workspace-create + `RunTask` plumbing → PLAN-auth-and-shared.

## D-2 closure criteria for this slice

The daemon-side slice closes when:

1. A daemon container built from this fork's `Dockerfile` runs on a real Graviton (`t4g.*` or `m7g.*`) ECS task and completes the D-1 8-step hands-on smoke (LEARNINGS.md:2365). Specifically: Claude Code CLI installs, spawns, completes one turn.
2. The daemon's cloud-mode state-store adapter writes a heartbeat row (`<accountId>#heartbeat / <workspaceId>`) every 30s with `{ lastHeartbeat, activeAgents, connectedClients, daemonImageTag }` via HMAC POST to auth (T-4). The lifecycle worker uses this signal to decide suspends. The on-host `archive_workspace_request` WS RPC is **unchanged** (still handles on-host worktree archive only); cloud-workspace archive flows through PLAN-auth-and-shared's REST route directly and does not traverse the daemon.
3. The AGPL fork exports a `workspace.hard_delete_imminent` event payload Zod schema that PLAN-lifecycle-worker imports (or duplicates with anti-drift annotation) to construct the T-24h emit.
4. Per-spawn Claude home materialization (`cloud-credentials.ts:106-159`) is verified against a per-workspace IAM task role: a daemon running with role A's Secrets Manager scope receives a _deny_ (not a 403 deserialized to a fall-through default) when asking for workspace B's `anthropic-credential` secret. The fail-loud branch lives in `cloud-credentials.ts:60-86`; verify it surfaces correctly.
5. The wire-boundary lint pass on `packages/server/src/shared/messages.ts` and any new D-2-era schemas comes up clean: no `accountId`, no JWT-claim-shaped `workspaceId`, no `repoUrl` added to RPC payloads.
6. All three D-1.5 P0 carry-ins (T-7, T-8, T-9 below) are landed.
7. Hands-on gate (ROADMAP § Phase D-2): two operators sign up under different GitHub accounts, each creates one workspace, each runs one agent; cross-tenant probes (IAM deny on cross-Secrets-Manager-prefix read, IAM deny on cross-DDB-partition read) succeed.

---

## Task list (numbered, dependency-ordered)

Sizes: S ≈ ½ day, M ≈ 1–2 days, L ≈ 3+ days. Estimates include test write-up; exclude cross-stream coordination time.

### T-1 — arm64 daemon image: end-to-end runtime verification on Graviton

**Why:** the CI workflow at `.github/workflows/build-and-publish-daemon.yml:64` already builds `platforms: linux/arm64` (via QEMU on `ubuntu-latest`). The image has been deployed and the D-1.5 smoke passed against it (LEARNINGS.md:2365). What's never been verified is the image running on an **actual** Graviton EC2 instance — D-1's host was an x86 instance running an arm64 image under emulation, or possibly the workflow was changed mid-D-1.5 and never re-deployed onto arm64 hardware. Read the deployed ECS task family's `runtimePlatform.cpuArchitecture` value (CDK-stream-owned; PLAN-cdk-infra § T-?). If it's x86, this stream's verification on Graviton is what unblocks the migration.

The CI matrix change "consider arm64-native GitHub runners to avoid QEMU emulation cost" called out in ROADMAP:296 is a CI-perf concern — defer; the image already builds today, just slowly. Do not bundle.

**Files touched (verification-only; no source changes expected unless something fails):**

- `Dockerfile` (read; no expected edits)
- `.github/workflows/build-and-publish-daemon.yml` (read; no expected edits unless a layer needs rebuilding)
- `packages/server/package.json` deps audit (`onnxruntime-node`, `sherpa-onnx-node`, `node-pty`, `@sctg/sentencepiece-js`, `bcryptjs`).

**Verification commands (operator runs):**

- On a `t4g.medium` or `m7g.medium` Graviton EC2 instance with Docker installed:
  - `docker pull <ecr>/paseo-daemon:dev-latest`
  - `docker run --rm <ecr>/paseo-daemon:dev-latest node -e "console.log(process.arch)"` → expect `arm64`.
  - `docker run --rm <ecr>/paseo-daemon:dev-latest claude --version` → expect a semver match (the CLI runs on arm64; this exercises `@anthropic-ai/claude-code` postinstall outcome).
  - `docker run --rm <ecr>/paseo-daemon:dev-latest node -e "require('node-pty')"` → expect no error (loads `prebuilds/linux-arm64/pty.node`).
  - `docker run --rm <ecr>/paseo-daemon:dev-latest node -e "require('onnxruntime-node')"` → expect no error (loads `bin/napi-v6/linux/arm64/onnxruntime_binding.node`). Note: even though speech is cloud-mode-disabled (`speech-runtime.ts:405`), the module may still be `require`'d eagerly at boot; verify the disabled-stub path never hits the binary load.
  - `docker run --rm -e PASEO_CLOUD_MODE=1 -e ORCHESTRA_AUTH_JWKS_URL=https://example.invalid <ecr>/paseo-daemon:dev-latest` and wait for the daemon to log either `Cloud-mode workspace-token auth enabled` (success) or fail-loud on JWKS pre-warm (acceptable — pre-warm warns and continues per `bootstrap.ts:421`).
- Optional canary: deploy the arm64 image to a fresh Graviton-backed ECS task and run the D-1 8-step smoke from LEARNINGS.md:2365.

**Acceptance criteria:**

- All four `docker run` smokes above pass.
- D-1 8-step hands-on smoke passes against the arm64 container on a real Graviton instance.
- If any native dep is missing the arm64 variant or load-fails: file a follow-up subtask with the dep name + observed error, surface to PLAN-cdk-infra to decide whether to defer the host-family migration vs. unwedge the dep.

**Size:** S (verification-only) → M (if a native dep fails and needs a workaround).

**Risk note:** `sherpa-onnx-node`'s arm64 platform package (`sherpa-onnx-linux-arm64`) is an `optionalDependencies` entry — npm silently skips it on x86 install, silently includes it on arm64 install. The Dockerfile's `npm ci --include=dev --ignore-scripts` (Dockerfile:48) runs INSIDE the target-platform builder image (the Dockerfile is multi-stage and the first `FROM node:22-bookworm-slim` is platform-resolved), so the right optional dep should resolve. Verify by inspecting `node_modules/sherpa-onnx-*` in the running arm64 container before declaring this complete.

---

### T-2 — Define `workspace.hard_delete_imminent` event payload schema in the AGPL fork

**Why:** the workspace-lifecycle.md commits the AGPL core to **owning** the event schema (open-core-architecture.md:54-64; workspace-lifecycle.md:74-85). Day-1 ships a no-op subscriber, but the schema must exist in the AGPL fork because the public docs treat the webhook event catalogue as part of the AGPL's externally-observable behavior.

**Files touched (new):**

- `packages/server/src/server/cloud-webhook-events.ts` — Zod schema + TypeScript type for the event payload. Pattern: mirror `cloud-version-beacon.ts:28-32` exactly — `interface` for the type, the Zod schema living adjacent, no import from `@orchestra/cloud-shared`.

**Payload (locked by workspace-lifecycle.md:58, 78-82):**

```ts
export const WorkspaceHardDeleteImminentEventSchema = z.object({
  eventType: z.literal("workspace.hard_delete_imminent"),
  workspaceId: z.string().min(1), // cloud tenancy id (JWT-claim shape)
  accountId: z.string().min(1),
  archivedAt: z.string().datetime(),
  scheduledPurgeAt: z.string().datetime(),
});

export type WorkspaceHardDeleteImminentEvent = z.infer<
  typeof WorkspaceHardDeleteImminentEventSchema
>;
```

**Acceptance criteria:**

- Schema published from the new module with the exact field names mandated by workspace-lifecycle.md:58. (Note: spec doc uses snake_case `workspace_id`, `account_id`, `archived_at`, `scheduled_purge_at`; for AGPL-fork TS conventions the schema uses camelCase. The mapping is at the HTTP delivery boundary — see T-3.)
- Unit test in `packages/server/src/server/cloud-webhook-events.test.ts` asserts parse round-trip and rejects unknown fields with `.strict()`.
- A second schema export `WorkspaceHardDeleteImminentEventWireSchema` provides the snake_case HTTP payload shape; a transform between the two lives in the same module. This isolates the snake_case-on-the-wire convention from the camelCase-in-TS convention. (Same idea as Zod transform layers used elsewhere; matches the workspace-lifecycle.md doc-prescribed shape exactly.)
- Cross-link comment: `// COMPAT(workspace.hard_delete_imminent): payload locked by paseo-cloud-daemon/90-cloud-considerations/workspace-lifecycle.md § Forward-compatibility hooks. Do not extend without doc update; subscribers depend on the stable shape.`
- Open-core annotation comment: same pattern as `cloud-clone.ts:18-21` documenting any duplication with `@orchestra/cloud-shared`. (If PLAN-lifecycle-worker chooses to import this schema rather than duplicate it, fine; if duplicate, both sides carry the anti-drift comment from D-1.5's deferred guard.)

**Size:** S.

---

### T-3 — Outbound webhook emit primitive (HMAC, retries, payload validation)

**Why:** the AGPL core defines the schema (T-2) and the emit primitive (this task). Whether the daemon physically emits this event, or the lifecycle worker imports the primitive and emits — open question O-1. Either way, the AGPL fork owns the primitive code.

The primitive deliberately mirrors the existing `cloud-version-beacon.ts:90-135` shape (HMAC sign, outbound POST, fire-and-forget logging) so future webhook events compose against the same module.

**Files touched (new):**

- `packages/server/src/server/cloud-webhook-emit.ts` — `emitWebhookEvent({ subscriberUrl, hmacKey, event, logger, fetchImpl? })`. Validates the event against the schema in T-2 before sending; signs with HMAC-SHA256 via `crypto.createHmac` (same as `cloud-version-beacon.ts:106`); POSTs to `subscriberUrl` with header `X-Orchestra-Internal-HMAC`; logs on success and warns on non-2xx/network-failure.
- `packages/server/src/server/cloud-webhook-emit.test.ts` — unit test with a vi.fn() fetch impl asserting (a) HMAC computed over `JSON.stringify(event)`, (b) the body is the wire-shape (snake_case) variant, (c) non-2xx returns `{ ok: false, status }`, (d) a thrown fetch returns `{ ok: false }` and logs at warn level.

**Acceptance criteria:**

- The primitive is **single-purpose:** delivery only. Schema validation lives in T-2; the emit primitive accepts a typed `WorkspaceHardDeleteImminentEvent` (or future union with other webhook events) and refuses to send untyped payloads.
- Retry policy Day-1: **no retries.** Per workspace-lifecycle.md:84, "EventBridge Scheduler retries failed subscriber deliveries with exponential backoff" — the _scheduler_ retries, not the emit primitive. The daemon (or worker) emits once; if delivery fails, EventBridge will fire the schedule again. Document this in a header comment.
- No `workspaceId` / `accountId` extracted from request context — the caller passes the full payload; the primitive does not derive identity from the JWT or the workspace ALS. (This matches the prompt's F3 design-out: the primitive is invoked from a context where workspace identity has already been determined by the caller's logic.)
- No `@orchestra/*` imports.

**Size:** S.

**Depends on:** T-2.

---

### T-4 — `writeHeartbeat()` in the daemon's cloud-mode state-store adapter

**Why:** the 2026-05-22 synthesis resolved suspend-detection to DDB heartbeat. The daemon is the producer of the signal; the proprietary lifecycle worker scans a sparse GSI on `lastHeartbeat` to decide which workspaces to suspend (PLAN-lifecycle-worker; PLAN-cdk-infra adds the GSI). The daemon-side piece is a small periodic write loop, cloud-mode-gated.

**Wire shape (locked by synthesis):**

- DDB row key: `pk = "<accountId>#heartbeat"`, `sk = "<workspaceId>"`. The account-level partition aggregates heartbeats per account so the worker's GSI scan is efficient.
- Row payload: `{ lastHeartbeat: ISO8601, activeAgents: number, connectedClients: number, daemonImageTag: string }`.
- Frequency: every **30 s** in cloud mode; no-op outside cloud mode.

**Mechanism: HMAC POST to auth, not direct DDB.**

- Why: the daemon today carries no DDB SDK code; adding the DDB client to the daemon container increases its surface and creates a new exception to "auth is the single writer of DDB rows" (F9). The HMAC POST pattern is the one the daemon already uses (`cloud-version-beacon.ts:107`). Auth writes the DDB row server-side using its existing DDB client.
- Auth-side route: `POST /api/auth-internal/heartbeat` — owned by PLAN-auth-and-shared as a NEW small route (auth-internal namespace from Task 6 of PLAN-auth-and-shared). Coordinate the wire shape in a joint note before this stream's T-4 ships.

**Files touched (cloud-mode-gated):**

- `packages/server/src/server/cloud-heartbeat.ts` (new) — `startHeartbeatLoop({ intervalMs = 30_000, sessionRegistry, logger })`. Computes `activeAgents` (count of running agent loops across all sessions on this daemon) and `connectedClients` (count of WS connections in the session registry); reads `process.env.PASEO_DAEMON_IMAGE_TAG`; HMAC-POSTs to `${ORCHESTRA_AUTH_INTERNAL_URL}/api/auth-internal/heartbeat` with `{ workspaceId, lastHeartbeat, activeAgents, connectedClients, daemonImageTag }`. `workspaceId` is read from `getCurrentWorkspaceAuth()`'s ALS at boot, NOT from the wire (F3 design-out). Logs warn-and-continue on failure; never blocks.
- `packages/server/src/server/cloud-heartbeat.test.ts` (new) — vi.fn() fetch + vi.useFakeTimers; assert one HMAC-POST per 30s tick; assert the body shape; assert warn-and-continue on fetch rejection.
- `packages/server/src/server/bootstrap.ts` (existing daemon boot module) — start the heartbeat loop after the workspace auth ALS is bound, only if `isPaseoCloudMode()`. Stop on SIGTERM (clean shutdown — pairs with T-7's flush-and-exit hygiene).
- `packages/server/src/server/cloud-version-beacon.ts` is the reference pattern for HMAC envelope, env-var sourcing, and warn-and-continue error handling. **Do not** add a second copy of the HMAC primitive; if cloud-version-beacon's signer is private, extract a small `cloudHmacFetch()` helper module under `packages/server/src/server/` and reuse it (sized inside this task).

**Acceptance criteria:**

- `cloud-heartbeat.ts` carries `// COMPAT(workspace-heartbeat): added in v0.2.X for D-2; the proprietary lifecycle worker scans on the GSI populated by this write. Single-writer for the heartbeat row.` Grep `rg "startHeartbeatLoop\("` returns exactly one production caller (`bootstrap.ts`).
- On-host mode (no `PASEO_CLOUD_MODE`): the heartbeat loop is not started; the new module is dead-code outside cloud.
- Unit test: 30s fake-timer tick fires one HMAC POST with the right body; 100s tick fires three. The body's `activeAgents` reflects the test's injected session-registry state.
- Failure-mode test: fetch rejection logs at warn and the loop continues on the next tick — does NOT throw, does NOT crash the daemon process.
- **No** `accountId` and **no** `repoUrl` derived on the daemon side — the auth route looks up the workspace's `accountId` server-side from the JWT/workspace mapping and writes the row key `<accountId>#heartbeat / <workspaceId>`. The daemon sends `workspaceId` only.
- Throttle/jitter: the 30s interval is offset by a small random jitter (0–2s) on boot to avoid thundering-herd against the auth service when many tasks restart in a cluster window.

**Size:** M (the periodic loop + the HMAC envelope + the session-registry plumbing for `activeAgents`/`connectedClients`).

**Depends on:** none of the prior tasks in this stream; can start in parallel with T-1/T-2/T-3.

**Cross-stream:**

- **PLAN-auth-and-shared** must ship `POST /api/auth-internal/heartbeat` to receive the writes; pin the wire shape `{ workspaceId, lastHeartbeat, activeAgents, connectedClients, daemonImageTag }` in a joint note before this stream's T-4 ships.
- **PLAN-cdk-infra** adds the DDB GSI on `lastHeartbeat` (sparse numeric) for the worker's scan query — and adds `ecs:UpdateItem` to the auth task role's policy for the heartbeat row prefix (or extends the existing auth DDB grant).
- **PLAN-lifecycle-worker** is the consumer; the scan-every-60s + activity-gates (`activeAgents == 0 AND connectedClients == 0`) logic lives there.

---

### T-5 — Per-spawn `~/.claude` materialization under per-workspace IAM: re-verify isolation

**Why:** the materialization code exists (`cloud-credentials.ts:106-159`) and works in D-1's single-tenant deployment. Under D-2, the daemon's task role is scoped to its own workspace's Secrets Manager prefix only (`paseo-cloud/<account>/<workspace>/*`). The fail-closed behavior must be verified — D-1's single-role-grants-all environment masked the failure mode.

**Files touched (verification + harden if needed):**

- `packages/server/src/server/cloud-credentials.ts:54-86` (`fetchAnthropicCredential`) — confirm the error message surfaces correctly when the SDK returns `AccessDeniedException` (not `ResourceNotFoundException`). If the message currently sanitizes the underlying error into a less-informative string, harden the log line to preserve the IAM-deny detail (operator triage friend).
- `packages/server/src/server/cloud-credentials.test.ts:114-` — add a test that injects a `SecretsManagerLike` whose `getSecretValue` throws an `AccessDeniedException`-shaped error; assert the wrapper rethrows with the workspace id + secret id intact in the log.

**Acceptance criteria:**

- Source read confirms: `provisionCloudClaudeHome` (`cloud-credentials.ts:165`) reads the workspace id **only** from `getCurrentWorkspaceAuth()` (via ALS, `cloud-auth.ts:110`). It does **not** accept a `workspaceId` parameter from any caller. This is the F3 design-out for cloud tenant identity in this code path.
- The Secrets Manager id constructor `buildAnthropicCredentialSecretId` (`cloud-credentials.ts:17`) hard-codes the per-workspace prefix; the IAM task role's `Resource` matches this prefix only (PLAN-cdk-infra owns this policy body).
- Hands-on probe (delivered to ROADMAP § D-2 hands-on gate, operator-driven): operator A's workspace, operator B's workspace; A's daemon container has `secretsmanager:GetSecretValue` only on `paseo-cloud/<A-account>/<A-workspace>/*`. Attempting to fetch B's credential **must** fail with the AGPL daemon's fail-loud error message + the underlying IAM `AccessDeniedException` traceable in CloudTrail.
- Per-spawn cleanup (`cloud-credentials.ts:143-152`) verified by inspecting `/tmp/orchestra-claude-home/<spawn-id>` is absent after the spawn ends. (Hands-on probe: operator A's agent prompts `"List files in /tmp/orchestra-claude-home"` — should see only the live spawn dir, never B's anything.)

**Note on terminology:** `cloud-credentials.ts:12` declares `CLAUDE_HOME_ROOT = "/tmp/orchestra-claude-home"`. ROADMAP § D-2 hands-on gate text says `/tmp/paseo-claude-home`. The on-host code already shipped with `/tmp/orchestra-claude-home`; the ROADMAP text is stale. **Decision:** keep `/tmp/orchestra-claude-home` (existing); when the ROADMAP file is next touched, the doc text gets updated to match. (Filed as a deferred follow-up — do not bundle into this PR.)

**Size:** S (mostly verification + log-line hardening).

---

### T-6 — Wire-boundary lint pass: post-D-1.5 RPC additions

**Why:** the prompt's "re-run the D-1.5 design-out lint." The D-1.5 closeout (LEARNINGS.md:2376-2384) declared the lint clean at gate-clear. This task confirms no regressions since.

**Files surveyed:**

- `packages/server/src/shared/messages.ts` (entire file; ~2440 lines).
- Any `*.test.ts` that adds RPC schemas.
- Any new schema added in T-2 / T-4 must clear the lint too. (T-4's heartbeat body — `{ workspaceId, lastHeartbeat, activeAgents, connectedClients, daemonImageTag }` — has no `accountId` or `repoUrl`; the lint should confirm.)

**Lint criteria (from LEARNINGS.md:2376-2384):**

1. **Workspace identity not on the wire:** every appearance of `workspaceId: z.string()` in `messages.ts` must refer to the **on-host** worktree id (= worktree directory under `~/.paseo/worktrees/`), NOT the cloud tenant id. The cloud tenant id flows only through the JWT subprotocol and `getCurrentWorkspaceAuth()`. (Note: see § "Risks/known-hard parts" — the name collision between on-host worktree id and cloud tenant id is a known footgun and is filed for `tenantId` rename, but the rename is not in this stream.)
   - Specifically: the 9 sites today (`messages.ts:1036, 1446, 1502, 1662, 2365, 2373, 2390, 2408, 2436`) refer to worktree ids in `WorkspaceSetupStatusRequest`, `WorkspaceSetupProgress`, `archive_workspace_request`, etc. All are worktree ids. Confirm by reading each one in context. If a new schema added since D-1.5 (`git log packages/server/src/shared/messages.ts d0adfde6..HEAD`) introduces a cloud-tenant-shaped field, flag and require move-to-JWT.
2. **No `repoUrl` on RPC payloads.** Grep `rg "repoUrl" packages/server/src/shared/messages.ts` — expect 0 hits.
3. **No `accountId` on RPC payloads.** Grep `rg "accountId" packages/server/src/shared/messages.ts` — expect 0 hits.
4. **No `projectId` referring to a cloud tenant.** The 2 hits today (`messages.ts:886, 2224`) refer to on-host project ids; confirm in context.
5. **One discriminator** for cloud mode (`isPaseoCloudMode`) — grep `rg "PASEO_CLOUD|ORCHESTRA_CLOUD|ORCHESTRA_DEV" packages/server/src/` and confirm only `paseo-env.ts:86-88` reads the env var directly. (LEARNINGS.md:2379 confirmed this clean at gate-clear; re-confirm.)
6. **DDB key strings only in cloud-shared** — grep `rg '"WORKSPACE#\|"workspace#"\|"WORKSPACES#"' packages/server/src/` — expect 0 hits.
7. **Open-core import discipline** — grep `rg "@orchestra/" packages/server/src/` — expect ≤4 hits, all inside source-comment annotations (LEARNINGS.md:2384).

**Files touched (lint output only):**

- `D-2-plans/PLAN-daemon.lint-results.md` — a markdown table with one row per check + pass/fail. Operator reviews; flag any fail for resolution before this stream closes.

**Acceptance criteria:**

- All 7 checks pass.
- Any new schema introduced by T-2 / T-4 / T-7 / T-8 / T-9 / T-10 is re-checked after the change.

**Size:** S.

**Depends on:** T-2, T-4, T-7, T-8, T-9, T-10 (run after they all land).

---

### T-7 — Worktree GC after DDB delete (D-1.5 P0 carry-in)

**Why:** LEARNINGS.md:2389 — _"local session store reset + daemon-side EBS path cleanup. Becomes load-bearing in D-2 with EFS per-workspace access points."_ D-1.5 left orphan paths: `/workspace/ws_999faa26/.git-canonical/` from a deleted-but-not-GC'd D-1 workspace (LEARNINGS.md:2406).

Under D-2's per-workspace EBS volume model, the workspace's data lives on a dedicated EBS volume that the lifecycle worker detaches + deletes during hard-delete (workspace-lifecycle.md:65). The daemon container's role in this is to **release** the volume cleanly: flush, unmount-friendly, exit. This is largely operating-system / ECS-task-shape work owned by PLAN-cdk-infra. **The daemon-side piece:** ensure the daemon does not hold open file descriptors against `/workspace/<id>` after the workspace transitions out of `active` state, and ensure no daemon-internal cache references the deleted workspace id.

**Files touched:**

- `packages/server/src/server/session.ts` — audit the session-close path. When a session disconnects (workspace becomes idle), do all `/workspace/<id>/...` file descriptors close? `node-pty` shells, file watchers, git-checkout long-lived processes — all must exit. The daemon's existing shutdown supervisor (`bootstrap.ts` SIGTERM handler) is the entry point; confirm it walks all sessions + closes all subprocess handles.
- `packages/server/src/server/workspace-registry.ts` (existing) — does the registry's in-memory cache need an `evict(workspaceId)` operation for the hard-delete case? Likely not (per-workspace daemon container = no other workspaces to be confused with), but verify.

**Acceptance criteria:**

- Daemon receives SIGTERM (capacity manager calls `StopTask` on suspend or hard-delete); within the ECS grace period (default 30 s), the daemon process exits cleanly with no `EBUSY` errors logged.
- No daemon-internal cache references survive across container restart (each container is per-workspace; the cache is naturally scoped).
- Hands-on probe: capacity manager suspends a workspace; reattaches the EBS volume on the next `RunTask`; the worktree is intact and the previous session's writes are durable. (This crosses into PLAN-cdk-infra's snapshot-and-restore story; the daemon's role is only to release cleanly.)

**Size:** S (mostly audit + small SIGTERM hardening if a leak found).

**Cross-stream:** PLAN-cdk-infra owns the EBS attach/detach/snapshot; this task is the daemon-side flush-and-exit hygiene that PLAN-cdk-infra depends on.

---

### T-8 — Centralized `OrchestraSessionExpiredError` handler in cloud-mode (D-1.5 P0 carry-in)

**Why:** LEARNINGS.md:2388 — _"single owner needed before D-2 multi-tenancy."_ This is a client-side concern (the app surfaces the error), but D-1.5 closeout flagged it for D-2 because _"D-2 multi-tenancy will exacerbate this (operators come and go; sessions expire silently)."_

**Decision: this is PLAN-app's work, not the daemon's.** The daemon cannot push a "session expired" signal to the client — JWT expiry is a client-side concern (the client minted the token; the client decides when to refresh). The daemon's role is to reject post-expiry requests cleanly, which D-1.5 already verified (`saas-auth.md` updated to `VERIFIED`, capture artifact at LEARNINGS.md:2363).

**Files touched:** none in this stream.

**Action:** confirm with PLAN-app that the centralized handler lives there; explicitly carry NOT in this stream.

**Size:** 0 (cross-stream coordination only).

---

### T-9 — `PASEO_DAEMON_IMAGE_TAG` plumbed end-to-end (D-1.5 P0 carry-in)

**Why:** DEFERRED.md:13-14 — _"Until that lands, every beacon reports `daemonImageTag: 'unknown'`. Worth doing before the operator-triage GET route ships (otherwise the user-visible value is always 'unknown')."_

Two halves to this work:

1. **Daemon (this stream):** `resolveDaemonImageTag()` (`cloud-version-beacon.ts:85-88`) already reads `process.env.PASEO_DAEMON_IMAGE_TAG`. No daemon-side code change needed.
2. **Image build (this stream, via Dockerfile):** add an `ARG` for the image tag, propagate to `ENV PASEO_DAEMON_IMAGE_TAG=$IMAGE_TAG`.
3. **CI (this stream, via workflow):** pass the tag as `--build-arg` in the docker/build-push-action.
4. **ECS task definition (PLAN-cdk-infra):** also inject the tag at runtime so the value is visible without a rebuild.

The daemon stream owns parts 1, 2, 3. Part 4 is cross-stream.

**Files touched:**

- `Dockerfile` — add `ARG PASEO_DAEMON_IMAGE_TAG="unknown"` near the top of the runtime stage; add `ENV PASEO_DAEMON_IMAGE_TAG=${PASEO_DAEMON_IMAGE_TAG}` before the `USER node` line. Default to `"unknown"` so on-host `docker build` without the arg doesn't fail.
- `.github/workflows/build-and-publish-daemon.yml:60-` — add `build-args: PASEO_DAEMON_IMAGE_TAG=${{ steps.version.outputs.tag }}` to the `docker/build-push-action@v6` invocation.

**Acceptance criteria:**

- Local `docker build --build-arg PASEO_DAEMON_IMAGE_TAG=0.1.99-cloud.deadbeef . -t paseo-daemon:test` produces an image where `docker run --rm paseo-daemon:test env | grep PASEO_DAEMON_IMAGE_TAG` returns the expected value.
- CI build of the workflow produces images where the env var is populated.
- The `versions#daemon/dev` row in the proprietary DDB (LEARNINGS.md:2361) shows a real tag, not `"unknown"`, on the next deploy.

**Size:** S.

---

### T-10 — `/api/auth-internal/*` namespace and ALB-routing alignment (D-1.5 P0 carry-in)

**Why:** LEARNINGS.md:2370, 2390 — D-1.5 hit a path-prefix collision because both daemon and auth use `/api/internal/*`. Day-1 was patched with explicit ALB rules per route; the proper fix is renaming auth's HMAC routes to a non-colliding namespace.

**Decision: this is PLAN-auth-and-shared's work, not the daemon's.** The daemon's `/api/internal/clone-repo` is the on-prem endpoint; the auth service's `/api/internal/{describe-workspace, daemon-versions}` are what collide. Renaming on the auth side avoids per-path ALB rules.

**Daemon-side action:** confirm the daemon's `cloud-clone.ts:160-200` and `cloud-version-beacon.ts:107` use `${ORCHESTRA_AUTH_INTERNAL_URL}/api/internal/{describe-workspace,daemon-versions}` — these are the **outbound** URLs, called by the daemon. If PLAN-auth-and-shared renames to `/api/auth-internal/*`, update these two call sites.

**Files touched (only after PLAN-auth-and-shared lands):**

- `packages/server/src/server/cloud-clone.ts:167` — change `/api/internal/describe-workspace` → `/api/auth-internal/describe-workspace`.
- `packages/server/src/server/cloud-version-beacon.ts:107` — change `/api/internal/daemon-versions` → `/api/auth-internal/daemon-versions`.

**Acceptance criteria:**

- After PLAN-auth-and-shared's rename ships, the daemon's outbound URLs match. CI smoke catches mismatches because `fireDaemonVersionBeacon` logs `Daemon-version beacon delivered` at info on success (line 133); a mismatch produces a warn.
- The ALB rule that targets `/api/internal/{describe-workspace,daemon-versions}` is replaced by a single `/api/auth-internal/*` prefix rule (PLAN-cdk-infra owns this; daemon stream confirms after the rename that the routing still works).

**Size:** S (call-site rename, two files).

**Cross-stream:** depends on PLAN-auth-and-shared committing first; PLAN-cdk-infra updates the ALB rule.

---

## Cross-stream dependencies

| Dep                                                 | This stream → other                                                              | Other → this stream                                                                                                                                          | Resolution mechanism                                                                                                                                                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace.hard_delete_imminent` event schema (T-2) | **Provided by** this stream                                                      | **Consumed by** PLAN-lifecycle-worker (imports or duplicates)                                                                                                | Joint note pinning Zod shape before T-2 ships. Anti-drift guard filed (existing D-1.5 deferred item) covers the duplication.                                                                                                                   |
| Emit primitive (T-3)                                | **Provided by** this stream                                                      | **Consumed by** PLAN-lifecycle-worker if architecture A; otherwise self-contained                                                                            | Locked by O-1 resolution.                                                                                                                                                                                                                      |
| Heartbeat write (T-4)                               | **Emitted by** this stream every 30s as HMAC POST `/api/auth-internal/heartbeat` | **Consumed by** PLAN-auth-and-shared (persists DDB row `<accountId>#heartbeat / <workspaceId>`) and PLAN-lifecycle-worker (scans via GSI on `lastHeartbeat`) | Joint note pinning wire body `{ workspaceId, lastHeartbeat, activeAgents, connectedClients, daemonImageTag }` + HMAC header `X-Orchestra-Internal-HMAC`. PLAN-cdk-infra adds the GSI.                                                          |
| Per-workspace IAM task role (T-5)                   | **Verified by** this stream's hands-on probe                                     | **Authored by** PLAN-cdk-infra                                                                                                                               | PLAN-cdk-infra defines the policy body; daemon stream's verification confirms the deny path works.                                                                                                                                             |
| `linux/arm64` host family (T-1)                     | **Verified by** this stream                                                      | **Provisioned by** PLAN-cdk-infra (Graviton instance family in the ASG / capacity provider)                                                                  | PLAN-cdk-infra picks `t4g.medium` / `m7g.medium`; daemon verifies image runs on it.                                                                                                                                                            |
| `PASEO_DAEMON_IMAGE_TAG` runtime injection (T-9)    | **Build-time wiring** by this stream                                             | **Runtime injection at ECS task definition** by PLAN-cdk-infra                                                                                               | Build-args land first; CDK pulls the value from the image's labels or from the deployment's known tag.                                                                                                                                         |
| `/api/auth-internal/*` rename (T-10)                | **Call-site rename** in this stream                                              | **Route rename** by PLAN-auth-and-shared; **ALB rule update** by PLAN-cdk-infra                                                                              | Three-way coordination: auth ships rename → daemon updates call sites → CDK updates ALB rule. Order matters; do not deploy auth's rename in isolation without the daemon catching up (404 spike risk on the outbound calls during the window). |
| Client `OrchestraSessionExpiredError` handler (T-8) | None                                                                             | **Authored by** PLAN-app                                                                                                                                     | No daemon-side surface change.                                                                                                                                                                                                                 |

---

## Open questions / assumptions (flag for human resolution before implementation)

### O-1 (RESOLVED 2026-05-22 → Architecture B): Who is the single writer for `workspace.hard_delete_imminent` emission?

> **Resolution:** Architecture B (worker-emits-using-AGPL-primitive). The lifecycle worker is the single physical caller of T-3's primitive at T-24h; the AGPL fork is the source of truth for both the schema (T-2) and the emit code (T-3). The duplication-vs-package decision follows the existing `@orchestra/cloud-shared` pattern: AGPL is the source, the worker imports or duplicates with an anti-drift guard (filed at deferred follow-up #3 below).

Preserved analysis (for historical reference):

The workspace-lifecycle.md says _"The AGPL core's webhook subsystem emits the event to configured subscribers."_ The hard-delete fires at T-24h when the workspace daemon is **suspended / archived** and not running. Two architectures:

- **Architecture A — daemon-emits-on-resume.** Lifecycle worker EventBridge at T-24h triggers `RunTask` on the workspace's daemon → daemon receives an internal POST (e.g., `/api/internal/emit-workspace-hard-delete-imminent`) with the payload → daemon's emit primitive (T-3) fans out to subscribers. **F9 preserved:** daemon is the single writer for the emit. **Cost:** spinning up the daemon for ~30 s 30 days after archive. **Risk:** if RunTask fails (instance pool exhausted, etc.), the event is missed and never fires.
- **Architecture B — worker-emits-using-AGPL-primitive.** Lifecycle worker EventBridge at T-24h triggers a Lambda or worker handler → handler imports the AGPL emit primitive (T-3) directly (open-core duplication pattern, like `cloud-clone.ts:21` does for the GitHub secret-id template) → fans out to subscribers. **F9 preserved (different framing):** the AGPL emit primitive is the single primitive (code path); the worker is the single physical caller of it for this event. **Cost:** none; ~50ms outbound HTTP. **Risk:** the AGPL primitive must be packageable (NPM lib) or duplicated; today the daemon's TS isn't published as a library.

**Recommendation: Architecture B.** Reasons:

- The cost of A (RunTask for 30s every workspace hard-delete) scales linearly with archive volume; unattractive under any future scale.
- The "AGPL core emits" framing in workspace-lifecycle.md is preserved: the AGPL fork owns the schema (T-2) AND the emit code (T-3); the lifecycle worker is a caller, not a redefinition.
- The duplication-vs-package decision can be the same as the existing `@orchestra/cloud-shared` pattern: the AGPL fork is the source of truth, the worker imports or duplicates with an anti-drift guard.

**What to decide:** A vs B.

**Implication if A:** add a new task T-2.5 — `/api/internal/emit-workspace-event` route on the daemon, HMAC-authed, reads payload from request body, calls emit primitive (T-3), responds 200 / 5xx. Sized M. Plus a coordination subtask with PLAN-lifecycle-worker on the resume-on-T-24h shape.

**Implication if B:** no new daemon-side task. PLAN-lifecycle-worker becomes the single physical caller of T-3's primitive; daemon ships schema (T-2) and primitive (T-3) as code that the worker imports.

### O-2 (RESOLVED 2026-05-22 → DDB heartbeat): Suspend-detection mechanism — does the daemon emit an idle signal?

> **Resolution:** DDB heartbeat. Daemon writes via HMAC POST every 30s (this stream's T-4); auth persists `<accountId>#heartbeat / <workspaceId>` with the activity payload; lifecycle worker scans on a sparse `lastHeartbeat` GSI every 60s. Activity gates: `lastHeartbeat < now - 15min AND activeAgents == 0 AND connectedClients == 0`. ALB-metric path rejected because long-running schedules/loops with no connected WS clients would falsely flag as idle — a data-loss-class bug (see LEARNINGS 2026-05-22).

Preserved analysis (for historical reference):

workspace-lifecycle.md:123 + `agent-host-topology.md:283`: _"Suspend-detection mechanism: TBD."_ Candidates:

- **DDB heartbeat written by the daemon every N seconds.** Cost: one DDB write per N seconds per workspace; aggregates. Daemon's role: write `keys.workspaceHeartbeat(workspaceId)` (proprietary key shape; daemon would use a small HMAC POST instead). Complexity: medium.
- **ALB connection count metric.** Pure infra-side. Daemon's role: none. The lifecycle worker reads CloudWatch ALB metric `ActiveConnectionCount` per target group and decides. **Open-core-clean.** Probably the right Day-1 default.
- **Daemon emits its own idle signal via webhook.** Daemon's role: track `lastClientActivityAt` in session manager (`websocket-server.ts:1085`-area data is already there), emit `workspace.idle` event after 15-min threshold. Complexity: high; daemon now owns the suspend threshold instead of the worker. F9 violation risk (which side is the writer for "this workspace is idle"?).
- **Hybrid — daemon exposes `/api/internal/idle-status` HTTP route.** Worker polls. Daemon's role: implement the route; respond `{ isIdle: bool, lastActivityAtIso }`. Complexity: low. Worker keeps the policy decision; daemon answers a question. **Open-core-clean.**

**Recommendation:** start with **ALB connection count** (no daemon-side work). If it proves unreliable (e.g., long-poll WS connections inflate the count past expected), fall back to **daemon `/api/internal/idle-status` route**. **Do NOT** ship "daemon emits idle webhook" — it folds policy (the 15-min threshold) into the daemon binary, violating open-core (the threshold is a Paseo Cloud plan-tier decision, not an AGPL-core concern).

**What to decide:** which of the four. Daemon-side task added only if `/api/internal/idle-status` is picked. Sized S.

### O-3 (RESOLVED 2026-05-22 → cloud archive bypasses the daemon entirely): Archive notification mechanism

> **Resolution:** the cloud-workspace archive flow does not traverse the daemon. It lands directly on the auth service as a session-authed REST call (`POST /api/v1/cloud/workspaces/:id/archive`; PLAN-auth-and-shared Task 13), which writes DDB + registers the EventBridge schedules in one transaction. The on-host `archive_workspace_request` WS RPC (`session.ts:7020`) is preserved unchanged for on-host worktree archive (hide-from-sidebar UX) only; the two operations share a name but are semantically different per `workspace-lifecycle.md`. No daemon-side notification primitive is needed at D-2 — neither HMAC POST nor webhook event. **The old T-4 in earlier drafts of this plan is dropped.**

### O-4 (LOW): Snake_case vs camelCase on the webhook wire

workspace-lifecycle.md:58 prescribes the wire payload with snake_case keys: `{workspace_id, account_id, archived_at, scheduled_purge_at}`. The AGPL daemon's existing internal HMAC POST patterns (`cloud-version-beacon.ts:99-103`) use camelCase. T-2 above resolves this by carrying TWO schemas — a TS-side camelCase shape and a wire-side snake_case shape — with a transform.

**What to decide:** confirm this dual-schema approach is acceptable, or pick one canonical case across both. Recommendation: keep both; the snake_case wire shape matches the spec doc verbatim (subscribers will read the doc, not the TS), and the camelCase in-TS keeps the daemon code consistent with the rest of the codebase. T-2 acceptance criteria already encode this.

### O-5 (ASSUMPTION): existing arm64 CI was already passing for D-1.5 deploys

The CI workflow at `.github/workflows/build-and-publish-daemon.yml:64` already specifies `platforms: linux/arm64`. The D-1.5 closeout deployed against the resulting image and the smoke passed (LEARNINGS.md:2365). The assumption is therefore that the running ECS task is ALREADY arm64-capable today; T-1's verification is "confirm what we think is true" rather than a forward migration. **If** the host EC2 instance family is x86 today and arm64 emulation is happening at runtime via QEMU on the host, then T-1's verification surfaces this AS the migration work, and PLAN-cdk-infra picks up the host-family change.

**What to decide:** read the current ECS cluster's instance-family attribute from the AWS console / `aws ecs describe-container-instances`. Confirm what's running. Surface the answer here so this assumption either holds or T-1's scope changes.

---

## Verification commands (operator)

A short script to confirm the stream is done. Each command corresponds to one acceptance criterion above.

```bash
# T-1: arm64 image runs on Graviton
ssh ec2-user@<graviton-instance> \
  docker run --rm -e PASEO_CLOUD_MODE=1 -e ORCHESTRA_AUTH_JWKS_URL=https://example.invalid \
    <ecr>/paseo-daemon:dev-latest \
    sh -c "node -e 'console.log(process.arch)' && claude --version"
# Expect: arm64 + a semver, no segfault.

# T-2 + T-3: schema + emit primitive land green
cd paseo-fork
npx vitest run packages/server/src/server/cloud-webhook-events.test.ts --bail=1
npx vitest run packages/server/src/server/cloud-webhook-emit.test.ts --bail=1

# T-4: heartbeat loop fires (vi.fn() + fake timers unit test)
npx vitest run packages/server/src/server/cloud-heartbeat.test.ts --bail=1
# Hands-on (deployed): tail daemon.log for periodic
# "Heartbeat sent { activeAgents, connectedClients }" at ~30s cadence.
# Verify in DDB: aws dynamodb get-item --table orchestra-<stage>-state \
#   --key '{"pk":{"S":"<accountId>#heartbeat"},"sk":{"S":"<workspaceId>"}}' \
#   — expect a row whose lastHeartbeat is within the last 45s.

# T-5: per-spawn ~/.claude isolation (D-2 hands-on gate)
# Operator A's agent: "list /tmp/orchestra-claude-home" — expect only A's live spawn dir.
# Operator A's agent: "read Secrets Manager secret paseo-cloud/<B>/anthropic-credential"
#   — expect IAM AccessDeniedException in daemon.log; agent receives the
#   fail-loud error from cloud-credentials.ts:60-86.

# T-6: wire-boundary lint
rg "repoUrl|accountId" packages/server/src/shared/messages.ts
# Expect: 0 lines.
rg "PASEO_CLOUD|ORCHESTRA_CLOUD|ORCHESTRA_DEV" packages/server/src/ \
  | grep -v "paseo-env.ts"
# Expect: 0 lines.
rg "@orchestra/" packages/server/src/
# Expect: ≤4 lines (all source-comment annotations per LEARNINGS.md:2384).

# T-7: clean SIGTERM exit
docker run -d --rm --name paseo-test <ecr>/paseo-daemon:dev-latest
sleep 5
docker kill --signal SIGTERM paseo-test
# Within 30 s, container exits with code 0; no EBUSY in docker logs.

# T-9: image tag plumbed
docker build --build-arg PASEO_DAEMON_IMAGE_TAG=0.2.0-cloud.test123 -t paseo-daemon:tagtest .
docker run --rm paseo-daemon:tagtest env | grep PASEO_DAEMON_IMAGE_TAG
# Expect: PASEO_DAEMON_IMAGE_TAG=0.2.0-cloud.test123
# Deployed: DDB row versions#daemon/dev shows the real tag, not "unknown".

# T-10: auth-internal namespace alignment (after PLAN-auth-and-shared lands)
grep -rn "/api/internal/" packages/server/src/server/cloud-clone.ts packages/server/src/server/cloud-version-beacon.ts
# Expect: 0 lines after the rename (becomes /api/auth-internal/).

# Final D-2 hands-on gate (ROADMAP § Phase D-2, lines 164-174):
# - Two operators, two GitHub accounts, two workspaces, two agents.
# - Cross-tenant probes against Secrets Manager + DynamoDB + MCP all fail with IAM AccessDenied.
# - Archive workspace A; observe T-24h schedule registered in EventBridge Scheduler (proprietary infra-side check).
# - Force-fire the T-24h schedule (operator action via EventBridge console); observe lifecycle worker emit the webhook to its no-op subscriber.
```

---

## Risks / known-hard parts

1. **O-1 architecture decision is structural and load-bearing.** Choosing wrong here paints into a corner: architecture A locks in a "wake daemon on T-24h" pattern that's hard to undo once subscribers exist; architecture B locks in "AGPL primitive imported by proprietary code" that's mechanically easy to land but blurs the open-core boundary if not annotated carefully. Get this decided **before** T-3 ships.

2. **arm64 native-dep surface is wider than the explicit deps suggest.** `onnxruntime-node` (`onnxruntime-common`, `adm-zip`, `global-agent`) carries transitive native code via cmake-js postinstall. The Dockerfile uses `npm ci --ignore-scripts` (Dockerfile:48) so postinstalls are skipped — meaning the pre-bundled `bin/napi-v6/linux/arm64/onnxruntime_binding.node` is what gets used. Confirm by `ls node_modules/onnxruntime-node/bin/napi-v6/linux/arm64` inside the **built arm64 container** (not the host's node_modules). Same check for `sherpa-onnx-node` → `sherpa-onnx-linux-arm64` (which must install as the right optional dep when target platform is arm64).

3. **The on-host `workspaceId` vs cloud-tenant `workspaceId` collision is in 9 wire-schema sites.** The rename to `tenantId` is deferred to a separate sweep (LEARNINGS.md:2383). Until the rename, every new RPC schema must carry a comment in the cloud-tenant-id-bearing module explaining "this is the cloud tenant id, NOT the on-host worktree id; the on-host worktree id has the same field name in `messages.ts`; do not unify." Otherwise the next refactor hands a future engineer a footgun.

4. **D-1.5 left orphan paths on EBS.** LEARNINGS.md:2406 — `/workspace/ws_999faa26/.git-canonical/` from a deleted-but-not-GC'd D-1 workspace. The D-2 cutover transitions from "one shared EBS" to "per-workspace EBS" — the cutover script (PLAN-cdk-infra) needs to decide whether to migrate, dump, or ignore these legacy directories. Daemon stream cannot solve this alone; flag for PLAN-cdk-infra's cutover checklist.

5. **Webhook delivery has no daemon-side retry.** Day-1 design (T-3 acceptance) trusts EventBridge Scheduler to retry on failure. If the subscriber is up but slow (200ms latency, exponential backoff doesn't kick in), the no-op subscriber misses events. Day-1 acceptable because subscriber is a no-op. **Day-N hardening:** when a real subscriber attaches (per-account long-term agent memory feature per workspace-lifecycle.md:76-78), revisit retry semantics on the daemon emit side.

6. **The `provisionCloudClaudeHome` failure mode is fail-loud (`cloud-credentials.ts:170-174`).** Good. But the trigger ("not from authenticated WS dispatch") fires for any scheduled / loop / background spawn — and D-3 plans to add chat / schedule / loop persistence (ROADMAP:188-191). When the daemon background-fires a scheduled agent in cloud mode, the ALS `workspaceAuthStorage` won't be set; the credential fetch will fail. **This is a D-3 problem, not D-2** — but flag for early discovery: when D-3 starts, the first thing that breaks under cloud mode will be scheduled agents. Either the schedule fires inherit the workspace ALS context, or the daemon stores a long-lived credential alongside the schedule. Worth surfacing now so D-3 isn't surprised.

7. **`workspace.hard_delete_imminent` schema once published is forever.** The forward-compat hook IS the seam (workspace-lifecycle.md:80). Subscribers will write code against the exact wire shape from T-2's `WorkspaceHardDeleteImminentEventWireSchema`. Adding fields is backwards-compatible (`.optional()`); removing or renaming is not. Every reviewer of T-2 should treat the payload as "API of last resort" — closest thing the AGPL fork has to a public commitment to a wire shape outside the WS protocol.

---

## Deferred follow-ups (filed, not bundled)

Surfaced while planning; NOT in scope for this PR — same anti-bundle discipline D-1.5 closeout used.

1. **`tenantId` rename across the 9 cloud-tenant `workspaceId` sites.** LEARNINGS.md:2383 — depends on the proprietary side's decision (`@orchestra/cloud-shared` is the source). When that lands, the daemon follows.
2. **`/tmp/orchestra-claude-home` vs `/tmp/paseo-claude-home` doc/code mismatch.** ROADMAP § D-2 hands-on text uses the older `paseo-` prefix; the code shipped with `orchestra-`. Doc update next time the ROADMAP is touched.
3. **Anti-drift guard for AGPL ↔ proprietary duplicated schemas.** LEARNINGS.md:2398 + DEFERRED.md:16. D-2 adds two more duplicates (T-2's webhook event schema, T-4's archive-notify body). Worth a single sweep — but not in this PR per the no-bundle rule.
4. **Periodic JWKS re-warm on key rotation.** D-1.5 § "Deferred follow-ups" row 5 — pre-warm at boot only; rotation within `cacheMaxAge` is uncovered. D-2 doesn't change this; flag for D-3 when key-rotation drills land.
5. **Per-account archived-workspace cap.** workspace-lifecycle.md:126 — a user can create + archive thousands, racking up 30-day EBS rent. Quota story is in `statefulness-and-multitenancy.md` for active workspaces; archived caps are TBD. Likely owned by PLAN-auth-and-shared, not the daemon.
6. **Daemon's session-store cleanup on workspace delete.** LEARNINGS.md:2372 — D-1.5 left two-worktree drift in the client's local session store. T-7 above addresses the daemon's side (release FDs cleanly); the client store reset is PLAN-app.

---

## Summary

- **T-1** verify the arm64 image actually runs on Graviton hardware (the CI already builds arm64; what's unverified is runtime on a real `t4g.*` / `m7g.*` host). S.
- **T-2** publish the `WorkspaceHardDeleteImminentEvent` Zod schema in the AGPL fork — dual-schema (camelCase TS / snake_case wire), open-core annotated. S.
- **T-3** ship the outbound webhook emit primitive (HMAC, no retries, fire-and-forget) mirroring `cloud-version-beacon.ts`. S.
- **T-4** implement `writeHeartbeat()` / `startHeartbeatLoop()` in the daemon's cloud-mode state-store adapter; 30s HMAC POST to `/api/auth-internal/heartbeat` with `{ workspaceId, lastHeartbeat, activeAgents, connectedClients, daemonImageTag }`; identity from JWT ALS not the wire. M.
- **T-5** re-verify per-spawn `~/.claude` materialization isolation under per-workspace IAM scoping; harden the fail-loud branch in `cloud-credentials.ts:60-86`. S.
- **T-6** wire-boundary lint pass over `messages.ts` + new D-2 schemas. S.
- **T-7** D-1.5 carry-in: SIGTERM-clean release of `/workspace/<id>` FDs so EBS can detach. S.
- **T-8** D-1.5 carry-in confirmed NOT this stream (session-expiry handler → PLAN-app).
- **T-9** D-1.5 carry-in: plumb `PASEO_DAEMON_IMAGE_TAG` build-arg → `ENV` → ECS task definition. S.
- **T-10** D-1.5 carry-in: update outbound URLs after PLAN-auth-and-shared renames to `/api/auth-internal/*`. S.

**Hardest part:** none structural after the 2026-05-22 synthesis (O-1 → Architecture B, O-2 → DDB heartbeat, O-3 → cloud archive bypasses daemon — all locked). Remaining risk surface is implementation correctness of T-4's heartbeat loop (jitter, shutdown handling, failure-mode warn-and-continue), and arm64 native-dep coverage in T-1.

**Total estimate:** ~5–7 days of focused engineering (excluding cross-stream coordination), assuming the arm64 image already runs on Graviton today.
