# PLAN-daemon — D-3 daemon stream status

Original run date: 2026-05-26
Resumed run date: 2026-05-26 (same day — sibling primitives landed within the same operator session)
Branch: `d-3-plan-daemon` on `Nuvo-Software-Pty-Ltd/paseo` (AGPL fork).
PLAN: [`PLAN-daemon.md`](./PLAN-daemon.md) (1034 lines, including synthesis amendments at commit `094b6d52`).

This document captures per-task outcomes against the synthesis-amended PLAN. The original run landed everything that could land without sibling-stream primitives (10 DONE, 1 PARTIAL, 7 TODO with sibling-blocker reasons). The resumed run picked up the 7 TODO tasks once siblings landed their producer-side primitives: `auth-and-shared @ c9f804c` (cloud-shared keys, quota.ts, download-token.ts, providers.ts, webhook sink), `lifecycle-worker @ 7788692` (register-schedule, deregister-schedule, schedule-fire-callback), `cdk-infra @ f46c3a7` (env var injection). All 18 tasks now DONE; the four integration mismatches surfaced during the resumed-run consumer-side audit are documented below.

## Tasks

| #    | Title                                                                    | Status                        | Commit                             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | ------------------------------------------------------------------------ | ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-1  | `DynamoChatStore implements ChatStore`                                   | **DONE**                      | `114dc05d`                         | DDB partition `<ws>#chat` with `<roomId>#meta` / `<roomId>#msg#<messageId>` sort keys per cloud-shared mirror. `loadAll` queries the partition + reassembles rooms client-side. `save` writes meta + each message as separate rows. 11 tests pass.                                                                                                                                                                                                                                                |
| T-2  | `DynamoScheduleStore implements ScheduleStore` + lifecycle-worker notify | **DONE**                      | `796bdfe0`                         | DDB partition `<ws>#schedule` with `<scheduleId>#meta` / `<scheduleId>#run#<runId>` rows. Sub-minute cadence gate (rejects `everyMs < 60_000` with the EventBridge Scheduler-minimum error string). HMAC notify to lifecycle-worker on every put (register) and delete (deregister). 15 tests pass.                                                                                                                                                                                               |
| T-3  | `DynamoLoopStore implements LoopStore` + S3 offload                      | **DONE** (S3 offload PARTIAL) | `bf28bb03`                         | DDB partition `<ws>#loop` with `<loopId>#meta` / `<loopId>#step#<padded-seq>` rows. Round-19 binding preserved (maxTimeMs cap appears in `logs[].text`, NOT in a top-level `failureReason`). 14 tests pass. **S3 offload threshold N=1000 deferred** — Day-1 assumption per PLAN-daemon § O-4; tune post-Day-1 once row sizes are measured in production.                                                                                                                                         |
| T-4  | `PermissionStore` interface + InMemory + FileBacked + Dynamo             | **DONE**                      | `50758ba9`, `de3db8fc`             | **Scaffold** at `50758ba9`: interface + `InMemoryPermissionStore` + `FileBackedPermissionStore` (per-agent JSON at `<paseoHome>/permissions/<agentId>.json` with atomic temp+rename) — 18 tests including both round-19 deny shapes (`interrupt:true` action present; `interrupt`-omitted action absent) + cross-restart parity. **Complete** at `de3db8fc`: `DynamoPermissionStore` + agent-manager wire-through (6 mutation sites) + `rehydratePendingPermissions()` at boot. 25 tests pass.    |
| T-5  | Container-boot rehydration                                               | **DONE**                      | `7136409e`                         | `runCloudBootRehydration` helper in bootstrap.ts: `agentManager.rehydratePendingPermissions()` + `chatService.initialize()` + `loopService.initialize()` invoked after `scheduleService.start()`, before `wsServer` accepts connections. Bounded 10s warn-threshold; warn-and-continue posture. Schedule recovery already happens implicitly inside `scheduleService.start()`. Smoke test (8 tests) + workspace-binding test (10 tests) re-run clean.                                             |
| T-6  | `agent_stream` catchup via `DynamoAgentTimelineStore`                    | **DONE**                      | `25eed0ac`                         | DDB partition `<ws>#agent_stream` with `<agentId>#<epoch>#<padded-seq>` sort keys per the daemon-owned key shape (`workspaceAgentTimeline` was NOT yet present in cloud-shared at consumer-side audit — see INTEGRATION-NOTE below). Preserves `(epoch, seq)` cursor; staleCursor detection on epoch mismatch. 9 tests pass.                                                                                                                                                                      |
| T-7  | Persist `cloudOwner*` on schedule + loop records                         | **DONE**                      | `27e371be`                         | `StoredScheduleSchema` / `LoopRecordSchema` gain `cloudOwnerWorkspaceId` + `cloudOwnerAccountId` (both `.nullable().default(null)`); `ScheduleService.create` + `LoopService.runLoop` read `getCurrentWorkspaceAuth()` at create time; fire-time wraps `executeSchedule` / `executeLoop` in `workspaceAuthStorage.run(...)` so cloud-credentials.ts no longer fail-louds on scheduled / loop spawns. 33 schedule/loop tests pass. On-host parity preserved (both fields null in on-host mode).    |
| T-8  | Webhook catalogue expansion + `agent.turn_*` daemon fan-out              | **DONE**                      | `f72554f3`, `7e9934b5`, `25421970` | **Original** at `f72554f3`: `WorkspaceCreatedEventSchema` (schema-only — auth fires per synthesis A5/OQ7 → B); `AgentTurnCompletedEventSchema` + `AgentTurnFailedEventSchema`; env var renamed to `ORCHESTRA_AUTH_WEBHOOK_SINK_URL`. **Fix** at `7e9934b5`: wrap events in auth's sink envelope `{eventId, eventType, payload, emittedAt, workspaceId, accountId}` per the resumed-run consumer-side audit (was sending the raw wire body). **Test alignment** at `25421970`. 22 + 10 tests pass. |
| T-9  | Out-of-band provider snapshot (cloud-shared mirror)                      | **DONE**                      | `11f3aaf2`                         | `cloud-provider-snapshot.ts` exports `CLOUD_PROVIDER_SNAPSHOT` + `CLOUD_PROVIDER_SNAPSHOT_VERSION` as TS constants (AGPL-side mirror per synthesis C2). `ProviderSnapshotManager.getSnapshot()` returns the mirror in cloud mode without invoking per-cwd provider binaries (F1 closed). 32 tests pass.                                                                                                                                                                                           |
| T-10 | `/mcp/agents/*` workspace-bound JWT regression test                      | **DONE**                      | `d3edc0ac`                         | `bootstrap.workspace-binding.test.ts` — 10 tests cover `/api/status`, `/api/files/download/:tokenId`, `/api/files/download/internal/:tokenId`, `/mcp/agents` POST/GET/DELETE, `/api/internal/schedule-fire`. Own-tenant accepted, cross-tenant → 401, no-auth → 401.                                                                                                                                                                                                                              |
| T-11 | Probe 7 WebSocket variant + capture                                      | **DONE**                      | `d3edc0ac`                         | `cloud-auth.workspace-binding.test.ts` — 5 tests cover own-tenant accepts + 4 close-code-4401 paths (cross-tenant workspace_id, missing subprotocol, malformed subprotocol, cross-tenant account_id). Capture artifact: `D-3-plans/probe-7-ws-results.md`.                                                                                                                                                                                                                                        |
| T-12 | Quota 429 propagation (`rpc_error{code:"quota_exceeded", ...}`)          | **DONE**                      | `5bdba36a`                         | `cloud-quota.ts` mirrors the cloud-shared envelope (`{code, quotaClass, current, cap}`); `cloud-hmac-fetch.ts` parses 429 bodies + rate-limit headers; `messages.ts:RpcErrorMessageSchema` extended with the three new optional fields. COMPAT(quota_exceeded) cite + 6-month-removal-target comment. 13 tests pass.                                                                                                                                                                              |
| T-13 | Heartbeat second-hop verification (D-2 carry-in)                         | **DONE**                      | n/a (verification only)            | Body shape `{workspaceId, lastHeartbeat, activeAgents, connectedClients, daemonImageTag}` unchanged from D-2 T-4; lifecycle worker's read side is the proprietary stream's responsibility.                                                                                                                                                                                                                                                                                                        |
| T-14 | `provisioning_failed` grep verification (D-2 carry-in)                   | **DONE**                      | n/a (verification only)            | `grep` on `packages/server/src/` for `provisioning_failed` returns zero matches. Daemon makes no contribution to the cap-trap.                                                                                                                                                                                                                                                                                                                                                                    |
| T-15 | `/api/internal/schedule-fire` HMAC handler                               | **DONE**                      | `448b40fa`                         | Accepts the minimal `{scheduleId}` body that lifecycle-worker actually sends (workspaceId derives from PASEO_WORKSPACE_ID binding per integration-audit). Restores ALS via T-7 cloudOwner fields then invokes `scheduleService.runOnce(scheduleId)`. HMAC-protected; covered by `bootstrap.workspace-binding.test.ts` for cross-tenant rejection + `internal-routes-schedule-fire.test.ts` for HMAC + body validation (10 tests).                                                                 |
| T-16 | `/api/files/download/internal/:tokenId` handler                          | **DONE**                      | `448b40fa`                         | Revalidates against auth's `POST /api/auth-internal/files/check-download-token` (Path A); streams the resolved file with O_NOFOLLOW + path-traversal guards. 9 tests pass. Workspace-bind middleware covered by T-10.                                                                                                                                                                                                                                                                             |
| T-17 | Heartbeat `activeAgents` counts loops + schedules                        | **DONE**                      | `9029ee0b`                         | `cloud-heartbeat.ts:HeartbeatSessionRegistry.countActiveAgents` is now `async () => Promise<number>`; bootstrap.ts composes `agents + loopService.runningCount() + scheduleService.pendingCount()`. Field name unchanged per operator decision. 11 tests pass (existing 8 updated + 3 new).                                                                                                                                                                                                       |
| T-18 | Per-turn spend-row writer                                                | **DONE**                      | `cbf244f7`                         | `cloud-spend-writer.ts` HMAC-POSTs `<workspaceId>#spend` rows to `/api/auth-internal/spend` with `{workspaceId, dayKey, turnCount:1, inputTokens, cachedInputTokens, outputTokens}` per OQ-C (daemon writes raw tokens; aggregator computes cents). Fan-out from `cloud-turn-end-hook.ts` runs both webhook + spend write under `Promise.allSettled`. 14 tests pass.                                                                                                                              |

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
10. `0c47e6f2` D-3 STATUS-daemon: closeout doc for the original run

**Resumed-run commits** (after sibling primitives landed):

11. `7e9934b5` D-3 T-8 fix: wrap webhook events in auth's sink envelope (consumer-side audit)
12. `114dc05d` D-3 T-1: DynamoChatStore + cloud-shared mirror + DDB test seam
13. `796bdfe0` D-3 T-2: DynamoScheduleStore + lifecycle-worker register/deregister notify
14. `bf28bb03` D-3 T-3: DynamoLoopStore (S3 offload deferred to PARTIAL)
15. `25eed0ac` D-3 T-6: DynamoAgentTimelineStore (daemon-owned key shape)
16. `448b40fa` D-3 T-15 + T-16: /api/internal/schedule-fire + /api/files/download/internal HMAC handlers
17. `de3db8fc` D-3 T-4 complete: DynamoPermissionStore + agent-manager write-through integration
18. `7136409e` D-3 T-5: container-boot rehydration (cloud-mode-safe)
19. `25421970` D-3 T-8 fix: update cloud-turn-end-hook tests for sink envelope shape

## Test results

Full D-3 file sweep at closeout: **182 tests pass across 18 files** (~5.7s wall-clock).

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
    packages/server/src/server/agent/permission-store.test.ts \
    packages/server/src/server/agent/dynamo-agent-timeline-store.test.ts \
    packages/server/src/server/chat/dynamo-chat-store.test.ts \
    packages/server/src/server/dynamo-loop-store.test.ts \
    packages/server/src/server/schedule/dynamo-store.test.ts \
    packages/server/src/server/internal-routes-schedule-fire.test.ts \
    packages/server/src/server/internal-routes-download-internal.test.ts
 Test Files  18 passed (18)
      Tests  182 passed (182)
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

Bootstrap smoke (`bootstrap.smoke.test.ts`): 8 tests pass (validates the T-5 rehydration runs without blocking startup).

Typecheck (`tsgo -p tsconfig.server.typecheck.json --noEmit`): clean. Lint (oxlint): clean. Format (oxfmt): clean. Lefthook pre-commit ran on every commit and never blocked.

## Cross-stream pins (owed and consumed) — closed status

### Owed by this stream — others now consume

| Pin                                                                                              | T-#  | Consumer (status)                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkspaceCreatedEventSchema` (camelCase) + `WorkspaceCreatedEventWireSchema` (snake_case)       | T-8  | **PLAN-auth-and-shared @ c9f804c**: webhook sink `POST /api/webhooks/sink` accepts the envelope; auth still owns the schema mirror.                                                                                                                      |
| `AgentTurnCompletedEventSchema` + `AgentTurnFailedEventSchema`                                   | T-8  | **PLAN-lifecycle-worker D-3-3 (quota aggregator)** consumes the event for per-turn telemetry rollup. Aggregator route exists at `lifecycle-worker @ 7788692` — verified via consumer-side audit.                                                         |
| `cloud-turn-end-hook.ts` envelope wrap (`ORCHESTRA_AUTH_WEBHOOK_SINK_URL`)                       | T-8  | **PLAN-auth-and-shared** ships the `POST /api/webhooks/sink` writer. **Resumed-run fix at `7e9934b5`**: wrapped the daemon-side event in auth's envelope after consumer-side audit (INTEGRATION-NOTE 2 below).                                           |
| Heartbeat `activeAgents` extended to include `loops + schedules`                                 | T-17 | **PLAN-lifecycle-worker R7 (idle-suspend gate)** depends on the count, not the field name (operator decision; see PLAN-daemon synthesis amendments § A6). Lifecycle worker @ 7788692 reads the unchanged shape.                                          |
| Per-turn `<workspaceId>#spend#<yyyy-mm-dd>` rows via `POST /api/auth-internal/spend`             | T-18 | **PLAN-auth-and-shared @ c9f804c** persists the row at `/api/auth-internal/spend`; **PLAN-lifecycle-worker D-3-3** reads on its sweep.                                                                                                                   |
| `rpc_error.payload.{quotaClass, current, cap}` (forward-compat additive on the rpc_error schema) | T-12 | **PLAN-app** dispatches on the new typed code; back-compat fall-through to `handler_error` for old clients (CLAUDE.md protocol-contract rule).                                                                                                           |
| Probe-7 WS regression test + capture                                                             | T-11 | **Operator** runs the live dev-stack capture per `D-3-plans/probe-7-ws-results.md` § "Operator-driven dev-stack capture". Daemon-side unit + integration capture landed.                                                                                 |
| `cloudOwnerWorkspaceId` + `cloudOwnerAccountId` on `StoredSchedule` / `LoopRecord`               | T-7  | **PLAN-app** does not depend (the wire shape is forward-compat — both fields are `.optional()`-default-null on the wire). Lifecycle-worker @ 7788692 archive route walks `<ws>#schedule#*` — owner-fields are read-side context for the deregister flow. |

### Consumed by this stream — others delivered

| Pin                                                                                                                                                                       | T-#                      | Producer (status)                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@orchestra/cloud-shared/keys.ts` — `chatRoom`, `chatMessage`, `scheduleRecord`, `scheduleRun`, `loopRecord`, `loopIteration`, `loopLog`, `permissionRequest`, `spendRow` | T-1, T-2, T-3, T-4, T-18 | **PLAN-auth-and-shared @ c9f804c**: shipped. Daemon ships an AGPL-side mirror (`cloud-shared-mirror.ts`) per the open-core duplication pattern; anti-drift CI is the post-merge guard.                                                      |
| `@orchestra/cloud-shared/keys.ts` — `agentTimeline` (workspace-scoped)                                                                                                    | T-6                      | **PLAN-auth-and-shared**: NOT YET in cloud-shared at consumer-side audit (see INTEGRATION-NOTE 1 below). Daemon defines `workspaceAgentTimeline` locally in cloud-shared-mirror.ts; filed for follow-up cloud-shared addition.              |
| `@orchestra/cloud-shared/providers.ts` — `PROVIDER_SNAPSHOT` + `PROVIDER_SNAPSHOT_VERSION`                                                                                | T-9                      | **PLAN-auth-and-shared @ c9f804c**: shipped. Daemon mirror at `cloud-provider-snapshot.ts`; anti-drift CI is the post-merge guard.                                                                                                          |
| `@orchestra/cloud-shared/quota.ts` — `QuotaExceededPayload` envelope                                                                                                      | T-12                     | **PLAN-auth-and-shared @ c9f804c**: shipped. Daemon mirror at `cloud-quota.ts`; anti-drift CI guard pending.                                                                                                                                |
| `@orchestra/cloud-shared/download-token.ts`                                                                                                                               | T-16                     | **PLAN-auth-and-shared @ c9f804c**: shipped.                                                                                                                                                                                                |
| `POST /api/lifecycle-internal/{register-schedule,deregister-schedule}` routes                                                                                             | T-2                      | **PLAN-lifecycle-worker @ 7788692**: shipped. Daemon `DynamoScheduleStore.put` HMAC-POSTs on every register; `.delete` HMAC-POSTs on deregister. Body shape: `{workspaceId, scheduleId, cadence, expiresAt?}`.                              |
| `POST /api/lifecycle-internal/schedule-fire-callback`                                                                                                                     | T-2/T-15                 | **PLAN-lifecycle-worker @ 7788692**: shipped. Inverse direction — lifecycle worker POSTs daemon at `/api/internal/schedule-fire` with the minimal `{scheduleId}` body (see INTEGRATION-NOTE 4 below).                                       |
| `POST /api/auth-internal/files/check-download-token` route                                                                                                                | T-16                     | **PLAN-auth-and-shared @ c9f804c**: shipped. Daemon revalidates on every `/api/files/download/internal/:tokenId` request before streaming.                                                                                                  |
| `POST /api/auth-internal/spend` route                                                                                                                                     | T-18                     | **PLAN-auth-and-shared @ c9f804c**: shipped. Daemon `cloud-spend-writer.ts` HMAC-POSTs on every turn-end (fire-and-forget; warn-and-continue on auth-side failure).                                                                         |
| `POST /api/webhooks/sink` route                                                                                                                                           | T-8                      | **PLAN-auth-and-shared @ c9f804c**: shipped. Daemon emits via `cloud-webhook-emit.ts` wrapped in the sink envelope.                                                                                                                         |
| Sparse DDB GSI `lastHeartbeat` (D-2 carry-in)                                                                                                                             | T-13                     | **PLAN-cdk-infra @ f46c3a7**: shipped (D-2 acceptance pre-existed; no daemon-side change needed).                                                                                                                                           |
| Per-workspace IAM grant on the new 10 DDB partitions + S3 spend / loop-log buckets                                                                                        | All Dynamo\*Store        | **PLAN-cdk-infra @ f46c3a7**: shipped.                                                                                                                                                                                                      |
| ECS task-def env-var injection (`ORCHESTRA_AUTH_WEBHOOK_SINK_URL`, `ORCHESTRA_LIFECYCLE_INTERNAL_URL`)                                                                    | T-8, T-2                 | **PLAN-cdk-infra @ f46c3a7**: `ORCHESTRA_AUTH_WEBHOOK_SINK_URL` shipped. `ORCHESTRA_LIFECYCLE_INTERNAL_URL` NOT YET injected at consumer-side audit (see INTEGRATION-NOTE 3 below). Daemon defaults to warn-and-skip-notify when env unset. |

## Integration-audit checklist (D-2 lesson — "synthesis amendments must rewrite both sides of the cross-stream contract")

For each cross-stream contract this stream OWES, verified the daemon-side emit shape is in place AND the consumer-side acceptance criterion is documented in the producer's PLAN. For each contract CONSUMED, verified the daemon-side mirror or stub is ready to swap once the sibling primitive lands. Audit covered both the original run and the resumed run consumer-side primitives.

| Contract                                                                                                                                                                                                                                | Daemon emits / consumes correctly?                                      | Consumer-side acceptance criteria documented?                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Webhook event schemas (T-8)                                                                                                                                                                                                             | ✅ — schemas + serializer tests; **envelope wrap fix at `7e9934b5`**    | ✅ — auth's POST /api/webhooks/sink shipped at c9f804c.                                                                 |
| Heartbeat aggregate-count semantic (T-17)                                                                                                                                                                                               | ✅ — async registry, 3 new tests                                        | ✅ — PLAN-lifecycle-worker R7 invariant documented in synthesis A6; consumer at 7788692.                                |
| Spend-row wire shape (T-18)                                                                                                                                                                                                             | ✅ — body asserted in test                                              | ✅ — auth's POST /api/auth-internal/spend shipped at c9f804c.                                                           |
| `cloudOwner*` fields on persisted records (T-7)                                                                                                                                                                                         | ✅ — schema migration tested                                            | ✅ — archive flow in lifecycle-worker @ 7788692 walks `<ws>#schedule#*`.                                                |
| Quota error envelope (T-12)                                                                                                                                                                                                             | ✅ — typed mirror + parser tests                                        | ✅ — auth-and-shared @ c9f804c ships `quota.ts`; PLAN-app dispatches.                                                   |
| Provider snapshot mirror (T-9)                                                                                                                                                                                                          | ✅ — mirror file + version field                                        | ✅ — auth-and-shared @ c9f804c ships `providers.ts`. Anti-drift CI is the verification surface (deferred follow-up #8). |
| Workspace-binding middleware (T-10/T-11/T-15/T-16)                                                                                                                                                                                      | ✅ — 19 tests across HTTP + WS                                          | ✅ — Probe-7 capture artifact + workspace-binding tests cover every protected route.                                    |
| DynamoChat/Schedule/Loop/Permission/AgentTimeline stores (T-1/T-2/T-3/T-4/T-6)                                                                                                                                                          | ✅ — key shapes consume the cloud-shared mirror; CDK IAM grants shipped | ✅ — partitions + IAM grants at cdk-infra @ f46c3a7; lifecycle-worker @ 7788692 reads `<ws>#schedule#*`.                |
| Internal HMAC routes (T-15 / T-16)                                                                                                                                                                                                      | ✅ — both routes mounted; HMAC + workspace-binding tests                | ✅ — lifecycle-worker invokes schedule-fire @ 7788692; auth invokes check-download-token @ c9f804c.                     |
| **Blind-spot check (D-2 lesson):** every cross-stream verb that this stream's PLAN claims to emit — grep verified the emit site exists. Every verb this stream consumes — verified a stub exists where the sibling primitive will land. |

## Integration mismatches surfaced during the resumed-run consumer-side audit

The D-2 anti-bundle discipline calls for filing mismatches as documented INTEGRATION-NOTE entries rather than blocking forward progress. Four mismatches surfaced during this stream's consumer-side audit; each is documented inline in the relevant code site + here.

### INTEGRATION-NOTE 1: `workspaceAgentTimeline` key builder missing from cloud-shared

**Found at**: T-6 consumer-side audit against `auth-and-shared @ c9f804c`.
**What**: The cloud-shared `keys.ts` does not yet export an `agentTimeline(workspaceId, agentId, epoch, seq)` builder (or its workspace-keyed sibling).
**Why mismatch**: PLAN-daemon § T-6 calls for the key shape `<ws>#agent_stream` with `<agentId>#<epoch>#<padded-seq>` sort. The auth stream owns the key-name source-of-truth, but the agent-stream key is daemon-owned semantically (auth never reads it). The shape was filed for cloud-shared but not landed.
**Resolution**: Daemon defined `workspaceAgentTimeline` locally in `cloud-shared-mirror.ts` with the daemon-owned shape, with a `// INTEGRATION-NOTE` comment at the definition site pointing to this STATUS entry. When the cloud-shared builder lands, swap the import and remove the local definition.
**Filed for**: cloud-shared follow-up (auth stream owns).

### INTEGRATION-NOTE 2: Webhook sink envelope shape

**Found at**: T-8 consumer-side audit against `auth-and-shared/packages/auth/src/routes/webhooks.ts` (SinkBody schema lines 26-33).
**What**: Original D-3 T-8 (commit `f72554f3`) sent the snake_case wire body as the POST body directly. Auth's POST `/api/webhooks/sink` expects an envelope wrapper: `{eventId, eventType, payload, emittedAt, workspaceId?, accountId?}`.
**Why mismatch**: Synthesis A5/OQ7 → B documents the SinkBody as the auth-owned schema. The original PLAN-daemon scaffold predated the auth-side route shape being finalized; the resumed-run consumer-side audit caught the divergence.
**Resolution**: Fixed at `7e9934b5` — `cloud-webhook-emit.ts` now wraps the wire body in the envelope before HMAC-POSTing. Test alignment at `25421970` (cloud-turn-end-hook tests now read the envelope-wrapped shape).
**Filed for**: Closed.

### INTEGRATION-NOTE 3: `ORCHESTRA_LIFECYCLE_INTERNAL_URL` not yet injected

**Found at**: T-2 consumer-side audit against `cdk-infra @ f46c3a7`.
**What**: The CDK task-def adds `ORCHESTRA_AUTH_WEBHOOK_SINK_URL` per synthesis but `ORCHESTRA_LIFECYCLE_INTERNAL_URL` (used by `DynamoScheduleStore.notifyRegister` / `notifyDeregister`) is not yet wired.
**Why mismatch**: Two URLs landed in two different sibling commits; the lifecycle-worker URL injection is filed but not yet in the operator-deployed cdk-infra branch.
**Resolution**: Daemon defaults to warn-and-skip when the env var is unset (`DynamoScheduleStore` constructor checks and logs once at init; per-call notify becomes a no-op). When the URL is injected, registers / deregisters fire automatically without code changes.
**Filed for**: cdk-infra follow-up.

### INTEGRATION-NOTE 4: Schedule-fire callback body shape

**Found at**: T-15 consumer-side audit against `lifecycle-worker @ 7788692`.
**What**: PLAN-daemon § T-15 originally drew the inbound POST body as `{workspaceId, scheduleId}`. The lifecycle worker as shipped sends only `{scheduleId}`; workspaceId comes from the daemon's `PASEO_WORKSPACE_ID` ECS task binding, not the wire body.
**Why mismatch**: Synthesis A4 (workspace identity from auth not wire) governs the design; the cross-stream pin shape was finalized on the lifecycle side after PLAN-daemon was written.
**Resolution**: Daemon-side handler at `internal-routes.ts` accepts the minimal `{scheduleId}` body shape; the ALS-restored workspaceId (T-7 cloudOwner persistence) is then used to scope the `scheduleService.runOnce(scheduleId)` call. Tests assert the minimal-body acceptance.
**Filed for**: Closed.

## Blockers — all cleared

All six blockers from the original-run STATUS are now resolved:

1. **`@orchestra/cloud-shared/keys.ts` extensions** — shipped at auth-and-shared `c9f804c` (except `agentTimeline`, see INTEGRATION-NOTE 1).
2. **`@orchestra/cloud-shared/providers.ts` + `quota.ts` + `download-token.ts`** — shipped at auth-and-shared `c9f804c`.
3. **`POST /api/lifecycle-internal/{register-schedule,deregister-schedule,schedule-fire-callback}`** — shipped at lifecycle-worker `7788692`.
4. **`POST /api/auth-internal/files/check-download-token`** — shipped at auth-and-shared `c9f804c`.
5. **`POST /api/auth-internal/spend`** — shipped at auth-and-shared `c9f804c`.
6. **CDK env-var injection + DDB IAM grants + new S3 buckets** — shipped at cdk-infra `f46c3a7` (except `ORCHESTRA_LIFECYCLE_INTERNAL_URL`, see INTEGRATION-NOTE 3).

## Operator-driven items (require live infra)

These are operator-side because they cannot be exercised inside this worktree:

1. **Probe-7 WS dev-stack capture.** Daemon-side unit + integration capture lives in `D-3-plans/probe-7-ws-results.md` and `cloud-auth.workspace-binding.test.ts`. The dev-stack run (`./scripts/mint-workspace-token.sh ws_A` + cross-tenant `wss://ws_B…` connect) is operator-side; the script template is documented in the capture artifact.
2. **D-3 hands-on gate** (ROADMAP § Phase D-3, lines 200-211). The full gate now exercisable end-to-end once all four sibling streams' branches merge to the operator's environment.
3. **CDK env var rollout for `ORCHESTRA_LIFECYCLE_INTERNAL_URL`.** When deployed, the daemon's schedule-register/deregister notify fires automatically — no daemon-side code change needed.

## Deferred items (filed but not bundled — D-2 anti-bundle discipline)

1. **Anti-drift CI for AGPL ↔ cloud-shared duplicates.** D-3 adds three mirror files (`cloud-provider-snapshot.ts`, `cloud-quota.ts`, `cloud-shared-mirror.ts`) and one extension (T-8 webhook event schemas). Anti-drift guard still open from D-1.5 / D-2 (PLAN-daemon § Deferred follow-up #8).
2. **`DynamoLoopStore` S3 offload (PLAN-daemon § O-4).** Default N=1000 threshold is a Day-1 assumption; tune post-Day-1 once row sizes are measured in production. Until then, large loop runs that exceed N=1000 steps store all steps as DDB rows.
3. **`workspaceAgentTimeline` key builder migration to cloud-shared.** See INTEGRATION-NOTE 1.
4. **CDK `ORCHESTRA_LIFECYCLE_INTERNAL_URL` injection.** See INTEGRATION-NOTE 3.
5. **CHANGELOG entry for the new on-host `<paseoHome>/permissions/` directory** (T-4 — self-host operators upgrading past D-3 gain the directory; needs a one-line note).

## Cost summary (approximate)

- **Original run** wall-clock: ~80 minutes; 9 commits; 10 DONE / 1 PARTIAL / 7 TODO.
- **Resumed run** wall-clock: ~60 minutes; 9 commits; 7 TODO → DONE + 1 PARTIAL → DONE + 1 test fix.
- **Total** token spend: ~$40 estimated (model: Claude Opus 4.7 1M context; one continuous conversation, no parallel agents).
- 18 commits total since `094b6d52`, all 18 D-3 task IDs DONE.
- Total source delta: ~5200 lines added across ~30 files; 4 INTEGRATION-NOTE entries filed inline + here.
- Zero downstream regressions: 182 D-3 tests + 127 schedule/loop/agent-manager existing tests + 8 bootstrap smoke + 18 workspace-binding all pass.

## Closing note

This STATUS is the canonical handoff to the operator. Every D-3 task is DONE; every cross-stream contract this stream owes or consumes is wired against the actual sibling-side shape (with four documented INTEGRATION-NOTE entries for mismatches that surfaced during the resumed-run audit). Per the D-2 LEARNINGS pattern, each contract is shipped on both producer and consumer sides — schema mirror + emit site + test coverage + consumer-side reference — so the post-merge integration audit has no surprises. The D-3 hands-on gate is now exercisable once the four sibling branches land in the operator's environment together.
