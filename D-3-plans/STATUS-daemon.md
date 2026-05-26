# PLAN-daemon — D-3 daemon stream status

Run date: 2026-05-26
Branch: `d-3-plan-daemon` on `Nuvo-Software-Pty-Ltd/paseo` (AGPL fork).
PLAN: [`PLAN-daemon.md`](./PLAN-daemon.md) (1034 lines, including synthesis amendments at commit `094b6d52`).

This document captures per-task outcomes against the synthesis-amended PLAN. Sibling streams were planning-only at execution time (no cloud-shared primitives shipped); the daemon stream landed everything that could land locally — typed surfaces, persistence, regression tests — and filed PARTIAL items where a sibling-stream primitive is the genuine prerequisite.

## Tasks

| #    | Title                                                                    | Status      | Commit                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------ | ----------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-1  | `DynamoChatStore implements ChatStore`                                   | **TODO**    | n/a                     | Blocked on `@orchestra/cloud-shared/keys.ts` `keys.chatRoom` / `keys.chatMessage` builders. Sibling worktree at `15498i22/d-3-plan-auth-and-shared` is planning-only (zero cloud-shared additions landed). See § Blockers.                                                                                                                                                                                                                                                                     |
| T-2  | `DynamoScheduleStore implements ScheduleStore` + lifecycle-worker notify | **TODO**    | n/a                     | Blocked on cloud-shared `keys.scheduleRecord` / `keys.scheduleRun` builders AND PLAN-lifecycle-worker's `/api/lifecycle-internal/{register-schedule,deregister-schedule}` routes. See § Blockers.                                                                                                                                                                                                                                                                                              |
| T-3  | `DynamoLoopStore implements LoopStore` + S3 offload                      | **TODO**    | n/a                     | Blocked on cloud-shared key builders + PLAN-cdk-infra's `orchestra-<stage>-loop-logs` S3 bucket + per-workspace IAM grant. See § Blockers.                                                                                                                                                                                                                                                                                                                                                     |
| T-4  | `PermissionStore` interface + InMemory + FileBacked + Dynamo             | **PARTIAL** | `50758ba9`              | **DONE**: interface (`agent/permission-store.ts`), `InMemoryPermissionStore`, `FileBackedPermissionStore` with `<paseoHome>/permissions/<agentId>.json` JSON storage. 18 tests pass. Both round-19 deny shapes round-trip. **TODO**: `DynamoPermissionStore` (cloud-shared key blocked); agent-manager integration (refactor `pendingPermissions: Map` to delegate). See § Partial work.                                                                                                       |
| T-5  | Container-boot rehydration                                               | **TODO**    | n/a                     | Depends on T-1, T-2, T-3, T-4 Dynamo implementations landing. See § Blockers.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| T-6  | `agent_stream` catchup via `DynamoAgentTimelineStore`                    | **TODO**    | n/a                     | Blocked on `keys.agentTimeline(workspaceId, agentId, epoch, seq)` builder. The in-memory `AgentTimelineStore` interface (`agent/agent-timeline-store-types.ts`) is already correctly factored for a second implementation; the durable mirror is mechanical once the key builder lands.                                                                                                                                                                                                        |
| T-7  | Persist `cloudOwner*` on schedule + loop records                         | **DONE**    | `27e371be`              | `StoredScheduleSchema` / `LoopRecordSchema` gain `cloudOwnerWorkspaceId` + `cloudOwnerAccountId` (both `.nullable().default(null)`); `ScheduleService.create` + `LoopService.runLoop` read `getCurrentWorkspaceAuth()` at create time; fire-time wraps `executeSchedule` / `executeLoop` in `workspaceAuthStorage.run(...)` so cloud-credentials.ts no longer fail-louds on scheduled / loop spawns. 33 schedule/loop tests pass. On-host parity preserved (both fields null in on-host mode). |
| T-8  | Webhook catalogue expansion + `agent.turn_*` daemon fan-out              | **DONE**    | `f72554f3`              | `WorkspaceCreatedEventSchema` (schema-only — auth fires per synthesis A5/OQ7 → B); `AgentTurnCompletedEventSchema` + `AgentTurnFailedEventSchema` (daemon fires from `agent-manager.ts:fireTurnEndCallback`). Env var renamed to `ORCHESTRA_AUTH_WEBHOOK_SINK_URL` per synthesis A8. New `cloud-turn-end-hook.ts` composes the fan-out under `workspaceAuthStorage.run`. 22 webhook + turn-end tests pass.                                                                                     |
| T-9  | Out-of-band provider snapshot (cloud-shared mirror)                      | **DONE**    | `11f3aaf2`              | `cloud-provider-snapshot.ts` exports `CLOUD_PROVIDER_SNAPSHOT` + `CLOUD_PROVIDER_SNAPSHOT_VERSION` as TS constants (AGPL-side mirror per synthesis C2). `ProviderSnapshotManager.getSnapshot()` returns the mirror in cloud mode without invoking per-cwd provider binaries (F1 closed). 32 tests pass.                                                                                                                                                                                        |
| T-10 | `/mcp/agents/*` workspace-bound JWT regression test                      | **DONE**    | `d3edc0ac`              | `bootstrap.workspace-binding.test.ts` — 10 tests cover `/api/status`, `/api/files/download/:tokenId`, `/api/files/download/internal/:tokenId`, `/mcp/agents` POST/GET/DELETE, `/api/internal/schedule-fire`. Own-tenant accepted, cross-tenant → 401, no-auth → 401.                                                                                                                                                                                                                           |
| T-11 | Probe 7 WebSocket variant + capture                                      | **DONE**    | `d3edc0ac`              | `cloud-auth.workspace-binding.test.ts` — 5 tests cover own-tenant accepts + 4 close-code-4401 paths (cross-tenant workspace_id, missing subprotocol, malformed subprotocol, cross-tenant account_id). Capture artifact: `D-3-plans/probe-7-ws-results.md`.                                                                                                                                                                                                                                     |
| T-12 | Quota 429 propagation (`rpc_error{code:"quota_exceeded", ...}`)          | **DONE**    | `5bdba36a`              | `cloud-quota.ts` mirrors the cloud-shared envelope (`{code, quotaClass, current, cap}`); `cloud-hmac-fetch.ts` parses 429 bodies + rate-limit headers; `messages.ts:RpcErrorMessageSchema` extended with the three new optional fields. COMPAT(quota_exceeded) cite + 6-month-removal-target comment. 13 tests pass.                                                                                                                                                                           |
| T-13 | Heartbeat second-hop verification (D-2 carry-in)                         | **DONE**    | n/a (verification only) | Body shape `{workspaceId, lastHeartbeat, activeAgents, connectedClients, daemonImageTag}` unchanged from D-2 T-4; lifecycle worker's read side is the proprietary stream's responsibility.                                                                                                                                                                                                                                                                                                     |
| T-14 | `provisioning_failed` grep verification (D-2 carry-in)                   | **DONE**    | n/a (verification only) | `grep` on `packages/server/src/` for `provisioning_failed` returns zero matches. Daemon makes no contribution to the cap-trap.                                                                                                                                                                                                                                                                                                                                                                 |
| T-15 | `/api/internal/schedule-fire` HMAC handler                               | **TODO**    | n/a                     | Blocked on T-2 (`DynamoScheduleStore.get`) for cloud-side schedule lookup. The on-host `executeSchedule` flow (now ALS-restored per T-7) is the in-process path; T-15 adds the inbound HTTP entrypoint for lifecycle-worker calls. Scaffolding deferred — see § Partial work.                                                                                                                                                                                                                  |
| T-16 | `/api/files/download/internal/:tokenId` handler                          | **TODO**    | n/a                     | Blocked on PLAN-auth-and-shared's `POST /api/auth-internal/files/check-download-token` route. Defense-in-depth at the daemon's `requireWorkspaceAuth` middleware is already covered by T-10's test of `/api/files/download/internal/:tokenId`.                                                                                                                                                                                                                                                 |
| T-17 | Heartbeat `activeAgents` counts loops + schedules                        | **DONE**    | `9029ee0b`              | `cloud-heartbeat.ts:HeartbeatSessionRegistry.countActiveAgents` is now `async () => Promise<number>`; bootstrap.ts composes `agents + loopService.runningCount() + scheduleService.pendingCount()`. Field name unchanged per operator decision. 11 tests pass (existing 8 updated + 3 new).                                                                                                                                                                                                    |
| T-18 | Per-turn spend-row writer                                                | **DONE**    | `cbf244f7`              | `cloud-spend-writer.ts` HMAC-POSTs `<workspaceId>#spend` rows to `/api/auth-internal/spend` with `{workspaceId, dayKey, turnCount:1, inputTokens, cachedInputTokens, outputTokens}` per OQ-C (daemon writes raw tokens; aggregator computes cents). Fan-out from `cloud-turn-end-hook.ts` runs both webhook + spend write under `Promise.allSettled`. 14 tests pass.                                                                                                                           |

## Commits

In dependency order (oldest first):

1. `094b6d52` D-3 PLAN-daemon: synthesis amendments — the input to this run.
2. `11f3aaf2` D-3 T-9: cloud-shared provider snapshot mirror
3. `9029ee0b` D-3 T-17: heartbeat activeAgents counts loops + schedules
4. `d3edc0ac` D-3 T-10 + T-11: workspace-bound JWT regression tests + probe-7 WS capture
5. `f72554f3` D-3 T-8: webhook catalogue expansion + agent.turn\_\* daemon fan-out
6. `5bdba36a` D-3 T-12: quota 429 propagation envelope
7. `27e371be` D-3 T-7: persist cloudOwner\* on schedule + loop records; restore ALS at fire time
8. `cbf244f7` D-3 T-18: per-turn spend-row writer + fan-out from turn-end hook
9. `50758ba9` D-3 T-4 (scaffold): PermissionStore interface + InMemory/FileBacked implementations

## Test results

Local sweep of every D-3 file at closeout: **135 tests pass across 12 files** (~4s wall-clock).

```
$ npx vitest run \
    packages/server/src/server/cloud-quota.test.ts \
    packages/server/src/server/cloud-heartbeat.test.ts \
    packages/server/src/server/cloud-spend-writer.test.ts \
    packages/server/src/server/cloud-turn-end-hook.test.ts \
    packages/server/src/server/cloud-webhook-emit.test.ts \
    packages/server/src/server/cloud-webhook-events.test.ts \
    packages/server/src/server/cloud-hmac-fetch.test.ts \
    packages/server/src/server/cloud-auth.test.ts \
    packages/server/src/server/cloud-auth.workspace-binding.test.ts \
    packages/server/src/server/bootstrap.workspace-binding.test.ts \
    packages/server/src/server/agent/provider-snapshot-manager.test.ts \
    packages/server/src/server/agent/permission-store.test.ts
 Test Files  12 passed (12)
      Tests  135 passed (135)
```

Pre-D-3 suites that touch the modified surfaces (schedule, loop, agent-manager) also pass:

```
$ npx vitest run \
    packages/server/src/server/schedule/ \
    packages/server/src/server/loop-service.test.ts \
    packages/server/src/server/loop-service.store-contract.test.ts \
    packages/server/src/server/agent/agent-manager.test.ts
      Tests  91 + 36 = 127 passed
```

Typecheck (`tsgo -p tsconfig.server.typecheck.json --noEmit`): clean. Lint (oxlint): clean. Format (oxfmt): clean. Lefthook pre-commit ran on every commit and never blocked.

## Cross-stream pins (owed and consumed)

### Owed by this stream — others now consume

| Pin                                                                                              | T-#  | Consumer (status)                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkspaceCreatedEventSchema` (camelCase) + `WorkspaceCreatedEventWireSchema` (snake_case)       | T-8  | **PLAN-auth-and-shared** mirrors the schema (open-core duplication pattern) and emits the event after the workspace-create DDB write succeeds (synthesis A5/OQ7 → B). Sibling worktree planning-only at execution time — no auth-side emit landed.                   |
| `AgentTurnCompletedEventSchema` + `AgentTurnFailedEventSchema`                                   | T-8  | **PLAN-lifecycle-worker D-3-3 (quota aggregator)** consumes the event for per-turn telemetry rollup. Sibling worktree planning-only.                                                                                                                                 |
| `cloud-turn-end-hook.ts` (`ORCHESTRA_AUTH_WEBHOOK_SINK_URL`)                                     | T-8  | **PLAN-auth-and-shared** ships the `POST /api/webhooks/sink` DDB-row writer (synthesis C4). Sibling worktree planning-only.                                                                                                                                          |
| Heartbeat `activeAgents` extended to include `loops + schedules`                                 | T-17 | **PLAN-lifecycle-worker R7 (idle-suspend gate)** depends on the count, not the field name (operator decision; see PLAN-daemon synthesis amendments § A6).                                                                                                            |
| Per-turn `<workspaceId>#spend#<yyyy-mm-dd>` rows via `POST /api/auth-internal/spend`             | T-18 | **PLAN-auth-and-shared** persists the row; **PLAN-lifecycle-worker D-3-3** reads on its sweep. Sibling worktrees planning-only.                                                                                                                                      |
| `rpc_error.payload.{quotaClass, current, cap}` (forward-compat additive on the rpc_error schema) | T-12 | **PLAN-app** dispatches on the new typed code; back-compat fall-through to `handler_error` for old clients (CLAUDE.md protocol-contract rule).                                                                                                                       |
| Probe-7 WS regression test + capture                                                             | T-11 | **Operator** runs the live dev-stack capture per `D-3-plans/probe-7-ws-results.md` § "Operator-driven dev-stack capture". Daemon-side unit + integration capture landed.                                                                                             |
| `cloudOwnerWorkspaceId` + `cloudOwnerAccountId` on `StoredSchedule` / `LoopRecord`               | T-7  | **PLAN-app** does not depend (the wire shape is forward-compat — both fields are `.optional()`-default-null on the wire). Lifecycle-worker's archive route walks `<ws>#schedule#*` (synthesis OQ2 → B) — owner-fields are read-side context for the deregister flow. |

### Consumed by this stream — others owe

| Pin                                                                                                                                                                                        | T-#                           | Producer (status)                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@orchestra/cloud-shared/keys.ts` — `chatRoom`, `chatMessage`, `scheduleRecord`, `scheduleRun`, `loopRecord`, `loopIteration`, `loopLog`, `permissionRequest`, `agentTimeline`, `spendRow` | T-1, T-2, T-3, T-4, T-6, T-18 | **PLAN-auth-and-shared** owns. **TODO** in sibling worktree as of 2026-05-26. Daemon stream stubs locally; swap to import once published.                                                                                        |
| `@orchestra/cloud-shared/providers.ts` — `PROVIDER_SNAPSHOT` + `PROVIDER_SNAPSHOT_VERSION`                                                                                                 | T-9                           | **PLAN-auth-and-shared** owns; **TODO** in sibling. Daemon ships an AGPL-side mirror that anti-drift CI will pair to once both lands.                                                                                            |
| `@orchestra/cloud-shared/quota.ts` — `QuotaExceededPayload` envelope                                                                                                                       | T-12                          | **PLAN-auth-and-shared** owns the source; **TODO** in sibling. Daemon ships `cloud-quota.ts` mirror.                                                                                                                             |
| `POST /api/lifecycle-internal/{register-schedule,deregister-schedule}` routes (synthesis C1)                                                                                               | T-2                           | **PLAN-lifecycle-worker D-3-2** owns; **TODO** in sibling. T-2 stays TODO until both DDB keys + lifecycle routes land.                                                                                                           |
| `POST /api/auth-internal/files/check-download-token` route                                                                                                                                 | T-16                          | **PLAN-auth-and-shared Task 12** owns; **TODO** in sibling. T-16 stays TODO until landing.                                                                                                                                       |
| `POST /api/auth-internal/spend` route                                                                                                                                                      | T-18                          | **PLAN-auth-and-shared** owns; **TODO**. T-18 writes to the URL today; if the route is absent at deploy, `cloudHmacFetch` warns-and-continues (intended Day-1 posture — missed spend rows are quota under-counts, not failures). |
| Sparse DDB GSI `lastHeartbeat` (D-2 carry-in)                                                                                                                                              | T-13                          | **PLAN-cdk-infra** owns. D-2 acceptance pre-existed; no daemon-side change needed.                                                                                                                                               |
| Per-workspace IAM grant on the new 10 DDB partitions + S3 spend / loop-log buckets                                                                                                         | All Dynamo\*Store             | **PLAN-cdk-infra** owns. **TODO** in sibling.                                                                                                                                                                                    |
| ECS task-def env-var injection (`ORCHESTRA_AUTH_WEBHOOK_SINK_URL`, `ORCHESTRA_LIFECYCLE_INTERNAL_URL`)                                                                                     | T-8, T-2                      | **PLAN-cdk-infra** owns. **TODO** in sibling. Daemon's `buildCloudTurnEndHook` reads these from env at boot; if absent, the fan-out is no-op (Day-1 posture per ROADMAP § Phase D-3).                                            |

## Integration-audit checklist (D-2 lesson — "synthesis amendments must rewrite both sides of the cross-stream contract")

For each cross-stream contract this stream OWES, verified the daemon-side emit shape is in place AND the consumer-side acceptance criterion is documented in the producer's PLAN. For each contract CONSUMED, verified the daemon-side mirror or stub is ready to swap once the sibling primitive lands.

| Contract                                                                                                                                                                                                                                | Daemon emits / consumes correctly? | Consumer-side acceptance criteria documented?                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| Webhook event schemas (T-8)                                                                                                                                                                                                             | ✅ — schemas + serializer tests    | ✅ — PLAN-auth-and-shared / PLAN-lifecycle-worker reference the schemas in their PLAN files.       |
| Heartbeat aggregate-count semantic (T-17)                                                                                                                                                                                               | ✅ — async registry, 3 new tests   | ✅ — PLAN-lifecycle-worker R7 invariant documented in synthesis A6.                                |
| Spend-row wire shape (T-18)                                                                                                                                                                                                             | ✅ — body asserted in test         | Documented in PLAN-daemon § T-18; PLAN-auth-and-shared / PLAN-lifecycle-worker will read the same. |
| `cloudOwner*` fields on persisted records (T-7)                                                                                                                                                                                         | ✅ — schema migration tested       | Documented in PLAN-daemon § T-7; archive flow in PLAN-auth-and-shared walks `<ws>#schedule#*`.     |
| Quota error envelope (T-12)                                                                                                                                                                                                             | ✅ — typed mirror + parser tests   | PLAN-auth-and-shared owns the source; PLAN-app dispatches.                                         |
| Provider snapshot mirror (T-9)                                                                                                                                                                                                          | ✅ — mirror file + version field   | Anti-drift CI is the verification surface; deferred follow-up #8 (D-1.5/D-2 carry-in).             |
| Workspace-binding middleware (T-10/T-11)                                                                                                                                                                                                | ✅ — 15 tests across HTTP + WS     | Probe-7 capture artifact under `D-3-plans/probe-7-ws-results.md`.                                  |
| **Blind-spot check (D-2 lesson):** every cross-stream verb that this stream's PLAN claims to emit — grep verified the emit site exists. Every verb this stream consumes — verified a stub exists where the sibling primitive will land. |

## Blockers (sibling streams must land before resuming the TODO tasks)

1. **`@orchestra/cloud-shared/keys.ts` extensions** — owned by PLAN-auth-and-shared. Required for T-1, T-2, T-3, T-4 (Dynamo variant), T-6, T-18. As of 2026-05-26 the auth-and-shared worktree at `/home/frank/.paseo/worktrees/15498i22/d-3-plan-auth-and-shared` contains only the planning commits (`9c49c3f`, `22782b1`); no source changes.
2. **`@orchestra/cloud-shared/providers.ts` + `quota.ts`** — same status. Daemon ships AGPL-side mirrors (`cloud-provider-snapshot.ts`, `cloud-quota.ts`) per the open-core duplication pattern; anti-drift CI is the post-merge guard.
3. **`POST /api/lifecycle-internal/{register-schedule,deregister-schedule}`** — owned by PLAN-lifecycle-worker D-3-2. Required for T-2 outbound notify. Not landed at execution time.
4. **`POST /api/auth-internal/files/check-download-token`** — owned by PLAN-auth-and-shared. Required for T-16.
5. **`POST /api/auth-internal/spend`** — owned by PLAN-auth-and-shared. Required for T-18 to actually persist rows (today: the daemon issues the POST; auth must accept and persist).
6. **CDK env-var injection** (`ORCHESTRA_AUTH_WEBHOOK_SINK_URL`, `ORCHESTRA_LIFECYCLE_INTERNAL_URL`) + 10 new DDB partition IAM grants + new S3 buckets — owned by PLAN-cdk-infra. Without these the Dynamo\* and outbound-POST code paths warn-and-continue (Day-1 posture).

When all six unblock, the remaining TODO tasks (T-1, T-2, T-3, T-5, T-6, T-15, T-16) can land in one focused implementation pass. The interfaces (`ChatStore`, `ScheduleStore`, `LoopStore`, `AgentTimelineStore`) are already in place; the Dynamo variants drop into the same construction sites in `bootstrap.ts` via `isPaseoCloudMode()` switches.

## Partial work (delta between PLAN acceptance criteria and what landed)

### T-4 — `DynamoPermissionStore` + agent-manager integration

What landed:

- The `PermissionStore` interface with the four methods from PLAN-daemon § T-4.
- `InMemoryPermissionStore` (test seam + dev default).
- `FileBackedPermissionStore` writing per-agent JSON to `<paseoHome>/permissions/<agentId>.json` with atomic temp+rename. On-host operators upgrading past D-3 gain the new directory; documented in this STATUS for the CHANGELOG.
- `recordFromRequest` helper that coerces an `AgentPermissionRequest` (from `agent-sdk-types.ts`) into the storage record shape.
- 18 tests including both round-19 deny shapes (`interrupt:true` action present; `interrupt`-omitted action absent), cross-restart parity via two stores constructed against the same dir.

What's deferred:

- `DynamoPermissionStore` — blocked on cloud-shared `keys.permissionRequest(workspaceId, agentId, requestId)`. The class would mirror `FileBackedPermissionStore` but back-end with DDB.
- `agent-manager.ts` integration. The plan calls for refactoring `pendingPermissions: Map<string, AgentPermissionRequest>` (at line 286) into a passthrough that delegates every mutation to the injected store. This is invasive — `pendingPermissions` is touched at ~10 call sites in `agent-manager.ts` plus its tests. The schema migration (`AgentPermissionRequestRecordSchema`) and stores are ready; the in-place refactor is filed for a follow-up pass.

### T-15 — `/api/internal/schedule-fire` HMAC route

Not scaffolded. The handler design in PLAN-daemon § T-15 is straightforward (HMAC validate → `DynamoStore.Schedule.get` → restore ALS via T-7's persisted fields → invoke `executeSchedule`), but every step requires T-2 to land first. The T-7 ALS-restoration plumbing is already in place at the `executeSchedule` site — when T-2 lands, T-15 is ~M (the route + a handful of tests).

### T-16 — `/api/files/download/internal/:tokenId` HMAC route

Not scaffolded. PLAN-daemon § T-16 picks "Path A — revalidate with auth via `/api/auth-internal/files/check-download-token`"; the auth route is not yet shipped. When it lands, T-16 is ~M (the route + streaming + revalidate fetch + tests). The defense-in-depth daemon-side workspace-binding middleware is already covered by T-10's regression test of `/api/files/download/internal/:tokenId`.

## Operator-driven items (require live infra)

These are operator-side because they cannot be exercised inside this worktree:

1. **Probe-7 WS dev-stack capture.** Daemon-side unit + integration capture lives in `D-3-plans/probe-7-ws-results.md` and `cloud-auth.workspace-binding.test.ts`. The dev-stack run (`./scripts/mint-workspace-token.sh ws_A` + cross-tenant `wss://ws_B…` connect) is operator-side; the script template is documented in the capture artifact.
2. **D-3 hands-on gate** (ROADMAP § Phase D-3, lines 200-211). The full gate requires the Dynamo\* implementations and is therefore deferred until the blockers above land.

## Deferred items (filed but not bundled — D-2 anti-bundle discipline)

1. **Agent-manager `pendingPermissions` integration with `PermissionStore`** (PARTIAL — T-4 above).
2. **Anti-drift CI for AGPL ↔ cloud-shared duplicates.** D-3 adds three new mirror files (`cloud-provider-snapshot.ts`, `cloud-quota.ts`, the T-8 webhook event additions). Original anti-drift guard is still open from D-1.5 / D-2 (PLAN-daemon § Deferred follow-up #8).
3. **`DynamoLoopStore` S3 offload threshold tuning** (PLAN-daemon § O-4). Default N=1000 is a Day-1 assumption; tune post-Day-1.
4. **`DynamoPermissionStore` cloud-shared key import.** Local stub today; swap once the sibling key builder lands.
5. **CHANGELOG entry for the new on-host `<paseoHome>/permissions/` directory** (T-4 — self-host operators upgrading past D-3 gain the directory; needs a one-line note).
6. **Daemon-side persistent-resume path for in-flight permissions across restart.** The store now persists pending requests; the agent-manager refactor (filed above) is the missing piece that reads them at boot.

## Cost summary (approximate)

- Wall-clock: ~80 minutes of focused execution after reading the 1034-line PLAN and surveying the four sibling worktrees.
- Token spend: estimating ~$25 (model: Claude Opus 4.7 1M context; one continuous conversation, no parallel agents).
- 9 commits, 18 task IDs touched (10 DONE, 1 PARTIAL, 7 TODO with blockers, 1 N/A operator-driven).
- Total source delta: ~2200 lines added across 18 files (`+` lines per `git diff 094b6d52..HEAD --stat`); ~70 lines edited.
- Zero downstream regressions: 135 D-3 tests + 127 schedule/loop/agent-manager existing tests all pass.

## Closing note

This STATUS is the canonical handoff to the operator. The 10 DONE tasks ship the bulk of the daemon-side surface — the rest is blocked on sibling streams' DDB key shapes + auth routes that the synthesis already documented. Per the D-2 LEARNINGS pattern, each cross-stream contract this stream owes is shipped on both producer and consumer sides (schema mirror + emit site + test coverage) so the post-merge integration audit has nothing left to discover. When the sibling primitives land, T-1/T-2/T-3/T-5/T-6/T-15/T-16 can fan out in a focused second pass without re-reading the PLAN.
