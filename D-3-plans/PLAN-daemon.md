# PLAN-daemon.md — Phase D-3 daemon-side stream

Scope: the AGPL daemon (this fork, `Nuvo-Software-Pty-Ltd/paseo` on branch `d-3-plan-daemon`) contributions to D-3 "Day-1 wire-surface completion." Other streams (PLAN-app, PLAN-auth-and-shared, PLAN-lifecycle-worker, PLAN-cdk-infra) carry the client UX, auth-service routes + shared schemas, async lifecycle worker, and infra/CDK respectively. Cross-references to those streams live in § "Cross-stream dependencies."

D-3 architectural choices already locked (IMPLEMENTATION-ROADMAP.md:180-213, § "Architectural design-outs"; LEARNINGS.md 2026-05-22 forward-compat hook decision):

- Day-1 wire-surface families that flip from on-host file-store to cloud-store: **chat**, **schedule**, **loop**, **permission**. Backing store choice per family is **DynamoDB** behind the injected `Store` interface seam landed in D-1.
- `agent_stream` is the core push channel; reconnect after disconnect resumes the timeline at the right `(epoch, seq)` cursor (catalog/agent-stream.md "Resumption / reconnection"). The local `InMemoryAgentTimelineStore` is the active read path inside the workspace's daemon container; D-3 must add a cross-instance / cross-restart catchup story.
- **Schedule + loop firing while a workspace is suspended** is the lifecycle worker's job (EventBridge Scheduler register/deregister on schedule create/update/delete; cross-stream pin from PLAN-lifecycle-worker). The daemon supplies the DDB shape; the worker fires.
- **Webhook events** — `workspace.created`, `agent.turn_completed`, `workspace.hard_delete_imminent`, etc. — fire from the AGPL core. The forward-compat seam for `workspace.hard_delete_imminent` shipped in D-2 (T-2/T-3 in this stream's prior plan: `cloud-webhook-events.ts`, `cloud-webhook-emit.ts`). D-3 expands the catalogue and the seam.
- **Out-of-band provider snapshot.** F1 from the prior-attempt postmortem. The catalog is NOT pulled from a running daemon container; the daemon reads from a deployment-side source (env-var URL pointing at S3 / static manifest) and caches.
- **Per-spawn `/tmp/paseo-claude-home/<spawn-id>/.claude/config.json` materialization.** Code shipped in D-1 (`cloud-credentials.ts:106-159`, code path uses `/tmp/orchestra-claude-home/...`). D-3 must extend the seam to scheduled / loop / persistent-resume spawns — the cloud-auth.ts ALS hand-off note (`cloud-auth.ts:132-137`) explicitly punts this to D-3: "later phases (D-3) will persist workspace ownership with the schedule/loop records and restore context at fire time."
- **`/mcp/agents/*` workspace-bound JWT enforcement.** Defense-in-depth; mirrors paseo PR #5's `claims.workspace_id === PASEO_WORKSPACE_ID` binding (which today covers HTTP via `createRequireWorkspaceMiddleware` and WS upgrades via `createJwksWorkspaceAuthCallback` — D-2 ACCEPTANCE entry, LEARNINGS.md:2657-2700). Confirm the same callback is wired to MCP inbound; add a regression test.
- **Quota header propagation.** When `/api/auth-internal/*` (auth) returns 429 with rate-limit headers, the daemon surfaces this as a WS `rpc_error` with an appropriate code so the app can dispatch on it.

D-2 carryover into D-3 scope (small):

- **Probe 7 WebSocket variant** (LEARNINGS.md 2026-05-25 "What's still uncertain / deferred for D-3+"). D-2 ACCEPTANCE verified HTTP `/api/status` rejects cross-tenant tokens (probe 7a/7b → 401); the WS upgrade variant was not explicitly captured. Add a regression test + capture artifact.

Roadmap citations:

- `paseo-cloud-daemon/IMPLEMENTATION-ROADMAP.md:180-213` — D-3 work-stream list ("Day-1 wire-surface completion").
- `paseo-cloud-daemon/IMPLEMENTATION-ROADMAP.md:255-271` — Architectural design-outs (F1 out-of-band provider snapshot; F3 workspace-identity-from-auth; F9 one-writer-per-side-effect; F11 one cloud mode).
- `paseo-cloud-daemon/90-cloud-considerations/statefulness-and-multitenancy.md:90-109` — chat / schedule / loop persistence: the injected `Store` model + the per-store DDB row shapes (planned at D-3).
- `paseo-cloud-daemon/90-cloud-considerations/subprocess-isolation.md:142-158` — per-spawn credential materialization properties; binding for D-3's scheduled / loop / background spawn flows.
- `paseo-cloud-daemon/90-cloud-considerations/observability.md:43-75` — per-tenant CloudWatch metrics + log-group naming convention (read-only here; PLAN-cdk-infra owns the infra).
- `paseo-cloud-daemon/90-cloud-considerations/open-core-architecture.md:48-83` — integration interfaces (webhook outbound; auth callback; feature-gating callback; observability sink).
- `paseo-cloud-daemon/90-cloud-considerations/workspace-lifecycle.md:53-85` — hard-delete sequence and the `workspace.hard_delete_imminent` event payload.
- `paseo-cloud-daemon/10-interfaces/websocket/catalog/{chat,schedule,loop,permission,agent-stream}.md` — **round-19 BINDING wire shapes** that D-3's DynamoStore implementations must round-trip. Specific bindings cited per-task below.
- `paseo-cloud-daemon/LEARNINGS.md` 2026-05-22 → 2026-05-25 entries — D-2 closeout, deploy recovery, ship-gate, ACCEPTANCE post-mortem, operator UAT. The D-3 stream inherits ~6 carry-in items surfaced during D-2 (filed per-task below).
- `D-2-plans/PLAN-daemon.md` (this worktree) + `D-2-plans/STATUS.md` — what shipped at D-2 closeout; D-3 builds on top of T-2/T-3 (webhook schema + emit primitive), T-4 (heartbeat loop), T-5 (per-spawn home), T-10 (auth-internal namespace), and the design-out lint.

---

## Stream summary

What this stream owns:

1. **DynamoStore implementations** for `ChatStore`, `ScheduleStore`, `LoopStore`, **plus a new PermissionStore** (the on-host queue is in-memory only — see `permission.md` § "Persistence"; D-3 introduces durable persistence to survive container respawn cross-instance, including the round-19 `interrupt:true` and `interrupt`-omitted deny shapes).
2. **Container-boot rehydration** wiring — on cloud-mode boot, the daemon reads DDB for the workspace and populates the in-memory state of chat / schedule / loop / permission services + the agent record set (for the schedule-target / loop-cwd / permission-agent resolvers to work). Active read/write stays on the local FS (`/paseo`) per `statefulness-and-multitenancy.md:46-50`; DDB is the snapshot + cross-instance lookup index.
3. **`agent_stream` catchup** — define + ship the "resume at `(epoch, seq)` after disconnect / container respawn" path. Today's `fetch_agent_timeline_request` reads the local `InMemoryAgentTimelineStore`; D-3 extends it so a cross-restart resume reads the durable DDB-backed timeline rows (the per-record EBS + DDB index already exists for agent records per `statefulness-and-multitenancy.md:69`).
4. **Webhook event catalogue expansion + emit primitive reuse.** The D-2 primitive (`cloud-webhook-emit.ts`) emits the `workspace.hard_delete_imminent` event today. D-3 adds the `workspace.created` and `agent.turn_completed` events (per `open-core-architecture.md:56-60`), wires the daemon-side emit point for `agent.turn_completed` (turn-end hook in `agent-manager.ts`), and keeps the Day-1 sink as a no-op log writer per ROADMAP § Phase D-3.
5. **Out-of-band provider snapshot consumer.** F1 fix. The daemon reads the snapshot from a deployment-injected source (env-var URL OR bundled JSON in the daemon image), caches in `ProviderSnapshotManager` (`agent/provider-snapshot-manager.ts:33`), refreshes on a TTL. The daemon does NOT fetch the catalog from another container.
6. **Per-spawn `~/.claude` materialization for non-WS spawn origins.** Extend `cloud-credentials.ts:165-181` (`provisionCloudClaudeHome`) so scheduled / loop / persistent-resume runs find a workspace context. Two halves: (a) persist `workspaceId` + `accountId` alongside the schedule / loop / agent record at create time (single writer is the AGPL service in cloud mode; the value comes from the ALS at create-time, not from the wire — F3 preserved); (b) restore the ALS context at fire time before invoking the spawn.
7. **`/mcp/agents/*` workspace-bound JWT enforcement.** Confirm the daemon's existing `requireWorkspaceAuth` middleware (bootstrap.ts:454-458) is mounted before the `/mcp/agents` route handlers (bootstrap.ts:896-898). Add a regression test that an MCP HTTP request with a cross-workspace JWT is 401'd at the daemon, not just at the cloud network (SG/PrivateLink — PLAN-cdk-infra's defense-in-depth-layer).
8. **Quota / 429 propagation.** When the daemon's outbound HMAC POSTs (heartbeat / version beacon / webhook emit / workspace-create / schedule-create) receive `429 Too Many Requests` from the auth service with rate-limit headers, surface to active WS sessions as a `rpc_error` with code `quota_exceeded` (NEW typed code; mirrors the chat-family typed codes, not the schedule-family generic `*_request_failed`).
9. **D-2 ACCEPTANCE carry-ins** — three specific items from LEARNINGS § "What's still uncertain / deferred for D-3+" (2026-05-25 + the operator UAT entry) that land on the AGPL fork.

What this stream does NOT own (cross-stream — see § "Cross-stream dependencies"):

- DDB table schemas / partition-key + sort-key construction → PLAN-auth-and-shared (extensions to `@orchestra/cloud-shared/keys.ts`).
- EventBridge Scheduler register / deregister + schedule firing dispatch → PLAN-lifecycle-worker.
- DDB GSI for `agent_stream` catchup pagination → PLAN-cdk-infra adds the GSI; this stream consumes it.
- S3 bucket for loop logs (`loops/`) overflow / S3 bucket for agent record snapshots → PLAN-cdk-infra.
- Per-tenant CloudWatch log group + EMF metric publisher → PLAN-cdk-infra (`observability.md:88`).
- Per-tenant security group / PrivateLink network isolation for the `/mcp/agents` callback → PLAN-cdk-infra (the daemon's in-app middleware is the second layer of defense, not the only one).
- Quota policy decisions (workspace-create cap, agent-create cap, outbound-spend cap, push-token cap, archived-workspace cap) → PLAN-auth-and-shared enforces; daemon surfaces 429s.
- Webhook subscriber endpoints (no-op log writer at the proprietary side) → PLAN-auth-and-shared or PLAN-lifecycle-worker.
- Round-19 UI dispatch for `runs[N].status:"failed"`, `loops[].text` (no top-level `failureReason`), `interrupt:true` vs `interrupt`-omitted deny → PLAN-app.
- `/api/files/download` cross-instance token store → see § "Cross-stream dependencies" — by Day-1 single-daemon-per-workspace topology, this is effectively in-container; nothing for the daemon to change. PLAN-auth-and-shared owns the token mint if cross-instance is needed Day-N.

## D-3 closure criteria for this slice

The daemon-side slice closes when:

1. **DynamoStore implementations are present, behind the existing `Store` interfaces, and feature-flagged on `isPaseoCloudMode()` at construction (one cloud mode — F11 preserved).** Specifically:
   - `DynamoChatStore implements ChatStore` (chat-store.ts:15-18 contract).
   - `DynamoScheduleStore implements ScheduleStore` (schedule/store.ts:10-16 contract).
   - `DynamoLoopStore implements LoopStore` (loop-store.ts:6-9 contract).
   - **NEW** `DynamoPermissionStore implements PermissionStore` — the interface itself is new in D-3; design and acceptance criteria in T-4 below.
2. **The on-host `FileBackedStore` implementations remain unchanged.** D-3 lands only the cloud branch; self-host operators (REPLACEMENT-CHARTER.md § Non-goals — the fork shipping post-D-5) continue to use the file-backed path.
3. **Container-boot rehydration** is wired into `bootstrap.ts` for cloud mode. On daemon start in cloud mode, the rehydrate pass executes BEFORE `wsServer.start()` accepts connections: read DDB → load chat rooms, schedules (with `runs[]`), loops, agent permission queues → populate in-memory caches → set schedule next-tick timers. Loops with `status:"running"` at restart auto-stop per `loop.md` § "Daemon-restart auto-stop (binding)" — this is preserved in the cloud version too (binding).
4. **`agent_stream` catchup**: a reconnecting client's `fetch_agent_timeline_request{direction:"after", cursor:{epoch,seq}}` is served from the durable timeline store on container respawn, not from a hot in-memory map that was lost. The cursor + epoch semantics are binding (`agent-stream.md` § "Resumption / reconnection") and preserved unchanged on the wire.
5. **Webhook event catalogue Day-1**: the AGPL core fires `workspace.created` (on `bootstrap.ts` happy-path completion of cloud workspace-create RPC), `agent.turn_completed` (on `agent-manager.ts` turn-end), and `workspace.hard_delete_imminent` (D-2 schema; physical caller is the lifecycle worker — O-1 → Architecture B from D-2). The subscriber sink is configured per-deployment via env var `ORCHESTRA_WEBHOOK_SINK_URL`; if absent, the emit is a no-op (Day-1 acceptable per ROADMAP § Phase D-3 "Webhook hook for billing").
6. **Provider snapshot reads from out-of-band source.** The daemon resolves the provider catalog via:
   - `process.env.ORCHESTRA_PROVIDER_SNAPSHOT_URL` → fetch on boot + every TTL (default 5 min);
   - Fallback: a bundled `provider-snapshot.json` baked into the daemon image (matches the image's tagged version);
   - Cache lives in `ProviderSnapshotManager` (`agent/provider-snapshot-manager.ts:33`); on-host mode is unchanged (existing per-CWD inferred path).
7. **Per-spawn `~/.claude` works for scheduled / loop / persistent-resume spawns.** The fail-loud branch in `cloud-credentials.ts:170-174` ("scheduled/loop/background runs are not yet supported in cloud mode") is replaced with `workspaceAuthStorage.run(claims, () => spawnFn())`. The schedule + loop records persist the workspaceId + accountId at create-time (alongside the existing fields per the DDB row shapes from T-2/T-3/T-4 below); the fire-time path reads them and binds the ALS context.
8. **`/mcp/agents/*` enforcement**: an HTTP request to `/mcp/agents/*` with a cross-workspace JWT is 401'd by the daemon's middleware. Regression test added (`bootstrap.workspace-binding.test.ts` — extend the D-2 PR #5 test that covered HTTP `/api/status`; add a `/mcp/agents` case).
9. **Probe 7 WebSocket variant** has an explicit regression test asserting that a WS upgrade with a cross-workspace JWT is rejected with WS close code `4401` (the cloud-mode upgrade path goes through `createJwksWorkspaceAuthCallback`; the same workspace-id binding applies).
10. **Quota 429 propagation**: a test asserts that when the auth-service returns 429 to an outbound HMAC POST during workspace-bound flows, the daemon surfaces the 429 as a typed `rpc_error{code:"quota_exceeded"}` to active sessions where applicable (or warns-and-continues for background loops like heartbeat — see T-9 below).
11. **All D-2 ACCEPTANCE carry-ins** (T-10, T-11, T-12 below) are landed.
12. **Hands-on gate** (ROADMAP § Phase D-3): operator drives every Day-1 surface by hand — creates a schedule that fires every minute, disconnects, waits 3 min, reconnects, sees three runs in `runs[]`; runs a loop hitting `maxIterations`; agent permission deny with `interrupt:true` aborts the turn; disconnect mid-turn + reconnect catches up the timeline. The wire round-trip for the round-19 captures is identical (BINDING).

---

## Task list (numbered, dependency-ordered)

Sizes: S ≈ ½ day, M ≈ 1–2 days, L ≈ 3+ days. Estimates include test write-up + unit-test design; exclude cross-stream coordination time and exclude the D-2-style "operator-driven hands-on probe" time (gate work).

### T-1 — `DynamoChatStore` implementing `ChatStore`

**Why:** `FileBackedChatStore` (chat-store.ts:20-48) reads `$PASEO_HOME/chat/rooms.json` as a single flat file. In cloud mode the same `ChatService` injects this store; D-3 ships the DDB-backed implementation. The on-disk JSON shape stays binding for the in-TS `ChatStorePayload` (chat-store.ts:8-13 — `{rooms[], messages[]}`); the DDB row layout per-message + per-room is separate.

**DDB row shapes (consumed pin from PLAN-auth-and-shared `@orchestra/cloud-shared/keys.ts`):**

- `pk = "<workspaceId>#chat#room"`, `sk = "<roomId>"` → `ChatRoomRecord` (the full `ChatRoom` shape from `chat.md:295-315`, including `purpose: string | null`, `createdAt`, `updatedAt`).
- `pk = "<workspaceId>#chat#msg"`, `sk = "<roomId>#<createdAt>#<messageId>"` → `ChatMessageRecord` (the full `ChatMessage` shape from `chat.md:148-159`).
- Sort-by-`createdAt`-then-by-id is the binding read order for `chat/read`'s chronological output (`chat.md:201`).

The `messageCount` and `lastMessageAt` Derived fields on `ChatRoomDetail` (`chat.md:307-315`) are computed at read time from the in-memory map populated at boot; DDB does not store them directly.

**Files touched (new):**

- `packages/server/src/server/chat/dynamo-chat-store.ts` (new) — `DynamoChatStore implements ChatStore`. The class accepts an injected DDB client (one of: a `@aws-sdk/lib-dynamodb` DocumentClient instance, OR a thin wrapper interface the test seam injects — same pattern as `cloud-credentials.ts:SecretsManagerLike`). Implements `loadAll()` (full table scan per `<workspaceId>#chat#*` partition; bounded by per-workspace data size) and `save()` (per-room transactWrite with idempotent put — DDB rejects writes that change `createdAt`).
- `packages/server/src/server/chat/dynamo-chat-store.test.ts` (new) — store-contract tests against an in-memory mock DDB client; assert load/save round-trips the full chat-lifecycle.jsonl capture shape.
- `packages/server/src/server/chat/chat-service.store-contract.test.ts` — confirm the existing store-contract suite passes for `DynamoChatStore` too (parametrize over both `FileBackedChatStore` and `DynamoChatStore`).
- `packages/server/src/server/bootstrap.ts` — at the chat-service construction site (search `new ChatService` / `FileBackedChatStore`), switch on `isPaseoCloudMode()` and choose the store. Single discriminator (F11 preserved).

**Acceptance criteria:**

- `DynamoChatStore` implements the `ChatStore` interface verbatim (chat-store.ts:15-18). No method added; no method removed.
- `loadAll()` is the cross-restart rehydration path. After a daemon restart in cloud mode, `chat/list` returns the same set as before restart (verified by writing 3 rooms + 5 messages, calling save, simulating restart, calling loadAll, asserting equality).
- `save()` does NOT overwrite the rooms-list with the messages-list (footgun: the on-host file format is a single object with both arrays; the DDB layout splits them). Test asserts that re-saving an existing room does not delete its messages.
- Per-message writes carry an idempotency key (the message UUID); a re-save of the same payload is a no-op (DDB conditional `PutItem` with `attribute_not_exists(messageId)` on inserts; `UpdateItem` on edits — but the on-host model has no message edits, so insert-only is fine).
- Cross-tenant safety: every read and write hard-codes the partition-key prefix from `getCurrentWorkspaceAuth()` (or, for boot-time rehydration, from `process.env.PASEO_WORKSPACE_ID` matched against `expectedWorkspaceId` already verified at boot per `cloud-auth.ts`). The DynamoStore never accepts a workspaceId from a caller; F3 preserved.
- COMPAT comment at the head of the file: `// COMPAT(chat-dynamostore): DDB row shapes pinned by @orchestra/cloud-shared/keys.ts as of v0.X.0. The on-disk JSON shape (FileBackedChatStore) remains binding for on-host; this implementation is cloud-only.`

**Size:** M.

**Depends on:** Cross-stream pin from PLAN-auth-and-shared — the DDB key helpers `keys.chatRoom(workspaceId, roomId)` and `keys.chatMessage(workspaceId, roomId, createdAt, messageId)` in `@orchestra/cloud-shared`. Until those land, the daemon's implementation has a local placeholder with a TODO matching the same shape (avoid blocking by stubbing the helper; swap to the import once the proprietary side publishes).

---

### T-2 — `DynamoScheduleStore` implementing `ScheduleStore` + EventBridge Scheduler register / deregister seam

**Why:** `FileBackedScheduleStore` (schedule/store.ts:18-71) writes one file per schedule under `$PASEO_HOME/schedules/<id>.json`. The wire shape (8-char hex id; `StoredSchedule` with `cadence`, `target`, `runs[]`) is BINDING (schedule.md:289-352). In cloud, the schedule must also fire when the workspace is suspended — that's the EventBridge Scheduler register/deregister hook, wired into the store's `create`/`put`/`delete` methods (statefulness-and-multitenancy.md:106; the cloud version of ScheduleService.create is where EventBridge "schedule-created" notifications get fired toward the lifecycle worker).

**DDB row shapes (consumed pin from PLAN-auth-and-shared):**

- `pk = "<workspaceId>#schedule"`, `sk = "<scheduleId>"` → `ScheduleRecord` (the full `StoredSchedule` minus `runs[]`).
- `pk = "<workspaceId>#schedule#run"`, `sk = "<scheduleId>#<startedAt>#<runId>"` → `ScheduleRunRecord` (the full `ScheduleRun` per schedule.md:338-360). Sort-by-`startedAt` is the binding read order for `schedule/logs` (schedule.md:151 — ascending).

**Round-19 binding shapes that must round-trip through this store:**

- `runs[N].status:"failed"` (schedule.md:360, captured in `examples/schedule-record/round-19-fired-failed-bad-cwd.json`) — `agentId:null`, `output:null`, `error:<string>`, `endedAt` set, top-level `lastRunAt` advances to the failed run's `endedAt` even though the run failed, and a `maxRuns:1` schedule still transitions `active → completed`.
- The `every`-cadence drift-free anchor — `nextRunAt` advances as `createdAt + k*N` regardless of actual fire latency (schedule.md:287-291; captured round 17). The DynamoStore writes this exactly as the on-host store does.
- 5-field cron rejection (`@hourly`, `@daily` rejected with `"Cron expressions must have 5 fields"`; schedule.md:284). Cloud preserves the rejection.

**Files touched (new):**

- `packages/server/src/server/schedule/dynamo-store.ts` (new) — `DynamoScheduleStore implements ScheduleStore`. Methods: `list`, `get`, `create`, `put`, `delete`. `list` reads the `<workspaceId>#schedule` partition and joins per-id `<workspaceId>#schedule#run` runs on demand (lazy on `get` / `list` — the runs partition can be large for long-lived schedules). `create` generates the 8-char hex id (BINDING: `randomBytes(4).toString("hex")` per schedule.md:16) and writes both the schedule row and the empty `runs[]` placeholder.
- `packages/server/src/server/schedule/dynamo-store.test.ts` (new) — store-contract suite; assert round-trip for the round-19 failed-run capture + the round-17 multi-run capture.
- `packages/server/src/server/schedule/service.store-contract.test.ts` — parametrize over `FileBackedScheduleStore` and `DynamoScheduleStore`.
- `packages/server/src/server/bootstrap.ts` — schedule-service construction site, switch on `isPaseoCloudMode()` and choose the store.

**EventBridge Scheduler register / deregister hook (cross-stream — owned by PLAN-lifecycle-worker; the daemon emits a notification):**

- On `create(schedule)`: after the DDB write succeeds, HMAC POST to `${ORCHESTRA_AUTH_INTERNAL_URL}/api/auth-internal/schedule-registered` with `{ workspaceId, scheduleId, nextRunAt, cadence }`. The auth side or lifecycle worker resolves the EventBridge Scheduler call (PLAN-lifecycle-worker owns this).
- On `put(schedule)` where `nextRunAt` changed (e.g., post-fire, post-pause, post-resume): same notification with the new `nextRunAt`.
- On `delete(scheduleId)`: notification `/api/auth-internal/schedule-deregistered` with `{ workspaceId, scheduleId }`.
- Reuse `cloudHmacFetch` (`cloud-hmac-fetch.ts`) — same primitive as T-4 in D-2.
- Per F9 (single writer per side effect): the DynamoStore is the ONLY caller of these notifications. The daemon's existing `ScheduleService` does not call EventBridge directly — that's the lifecycle worker's job; the daemon merely tells it the schedule changed.

**Acceptance criteria:**

- All 7 captured round-14/17/19 wire round-trips parse via `StoredScheduleSchema.parse(JSON.parse(...))` after a round-trip through `DynamoScheduleStore.create + get`. Specifically:
  - `examples/schedule-record/fresh-active.json`
  - `examples/schedule-record/fired-one-shot.json`
  - `examples/schedule-record/fired-multi-run-after-3.json`
  - `examples/schedule-record/fired-cron.json`
  - `examples/schedule-record/fired-expired.json`
  - `examples/schedule-record/round-19-fired-failed-bad-cwd.json` — this is the load-bearing test. The failed-run record's `agentId:null`, `output:null`, `error:<string>`, terminal `status:"completed"` at the top level with `nextRunAt:null` must round-trip.
- EventBridge Scheduler register/deregister notifications are warn-and-continue on failure (same posture as heartbeat T-4 in D-2) — a transient auth-service outage does NOT block schedule creation in the daemon's local FS. If the notification ever fails, the workspace's eventual transition to `suspended` means schedules fall back to the lifecycle worker's polling fallback (PLAN-lifecycle-worker's scope; out of this stream's hands).
- The `runOnCreate` semantic (service.ts:192-193) is preserved — `every`-cadence schedules fire immediately on create. The DynamoStore must not block this behavior.

**Size:** L (the cadence + multi-runs partition reads + the register/deregister notification triple).

**Depends on:** PLAN-auth-and-shared (DDB row shape pins + `/api/auth-internal/schedule-{registered,deregistered}` routes); PLAN-lifecycle-worker (the EventBridge Scheduler caller on the receiving side).

---

### T-3 — `DynamoLoopStore` implementing `LoopStore` (+ S3 offload for `logs[]`)

**Why:** `FileBackedLoopStore` (loop-store.ts:11-37) writes one global flat JSON file (`$PASEO_HOME/loops/loops.json`) containing every loop. The footgun is direct-write (no temp+rename, loop.md:375). The cloud version solves this by partitioning per-loop-id and offloading `logs[]` to S3 for long-running loops.

**DDB row shapes (consumed pin from PLAN-auth-and-shared):**

- `pk = "<workspaceId>#loop"`, `sk = "<loopId>"` → `LoopRecord` (the full `LoopRecord` shape minus `logs[]` if logs are offloaded — see below).
- `pk = "<workspaceId>#loop#iteration"`, `sk = "<loopId>#<index>"` → `LoopIterationRecord`. Per-iteration sort by `index` is the binding read order.
- `pk = "<workspaceId>#loop#log"`, `sk = "<loopId>#<seq>"` → `LoopLogEntry`. Sort by `seq` is the binding read order (`loop.md:191` — `seq` monotonic per-loop, starts at 1).

**S3 offload (cross-stream pin — bucket owned by PLAN-cdk-infra):**

- When `logs[]` exceeds N entries (default 1000; tunable via env), the store offloads older entries to S3 at `s3://orchestra-<stage>-loop-logs/<workspaceId>/<loopId>/<seqStart>-<seqEnd>.jsonl` and persists only the cursor (`s3StoredSeqMax`) in the DDB row. The wire `loop/logs` RPC fetches from S3 if the requested `afterSeq` is below `s3StoredSeqMax`; from DDB otherwise. Round-19 binding: the wire `LoopLogEntry` shape (loop.md:189-196) is unchanged whether the entry came from DDB or S3.

**Round-19 binding shapes that must round-trip:**

- `maxTimeMs` cap → loop transitions to `status:"failed"` with a final log entry `{source:"loop", level:"error", iteration:null, text:"Reached max time (<N>ms)."}` (loop.md:55-56, captured `examples/loop-record/round-19-loop-maxTimeMs-cap.json` + `examples/websocket/round-19-loop-maxTimeMs-cap.jsonl`). **There is NO top-level `failureReason` field.** The cap message lives in `logs[]` only. The DynamoStore must NOT add a synthetic top-level field; doing so would break the wire shape.
- Same for `maxIterations` cap (round 16) — text is `"Reached max iterations (<N>)."`.
- Daemon-restart auto-stop (loop.md:332-343, BINDING) — `status:"running"` loops at restart transition to `"stopped"` with `completedAt = stopRequestedAt = updatedAt = <restart-time>`, a final log entry `"Loop was interrupted by daemon restart."`, and the last iteration gets `failureReason:"Daemon restarted"`. The cloud rehydration path (T-6) must preserve this exact behavior.

**Files touched (new):**

- `packages/server/src/server/dynamo-loop-store.ts` (new) — `DynamoLoopStore implements LoopStore`. `loadAll()` reads the `<workspaceId>#loop` + `<workspaceId>#loop#iteration` + `<workspaceId>#loop#log` partitions, merges into the in-memory `LoopRecord[]` shape, and applies the auto-stop rule for any `status:"running"` records found at boot. `save(records)` writes diffed rows (the on-host model is "write the whole array every persist"; the cloud model writes per-loop-id transactWrites). For loops where `logs.length > threshold`, the store offloads chunks to S3 + truncates `logs[]` to the threshold window.
- `packages/server/src/server/dynamo-loop-store.test.ts` (new) — store-contract + round-19 round-trip + daemon-restart-auto-stop simulation.
- `packages/server/src/server/loop-service.store-contract.test.ts` — parametrize over `FileBackedLoopStore` and `DynamoLoopStore`.
- `packages/server/src/server/loop/rpc-schemas.ts` — no schema change expected; verify the existing `LoopRecord` schema accepts both the DDB-trimmed-logs and the full-logs shape (today the schema has no `s3StoredSeqMax`; that field is in-store-only and never on the wire). If the schema needs an `.optional()` field to surface S3-cursor metadata to the wire (UNVERIFIED whether the app needs it), add it `.optional()` to preserve back-compat.

**Acceptance criteria:**

- `examples/loop-record/round-19-loop-maxTimeMs-cap.json` round-trips through `DynamoLoopStore.save + loadAll` byte-identical (modulo S3 offload — the trip preserves the wire shape on `loop/inspect`).
- `examples/loop-record/multi-iteration-failed.json` round-trips.
- After a `loadAll()` invoked at simulated daemon restart, any in-memory `LoopRecord` with `status:"running"` is auto-stopped per `loop.md:332-343`. The store's `loadAll` returns the auto-stopped shape directly (the LoopService doesn't need to know whether the auto-stop happened in-memory or in-store; the wire shape is the same).
- Per-tenant safety: the DDB partition key is hard-coded to the workspace id from boot-env (`PASEO_WORKSPACE_ID`); no caller-supplied workspace id is accepted (F3).

**Size:** L (DDB partitions + S3 offload + auto-stop + cap-message preservation).

**Depends on:** PLAN-auth-and-shared (DDB row shape pins); PLAN-cdk-infra (S3 bucket + IAM grant).

---

### T-4 — `DynamoPermissionStore` (NEW interface) — durable permission queue

**Why:** the permission queue is in-memory only on-host (`permission.md` § "Persistence" — "No on-disk state for the permission queue itself"). The cloud daemon needs durable persistence for: (a) cross-restart resume (a workspace daemon container that respawns mid-permission must not lose the pending request — the agent's `attentionReason:"permission"` is persisted to the agent record but the actual `pendingPermissions[]` is in-memory); (b) cross-surface convergence (the WS and HTTP MCP surfaces converge on `agentManager.respondToPermission`; both must reach the same in-memory map even after a container respawn).

**Round-19 binding shapes that must round-trip:**

- `deny` with `interrupt:true` → captured `examples/websocket/round-19-permission-deny-interrupt-true.jsonl`. After resolution, the agent transitions to `status:"error"` with `attentionReason:"error"`; no follow-up `assistant_message`; no `turn_completed`; a synthetic `[ede_diagnostic]` system-error message is surfaced from the SDK. The DynamoPermissionStore stores the resolution verbatim (including `interrupt:true`); the `agent_permission_resolved` push echoes the `resolution` field verbatim (`permission.md:163` — "The `agent_permission_resolved` push echoes the `response` object verbatim").
- `deny` with `interrupt` omitted → captured `examples/websocket/round-19-permission-deny-interrupt-omitted.jsonl`. The agent treats the deny as a soft tool failure; agent reasons through the rejection; `turn_completed` fires; `attentionReason:"finished"`. Same store semantics — the resolution is stored verbatim with no `interrupt` field present.

**Interface design:**

```ts
// packages/server/src/server/agent/permission-store.ts (new)
export interface AgentPermissionRequestRecord {
  agentId: string;
  request: AgentPermissionRequestPayload; // permission.md:42-64
  createdAt: string;
}

export interface PermissionStore {
  loadAll(): Promise<AgentPermissionRequestRecord[]>;
  put(record: AgentPermissionRequestRecord): Promise<void>;
  delete(agentId: string, requestId: string): Promise<void>;
  deleteAllForAgent(agentId: string): Promise<void>;
}
```

The agent-manager's `pendingPermissions: Map<string, AgentPermissionRequest>` (agent-manager.ts:235) becomes the in-memory view; every mutation also writes to the store. `respondToPermission` (agent-manager.ts:1741) deletes from the store after the underlying session resolves.

**DDB row shape (consumed pin from PLAN-auth-and-shared):**

- `pk = "<workspaceId>#permission"`, `sk = "<agentId>#<requestId>"` → `AgentPermissionRequestRecord`. No GSI needed (per-agent reads use the existing in-memory map; only boot-time rehydration scans the partition).

**Files touched (new):**

- `packages/server/src/server/agent/permission-store.ts` (new) — interface + `InMemoryPermissionStore` (test seam) + `FileBackedPermissionStore` (on-host parity; writes to `$PASEO_HOME/permissions/<agentId>.json`) + `DynamoPermissionStore` (cloud). The on-host store is technically NEW — today the on-host model has no persistence. Adding it serves cross-restart parity AND is the seam D-3 needs.
- `packages/server/src/server/agent/permission-store.test.ts` (new) — round-trip tests for both deny shapes (interrupt:true; interrupt omitted).
- `packages/server/src/server/agent/agent-manager.ts` — refactor `pendingPermissions: Map<...>` into a passthrough that delegates to the injected store on every mutation. The map remains; the store is the persistence layer.
- `packages/server/src/server/bootstrap.ts` — agent-manager construction site picks the store via `isPaseoCloudMode()`.

**Acceptance criteria:**

- Both round-19 deny captures round-trip through `DynamoPermissionStore.put + loadAll + delete` byte-identical for the `resolution` field.
- After a simulated daemon restart, in-flight permissions persisted in DDB are restored to the agent-manager's in-memory map AND the agent's `attentionReason:"permission"` is preserved on the snapshot.
- `respondToPermission` deletes the row from the store on success; failure (unknown agent, unknown permission id) preserves the row and surfaces the same three-message failure shape from `permission.md:134-141` (`activity_log` + `rpc_error code:"handler_error"` + second `activity_log`). The store layer never throws on `delete(unknown)`.
- On-host parity: `FileBackedPermissionStore` is the default in non-cloud mode; existing on-host conformance tests (`permission.fetch-agents-includes-empty-pending-permissions` etc.) pass unchanged.
- Cross-surface convergence: an HTTP MCP `respond_to_permission` resolves a permission that was created via WS; the DDB row is deleted; the `agent_permission_resolved` push fires to all subscribed WS sessions (per `permission.md:81` — "Cross-session broadcast"). Test added (`permission-store.cross-surface.test.ts`) asserting this.

**Size:** L.

**Risk note:** the on-host side is gaining persistence for the first time. Self-host operators upgrading past this point will see a new directory under `$PASEO_HOME/permissions/`; document in CHANGELOG and ensure the directory is created on demand by the store (not eagerly in bootstrap).

**Depends on:** PLAN-auth-and-shared (DDB row shape pin).

---

### T-5 — Container-boot rehydration (cloud-mode-only)

**Why:** in cloud mode, a freshly-launched daemon container has an empty in-memory state (the EBS volume holds the local FS for active read/write, but after a `StopTask` + `RunTask` cycle the in-memory maps that drive `ChatService`, `ScheduleService`, `LoopService`, `AgentManager.pendingPermissions` need to be populated from DDB before serving WS traffic). Today's bootstrap.ts uses the file-backed store on-host where `loadAll()` is implicit; in cloud the same `loadAll()` reads DDB.

**Files touched:**

- `packages/server/src/server/bootstrap.ts` — between the `agentManager` / `chatService` / `scheduleService` / `loopService` construction and `await wsServer.start()`, add an `await Promise.all([chatService.rehydrate(), scheduleService.rehydrate(), loopService.rehydrate(), agentManager.rehydratePendingPermissions()])` step in cloud mode. Each `rehydrate()` method:
  - Calls the store's `loadAll()`.
  - Populates the service's in-memory data structures.
  - For schedules with `nextRunAt` in the past → fires the missed-fire path on the next tick (existing behavior; the in-memory tick recovers).
  - For loops with `status:"running"` → applies the auto-stop rule (T-3 acceptance).
- Each of `ChatService`, `ScheduleService`, `LoopService`, `AgentManager` — add a public `rehydrate()` method that today's in-memory maps already implement implicitly via the store; in cloud mode it's the explicit entry point.

**Acceptance criteria:**

- Boot order: rehydrate BEFORE `wsServer.start()` accepts connections. A client's first `chat/list` / `schedule/list` / `loop/list` after a cold daemon container start returns the same data as before the StopTask, modulo the auto-stop for running loops.
- A heartbeat from T-4 (D-2) starts only AFTER rehydration completes (heartbeat reports `activeAgents` and `connectedClients`, which are 0 at this point — but the boot delay is bounded; if rehydration takes >10 s the boot logs warn and continue, because heartbeat lateness is preferable to never starting at all).
- The fail-loud branch in `cloud-credentials.ts:170-174` is the ONLY remaining ALS-context-missing case after rehydration — schedule firing and loop iteration both restore the ALS via the persisted `workspaceId` in their records (T-7 below).
- On-host mode is unchanged: `rehydrate()` is called but is a no-op (or equivalent to today's first-`list()`-on-demand path).

**Size:** M.

**Depends on:** T-1, T-2, T-3, T-4 (the stores are the rehydration data source).

---

### T-6 — `agent_stream` catchup on reconnect / container respawn

**Why:** today's `fetch_agent_timeline_request` reads the `InMemoryAgentTimelineStore` (agent-timeline-store.ts:146). If a workspace daemon container respawns, the in-memory map is empty until populated. The on-disk agent record (per `statefulness-and-multitenancy.md:69` — `pk=<workspace>#agent#<agent-id>`) stores the agent's metadata, but the timeline rows live separately. D-3 must add a durable `AgentTimelineStore` (the DDB-or-S3-backed variant) that survives container respawn and a corresponding rehydration pass.

The wire shape is BINDING (`agent-stream.md` § "fetch_agent_timeline_request"; § "Resumption / reconnection"):

- Request: `{agentId, direction:"after", cursor:{epoch, seq}, subscribe?:{subscriptionId}}`.
- Response: `{events[], nextCursor:{epoch,seq}, subscriptionId?}`.
- The `(epoch, seq)` cursor is the only thing a client can use to resume. Migration to a server-opaque cursor is explicitly out-of-scope per `agent-stream.md:80-81`.

**Files touched (new):**

- `packages/server/src/server/agent/dynamo-agent-timeline-store.ts` (new) — `DynamoAgentTimelineStore implements AgentTimelineStore`. Implements every method in `agent-timeline-store-types.ts:45-65`. Row shape: `pk = "<workspaceId>#agent#timeline"`, `sk = "<agentId>#<epoch>#<seq>"`. Sort-by-`(epoch, seq)` is the binding read order. The `epoch` resets on `replaceAgentRun` (agent-manager.ts:1091) — the store writes a new partition prefix; the old one is retained (consistent with cross-restart-survival) but not served on `direction:"after"` queries that supply the current epoch.
- `packages/server/src/server/agent/dynamo-agent-timeline-store.test.ts` (new) — store-contract suite over `AgentTimelineStore`.
- `packages/server/src/server/agent/agent-manager.ts` — at the `appendCommitted` site, the in-memory store and the durable store BOTH receive the row (write-through cache; F9 single-writer-per-side-effect preserved by treating "in-memory + DDB" as one logical writer at the manager level). The in-memory store remains the active read path during a session; the durable store is read only on cross-restart rehydration (T-5).
- `packages/server/src/server/bootstrap.ts` — agent-manager construction selects the durable store via `isPaseoCloudMode()`.

**Acceptance criteria:**

- After a cross-restart, a client's `fetch_agent_timeline_request{direction:"after", cursor:{epoch, seq}}` returns the events since `(epoch, seq)`. If the agent was reset/forked across restart and the epoch changed, the response signals `staleCursor:true` (existing field per `agent-timeline-store-types.ts:38`) and the client re-fetches with `direction:"tail"`.
- `agent_stream` events emitted on the wire continue to include `(seq, epoch)` per the existing session.ts:1291-1292 serialization. No wire-shape change.
- Throughput: write-through to DDB is async-with-best-effort. If the DDB write fails, the in-memory append still succeeds, the wire push still fires, and the failure is logged at warn (the client can re-fetch later via the durable read path; one missed write is a missed-resume case for a future cross-restart but does not corrupt the live stream).
- Memory pressure: long-lived agents (1M+ timeline rows) do not OOM the daemon. The in-memory store keeps a bounded window (configurable; default 10K rows); rows older than the window are served from the durable store on `direction:"before"` queries. This is a new behavior on-host too; verify the existing `fetch_agent_timeline_request{direction:"before"}` path tolerates it.
- The `subscribe` flag path (session.ts subscribe-mid-fetch — `agent-stream.md:62`) continues to work: the daemon registers the subscription, returns the missed-events window, and pushes new events from the live stream. The durable store is read-only for the historical window; the in-memory store handles live.

**Size:** L.

**Depends on:** PLAN-auth-and-shared (DDB row shape pin: `keys.agentTimeline(workspaceId, agentId, epoch, seq)`); PLAN-cdk-infra (DDB GSI on `(agentId, seq)` if the partition-size policy requires).

---

### T-7 — Persist `workspaceId` + `accountId` on schedule / loop / agent records; restore ALS context at fire time

**Why:** the cloud-auth.ts hand-off note (cloud-auth.ts:131-137) explicitly defers this to D-3: "scheduled / loop / persistent-agent-resume runs triggered outside an active WS handler will see `getStore() === undefined`. Cloud-mode spawn sites fail-loud in that case [...] later phases (D-3) will persist workspace ownership with the schedule/loop records and restore context at fire time." The fail-loud branch in `cloud-credentials.ts:170-174` is the bottleneck D-3 must remove.

**Files touched:**

- `packages/server/src/server/schedule/types.ts` — `StoredSchedule` adds `cloudOwnerWorkspaceId: string | null` and `cloudOwnerAccountId: string | null` (BOTH `.nullable()` for backwards-compatibility — on-host records have null; cloud records have the actual claims). Schema migration: `.optional()` defaults. Reload of existing on-host schedule files yields null for these fields with no parsing failure.
- `packages/server/src/server/schedule/service.ts:188-210` — at `create()`, read `getCurrentWorkspaceAuth()`; if present, persist `cloudOwnerWorkspaceId` + `cloudOwnerAccountId`. F3 design-out: NEVER accept these from the caller; ALWAYS derive from ALS at the create-call-site.
- `packages/server/src/server/schedule/service.ts:executeSchedule` — at fire time, if `cloudOwnerWorkspaceId` is non-null, wrap the fire in `workspaceAuthStorage.run({workspaceId, accountId, expiresAt}, async () => { ... })`. `expiresAt` here is a synthesized very-large value because the schedule's own ALS context is not bounded by the original JWT's expiry (the schedule's authority comes from the workspace's existence, not the user's session). DOC a comment marking this design.
- `packages/server/src/server/loop-types.ts` — same change to `LoopRecord`.
- `packages/server/src/server/loop-service.ts` — same pattern at loop-iteration spawn.
- `packages/server/src/server/agent/agent-storage.ts` — same change to the agent record (per `statefulness-and-multitenancy.md:69` the agent index is per-workspace; adding `cloudOwnerWorkspaceId` is redundant given the partition key, but explicit-field-for-restore is the safe choice). Persistent-resume (post-restart) reads the record + binds ALS context.
- `packages/server/src/server/cloud-credentials.ts:165-181` — `provisionCloudClaudeHome` no longer fail-louds on missing ALS; instead, the caller's contract becomes "the caller MUST establish the workspaceAuthStorage context before calling." Schedule + loop + persistent-resume sites are the callers that now establish the context.

**Acceptance criteria:**

- Hands-on probe (cited in ROADMAP § D-3 hands-on gate):
  - Create a schedule that fires every minute. Disconnect the client.
  - Wait 3 minutes.
  - Reconnect. The schedule has fired 3 times. The agent's timeline shows the 3 worker runs.
  - **The fail-loud branch in `cloud-credentials.ts` did NOT fire** (verified by daemon.log scan for `"workspace auth context"` errors — should be empty).
- Run a loop with `maxIterations:3`. Disconnect mid-run. Reconnect. The loop has completed 3 iterations and is `status:"failed"` (per `loop.md` § cap-message). The cap message is in `logs[].text`, not a top-level `failureReason` (BINDING — round-19 capture).
- For agents in `archived` workspaces: an attempt to fire a schedule whose `cloudOwnerWorkspaceId` is archived → the schedule notifies the lifecycle worker (T-2 deregister); the daemon does NOT fire. UNVERIFIED whether this is the right behavior — surfaced in § Open questions.

**Size:** M.

**Cross-stream:** PLAN-app may need to ensure the wire `StoredSchedule` schema's added fields are `.optional()` on the app side too (the client today does not look at them; forward-compat for the day they do).

---

### T-8 — Webhook event catalogue expansion (workspace.created, agent.turn_completed) + sink configuration

**Why:** D-2 shipped the `workspace.hard_delete_imminent` event schema (`cloud-webhook-events.ts:28-36`) and the emit primitive (`cloud-webhook-emit.ts`). D-3 adds two more events from the open-core-architecture.md:56-60 list:

- `workspace.created` — fires from the AGPL daemon's cloud workspace-create handler, OR from the auth service's workspace-create handler depending on the open-core boundary decision (open question; surfaced below). For Day-1 the AGPL fork's role is "publish the schema; have it ready to fire if the daemon is the originator."
- `agent.turn_completed` — fires from `agent-manager.ts` at the turn-end hook (search for `turn_completed` in `agent-stream.md` event types). Payload includes token / cost telemetry for billing-module Day-N consumption.

**Files touched (additive):**

- `packages/server/src/server/cloud-webhook-events.ts` — add `WorkspaceCreatedEventSchema` and `AgentTurnCompletedEventSchema` alongside the existing schema. Same dual-shape pattern (camelCase TS / snake_case wire). Same COMPAT comments (cite the open-core-architecture.md event catalogue line numbers).
- `packages/server/src/server/cloud-webhook-emit.ts` — generalize from single-event `WorkspaceHardDeleteImminentEvent` to a union; the emit primitive validates against the union before sending. The existing API surface stays back-compat (the `event` parameter accepts the union).
- `packages/server/src/server/cloud-webhook-emit.test.ts` — add tests for the two new events.
- `packages/server/src/server/agent/agent-manager.ts` — at the turn-end hook (search for `turn_completed` event emission), if `isPaseoCloudMode()` AND `ORCHESTRA_WEBHOOK_SINK_URL` is configured, fire `agent.turn_completed` via the emit primitive. Include token/cost telemetry from the provider session.
- `packages/server/src/server/bootstrap.ts` — read `ORCHESTRA_WEBHOOK_SINK_URL` once at boot; pass to services that emit webhooks. If unset → all webhook emit sites no-op (Day-1 acceptable; ROADMAP § Phase D-3 — "Webhook sink can be a no-op log writer in this phase").

**Acceptance criteria:**

- The two new event schemas parse + round-trip via the dual-schema pattern.
- The `agent.turn_completed` emit fires once per turn end; failed turns surface as `agent.turn_failed` (DIFFERENT event; per `open-core-architecture.md:59`) — schema added too. Warn-and-continue on subscriber failure; the agent's own turn outcome is unaffected.
- When `ORCHESTRA_WEBHOOK_SINK_URL` is unset, the webhook emit sites log at debug ("Webhook sink not configured, skipping <event-type>") and return; no outbound HTTP.
- The `workspace.created` schema is shipped but the AGPL daemon does NOT necessarily fire it Day-1 — depending on the open-core boundary call (open question, surfaced below). The schema is ready; the emit site lands when the boundary call is made.
- COMPAT comment on each new event citing the open-core-architecture.md line range and the workspace-lifecycle.md sequencing.

**Size:** M.

**Depends on:** none in this stream (D-2 emit primitive already exists). Coordinates with PLAN-auth-and-shared on whether the AGPL or proprietary side fires `workspace.created`.

---

### T-9 — Out-of-band provider snapshot consumer (F1 fix)

**Why:** F1 from the prior-attempt postmortem (IMPLEMENTATION-ROADMAP.md:269): "the cloud model picker rendered 'No models match your search' because `useProvidersSnapshot` is relay-gated and no container exists pre-spawn." The cloud daemon must NOT be the catalog's source. D-3 reverses the dependency: a deployment-time-published snapshot lives at a known URL (or in the image); the daemon reads it.

**Files touched:**

- `packages/server/src/server/agent/provider-snapshot-manager.ts:33` — extend `ProviderSnapshotManager` with a cloud-mode branch:
  - If `isPaseoCloudMode()` AND `ORCHESTRA_PROVIDER_SNAPSHOT_URL` is set → fetch the snapshot from the URL on boot + every TTL (default 5 min, matching `DEFAULT_SNAPSHOT_TTL_MS`). HTTP GET (no HMAC; the URL is a public-read S3 object or a CloudFront distribution — pinned by PLAN-cdk-infra). The snapshot validates against the existing `ProviderSnapshotEntry` schema.
  - Fallback: a `provider-snapshot.json` baked into the daemon Docker image at `/paseo/provider-snapshot.json` (path matches the existing `/paseo` mount per `agent-host-topology.md`). The image-baked snapshot matches the daemon image's tagged version.
  - On-host mode: unchanged (per-cwd `refreshSnapshotForCwd` reads the local install). Single discriminator (F11 preserved).
- `packages/server/src/server/agent/provider-snapshot-manager.test.ts` — add tests for the cloud-mode branch (mock fetch; assert TTL refresh; assert image-baked fallback).
- `Dockerfile` — add a step that COPYs the snapshot JSON to `/paseo/provider-snapshot.json`. Source of the JSON is a build-time artifact published by the deployment pipeline (PLAN-cdk-infra produces it; this stream COPYs it in).

**Acceptance criteria:**

- In cloud mode with `ORCHESTRA_PROVIDER_SNAPSHOT_URL` set, the daemon's `getSnapshot(cwd)` returns the deployment-published catalog without invoking any per-cwd provider binary. Mockable via the existing test seam.
- When the URL fetch fails (network outage), the daemon falls back to the image-baked file; if that's also missing or stale, the snapshot has `status:"loading"` entries (existing on-host behavior preserved).
- The `agent_stream`-side path that depends on the snapshot (model picker, provider list) does NOT call into the daemon's per-cwd `getSnapshot` codepath — instead, the cloud branch serves the prebuilt catalog. F1 cleanly closed.

**Size:** M.

**Cross-stream:** PLAN-cdk-infra builds the snapshot publication step in CI; PLAN-app may want to consume the `lastFetched` timestamp from the daemon's snapshot for stale-warning UX (out of this stream).

---

### T-10 — `/mcp/agents/*` workspace-bound JWT enforcement: regression test + lint

**Why:** the daemon's `requireWorkspaceAuth` middleware is mounted on the app (bootstrap.ts:454-458) BEFORE the MCP routes are registered (bootstrap.ts:896-898). The D-2 ACCEPTANCE post-mortem (LEARNINGS.md:2657-2700) caught a missed `workspace_id` binding in the `validateWorkspaceToken` callback; PR #5 added the binding for HTTP `/api/status`. The MCP routes share the same middleware chain by construction, but **there is no regression test today asserting that an inbound `/mcp/agents/*` request with a cross-workspace JWT is 401'd at the daemon**.

This task is verification + a regression test, not new code (the middleware already enforces). The defense-in-depth at the daemon side is binding regardless of whether PLAN-cdk-infra's SG/PrivateLink layer is in place.

**Files touched:**

- `packages/server/src/server/bootstrap.workspace-binding.test.ts` (existing from PR #5; extend) — add a test case that sends a POST to `/mcp/agents` with a cross-workspace JWT and asserts the daemon responds 401 BEFORE the MCP handler runs. Use a mock JWKS + a token signed with the WRONG `workspace_id` claim.
- `packages/server/src/server/bootstrap.ts` — verify the middleware order at code review; no edits expected.

**Acceptance criteria:**

- The new test passes. Repeat for `/api/status` (already-tested), `/api/files/download` (new — covers D-3's file-download surface), and `/mcp/agents` POST + GET + DELETE.
- LEARNINGS.md cross-reference: add a paragraph to the next LEARNINGS entry citing that the WebSocket variant of probe 7 is now explicitly tested (also see T-11).
- Defense-in-depth comment in bootstrap.ts at the middleware mount site: `// COMPAT(workspace-jwt-binding): daemon-side workspace_id binding; defense-in-depth alongside PLAN-cdk-infra's SG/PrivateLink isolation. Both layers must reject cross-tenant traffic; if either is bypassed, the other still denies.`

**Size:** S.

**Depends on:** none.

---

### T-11 — Probe 7 WebSocket variant (D-2 ACCEPTANCE carry-in)

**Why:** LEARNINGS.md 2026-05-25 "What's still uncertain / deferred for D-3+" — _"Probe 7 WebSocket variant — today's probe 7 hit HTTP `/api/status`; the rubric also mentions a WS-upgrade variant. The daemon's WS handler likely shares the same auth middleware (HTTP Bearer required even for WS upgrade), so the fix should cover both, but not explicitly verified."_

The verification is largely a test addition — the `Sec-WebSocket-Protocol: paseo.workspace.<token>` upgrade path goes through the same `createJwksWorkspaceAuthCallback` callback per `statefulness-and-multitenancy.md:40-41`. But "should" is not "verified"; D-3 adds the capture.

**Files touched:**

- `packages/server/src/server/cloud-auth.workspace-binding.test.ts` (existing or extend) — add a test that constructs a WS server, sends a `Sec-WebSocket-Protocol` upgrade carrying a cross-workspace JWT, asserts the server rejects the upgrade with WS close code `4401`.
- `D-3-plans/probe-7-ws-results.md` (new artifact for the hands-on gate) — captures the operator-driven run output (similar to D-2's `PROBE-RESULTS-2026-05-25.md` in the proprietary repo; this is the AGPL-fork-side artifact).

**Acceptance criteria:**

- The test passes. The close code is exactly `4401` (BINDING — `lifecycle.md` and observability.md:72).
- The capture artifact lands in `D-3-plans/` and is referenced in the next LEARNINGS entry alongside the HTTP probe-7 capture from D-2.

**Size:** S.

---

### T-12 — Quota / 429 propagation: typed `rpc_error{code:"quota_exceeded"}` (D-3 new surface)

**Why:** ROADMAP § Phase D-3 — "Per-workspace quotas" + "When auth returns 429 with rate-limit headers, surface as a WS `rpc_error` with an appropriate code." The daemon's outbound HMAC POSTs (workspace-create, schedule-create-notify, heartbeat, version beacon, webhook emit) can all hit 429 from the auth service. Today's HMAC primitive (`cloud-hmac-fetch.ts`) returns `{ ok: false, status }` on non-2xx, but the caller decides whether to surface anything.

**Files touched:**

- `packages/server/src/shared/messages.ts` (NOT editing the existing `rpc_error.code` taxonomy — adding a new typed code is forward-compatible per CLAUDE.md protocol rules). Specifically: extend the `rpc_error.code` enum union with `"quota_exceeded"`. Per the protocol-contract rule, this is additive — old clients dispatch on `code` and treat unknown values as `"handler_error"` (per `permission.md:259-261` — the catch-all). Forward-compat preserved.
- `packages/server/src/server/cloud-hmac-fetch.ts` — extend the `CloudHmacFetchResult` type with optional `rateLimitHeaders` (parsed `Retry-After`, `X-RateLimit-Remaining`, etc.; specific shape from PLAN-auth-and-shared's 429 response).
- `packages/server/src/server/cloud-heartbeat.ts` — on 429: warn-and-continue (no per-call WS session to surface to; the heartbeat is server-internal).
- `packages/server/src/server/schedule/dynamo-store.ts` — on 429 from `schedule-registered` notify: surface `rpc_error{code:"quota_exceeded", requestId, error:"<auth-returned-message>"}` to the WS session that triggered the create. The session-side wrapper in `session.ts` is what emits the wrapped `rpc_error`; the store layer returns a typed `QuotaExceededError` and the session converts.
- Same pattern for any other outbound that ties to a user-WS-session.
- Daemon-internal outbounds with no session context (heartbeat, version beacon, snapshot fetch): log at warn; do NOT surface to any WS.

**Acceptance criteria:**

- A test injects a mock auth-service that returns 429 on `schedule-registered`; the daemon's `schedule/create` WS RPC returns `rpc_error{code:"quota_exceeded"}` to the client. The schedule's DDB row is rolled back (or never written — depends on the call order; PLAN-auth-and-shared owns this decision).
- The protocol-contract rule is satisfied: old clients seeing the new code dispatch as if it were `handler_error` (forward-compat) and surface a generic error to the user. New clients dispatch specifically on `quota_exceeded` and surface a quota-specific UX (PLAN-app).
- COMPAT comment in messages.ts: `// COMPAT(quota_exceeded): added in v0.X.0 for D-3 cloud quotas; drop the back-compat fall-through to handler_error when the protocol floor includes this code (target removal: 6 months from D-3 ship).`

**Size:** M.

**Depends on:** PLAN-auth-and-shared (the 429 response shape + rate-limit headers).

---

### T-13 — D-2 carry-in: Heartbeat second-hop bug + lifecycle-worker correctness (LEARNINGS 2026-05-25)

**Why:** LEARNINGS.md 2026-05-25 "Still uncertain / deferred" — _"Heartbeat scanner has a residual bug post-PR #34: 'transitionToSuspended: state row missing — skip' warns every 60 s for ws_7258b0f1 ... the scanner is now finding rows — but the next hop (reading state to mark suspended) uses a different key shape that's not aligned."_ Filed in the proprietary repo as #56-ish; the AGPL-side dependency is that the daemon's heartbeat row shape (T-4 from D-2) must match the worker's read shape.

**Files touched (verification + small):**

- `packages/server/src/server/cloud-heartbeat.ts` — re-verify the body shape `{ workspaceId, lastHeartbeat, activeAgents, connectedClients, daemonImageTag }` against PLAN-lifecycle-worker's expected read shape. If misaligned, this stream's piece is to coordinate the rename without breaking the heartbeat receiver path (PLAN-auth-and-shared's `/api/auth-internal/heartbeat`).
- Bidirectional test: a contract test that simulates the round-trip — daemon emits heartbeat → auth route writes DDB row → lifecycle worker reads via GSI → comparison. (This test may live in a shared D-3 integration suite, not on the daemon side; the daemon's piece is just the emit shape.)

**Acceptance criteria:**

- The heartbeat body shape is identical to the one consumed by the lifecycle worker. The "state row missing" warning no longer fires (verified post-deploy in the proprietary repo's logs).
- No daemon-side code change unless misalignment is found. If found, change the daemon's emit shape with a COMPAT comment.

**Size:** S.

---

### T-14 — D-2 carry-in: `provisioning_failed` cap-trap + workspace-cap edge case (LEARNINGS 2026-05-25 operator UAT)

**Why:** LEARNINGS.md 2026-05-25 operator UAT — _"`provisioning_failed` cap-trap — three independent fixes possible: (a) make `provisioning_failed → archived` a legal transition; (b) have rollback `DeleteItem` instead of writing tombstones; (c) add a lifecycle-worker sweep for stale `provisioning_failed`. Need a product call on which."_

This is PRIMARILY a cross-stream item (PLAN-auth-and-shared owns the workspace-create rollback path; PLAN-lifecycle-worker owns the sweep). The daemon's piece: ensure the daemon does not contribute to `provisioning_failed` tombstones via its own outbound calls. Specifically, the workspace-create flow today is auth-side (RunTask creates the daemon container); the daemon's role is post-RunTask. So this is largely cross-stream — daemon stream confirms it has no contribution to make and surfaces the decision back to the operator.

**Files touched:** none in this stream.

**Acceptance criteria:**

- Confirm via grep: `provisioning_failed` does not appear in any AGPL daemon source. (It's a `WorkspaceRecord.state` value owned by the proprietary side.) If a daemon-side write to this state exists, the daemon stream flags and resolves with PLAN-auth-and-shared.
- Surface the open question (a/b/c above) to the operator's synthesis round (O-3 below).

**Size:** 0 (cross-stream coordination only).

---

## CDK / IAM impact (mandatory, per `orchestra-cloud-private/D-2-plans/PLAN-template-snippet.md`)

> **CDK / IAM impact (mandatory).** Does this PR / phase add any of:
>
> - a new env var on a consuming service?
> - a new IAM grant on a producing service (auth, daemon, lifecycle worker)?
> - a new ALB route or listener rule?
> - a new Secrets Manager prefix?
> - a new DDB table or partition-key shape?
> - a new EventBridge rule, EventBridge Scheduler schedule group, SQS queue?
> - a new KMS CMK or alias scheme?
> - a new IAM role (per-workspace, lifecycle-worker, etc.)?
> - a new Route 53 record or ACM domain?
> - a new CloudWatch log group naming convention?

**Answer (this stream's scope):**

| Concern                                              | Yes/No                                                                                                                                                                                                                                                                                                                                                                                                                                                | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New env var on a consuming service                   | **Yes**                                                                                                                                                                                                                                                                                                                                                                                                                                               | `ORCHESTRA_PROVIDER_SNAPSHOT_URL` (T-9; the daemon reads the out-of-band provider catalog from this URL); `ORCHESTRA_WEBHOOK_SINK_URL` (T-8; daemon emits webhooks to this URL; if unset, no-op). Both injected into the per-workspace daemon ECS task definition. **PLAN-cdk-infra must add these as task-definition environment fields.**                                                                                                                                                                                                                                                                                                                                                                                                                      |
| New IAM grant on a producing service                 | **Yes**                                                                                                                                                                                                                                                                                                                                                                                                                                               | Daemon task role needs (a) DDB `GetItem`/`PutItem`/`Query`/`DeleteItem` on the per-workspace partition prefix for the NEW DDB partitions (`<workspaceId>#chat`, `<workspaceId>#chat#msg`, `<workspaceId>#schedule`, `<workspaceId>#schedule#run`, `<workspaceId>#loop`, `<workspaceId>#loop#iteration`, `<workspaceId>#loop#log`, `<workspaceId>#permission`, `<workspaceId>#agent#timeline`); (b) S3 `GetObject`/`PutObject` on `s3://orchestra-<stage>-loop-logs/<workspaceId>/*` for T-3 (loop logs offload); (c) S3 `GetObject` on the provider-snapshot bucket (T-9). All scoped via the existing per-workspace IAM role machinery (D-2 ACCEPTANCE entry, LEARNINGS.md:2657). **PLAN-cdk-infra extends `packages/infra/lib/workspace-role-template.json`.** |
| New ALB route or listener rule                       | **No.** All daemon-inbound paths stay on the existing `/ws` + `/api/*` + `/mcp/agents` routes. T-10 verifies the existing routing matches the new MCP test expectations.                                                                                                                                                                                                                                                                              |
| New Secrets Manager prefix                           | **No.** Per-workspace Anthropic credential prefix from D-1.5 (`paseo-cloud/<account>/<workspace>/anthropic-credential`) is unchanged.                                                                                                                                                                                                                                                                                                                 |
| New DDB table or partition-key shape                 | **Yes (many).** The 9 partition-key prefixes above. **All keyed by `<workspaceId>` first**, preserving the F3 design-out (workspace identity not on the wire — derived from JWT at boot, then used as the partition-key root). **Owned by PLAN-auth-and-shared** (the shapes live in `@orchestra/cloud-shared/keys.ts`); this stream consumes the helpers. **PLAN-cdk-infra adds the DDB table-level config** (per-key projection, GSIs — see below). |
| New EventBridge Scheduler schedule group / SQS queue | **No on this stream's side.** The schedule-firing register/deregister mechanism (T-2) goes through `/api/auth-internal/schedule-{registered,deregistered}` on the auth service; **PLAN-lifecycle-worker** is the EventBridge Scheduler caller and owns the schedule-group config.                                                                                                                                                                     |
| New KMS CMK or alias scheme                          | **No.** Per-workspace CMK from D-2 (`alias/orchestra/<stage>/workspace/<workspaceId>`) is reused for any new at-rest encryption.                                                                                                                                                                                                                                                                                                                      |
| New IAM role                                         | **No.** The per-workspace daemon task role from D-2 is extended with new grants (above), not replaced.                                                                                                                                                                                                                                                                                                                                                |
| New Route 53 record or ACM domain                    | **No.** D-2's per-workspace ALB rule + subdomain pattern is unchanged.                                                                                                                                                                                                                                                                                                                                                                                |
| New CloudWatch log group naming convention           | **No on this stream's side.** Per-tenant log group from D-2 (`/orchestra-cloud/<account>/<workspace>/daemon`) is unchanged. **PLAN-cdk-infra owns** the EMF metric publisher addition (`observability.md:88` — "structured CloudWatch fields per log line" + the 5-EMF-metric pattern).                                                                                                                                                               |

**Cross-stream CDK pin sequencing (the lesson from D-2 PR #11 / #34): PLAN-cdk-infra must deploy the new DDB table shapes + the per-workspace IAM grant extensions BEFORE the daemon stream's PRs land**, OR PLAN-auth-and-shared lands a shim that no-ops cleanly when the partitions don't yet exist (preferred Day-1; the daemon's `loadAll` at boot tolerates an empty partition by returning empty arrays — that's the safe fall-through). Either order works but the explicit-order-or-shim discipline is what avoided D-1.5's three deploy-recovery PRs.

---

## Cross-stream dependencies

| Dep                                                                                                         | This stream → other                                               | Other → this stream                                                                                                                 | Resolution mechanism                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat / schedule / loop / permission / agent-timeline DDB row shape pins (`@orchestra/cloud-shared/keys.ts`) | **Consumed by** this stream (T-1, T-2, T-3, T-4, T-6)             | **Authored by** PLAN-auth-and-shared                                                                                                | Joint note pinning the 9 partition-key prefixes + sort-key compositions. Daemon stubs the helpers locally with a TODO until the cloud-shared release lands; swap to import after.                                                                                                                                           |
| `POST /api/auth-internal/schedule-{registered,deregistered}` routes                                         | **Emitted by** this stream's T-2                                  | **Consumed by** PLAN-auth-and-shared (persists or proxies to EventBridge) and PLAN-lifecycle-worker (the actual EventBridge caller) | Joint note pinning the wire shape `{ workspaceId, scheduleId, nextRunAt, cadence }` for registered + `{ workspaceId, scheduleId }` for deregistered.                                                                                                                                                                        |
| Provider snapshot publication pipeline                                                                      | **Consumed by** this stream's T-9                                 | **Authored by** PLAN-cdk-infra (CI step that builds the snapshot per release)                                                       | Snapshot JSON shape pinned in `ProviderSnapshotEntry` schema; pipeline publishes to S3 with a `latest` tag the daemon reads via env var.                                                                                                                                                                                    |
| Per-workspace IAM extensions (DDB partitions + S3 buckets + provider-snapshot S3)                           | **Consumed by** this stream (T-1, T-2, T-3, T-4, T-6, T-9)        | **Authored by** PLAN-cdk-infra                                                                                                      | New grants land in `workspace-role-template.json`. Daemon hands-on probes (cross-tenant denials still hold) verify per the D-2 ACCEPTANCE pattern.                                                                                                                                                                          |
| S3 bucket `orchestra-<stage>-loop-logs/<workspaceId>/*`                                                     | **Consumed by** this stream's T-3                                 | **Authored by** PLAN-cdk-infra (bucket + lifecycle rule + per-workspace IAM grant)                                                  | Path shape pinned: `<workspaceId>/<loopId>/<seqStart>-<seqEnd>.jsonl`.                                                                                                                                                                                                                                                      |
| Per-tenant CloudWatch log group + EMF metric publisher                                                      | **Emitted by** this stream's daemon (structured log lines)        | **Authored by** PLAN-cdk-infra (the log group; the metric extractor)                                                                | Structured field schema per `observability.md:88` (`ts`, `level`, `account_id`, `workspace_id`, `agent_id?`, `ws_session_id?`, `rpc_family?`, `rpc_type?`, `request_id?`, `latency_ms?`, `event`). The daemon's logger already emits structured JSON; this stream may need to extend log-line content for new RPC families. |
| `/mcp/agents/*` SG / PrivateLink network isolation                                                          | **Verified by** this stream's T-10 (daemon-side defense-in-depth) | **Authored by** PLAN-cdk-infra (the SG / PrivateLink config)                                                                        | Daemon middleware test asserts the workspace-bound denial; CDK enforces the L4 isolation.                                                                                                                                                                                                                                   |
| 429 + rate-limit headers response shape on auth-internal routes                                             | **Consumed by** this stream's T-12                                | **Authored by** PLAN-auth-and-shared                                                                                                | Joint note pinning the 429 body + headers; daemon's `cloud-hmac-fetch.ts` parses + propagates.                                                                                                                                                                                                                              |
| Webhook subscriber endpoint (no-op log writer Day-1)                                                        | **Emitted by** this stream's T-8                                  | **Authored by** PLAN-auth-and-shared OR PLAN-lifecycle-worker                                                                       | Day-1: any endpoint that returns 2xx; bonus: log the body to a CloudWatch log group for operator visibility.                                                                                                                                                                                                                |
| `ORCHESTRA_PROVIDER_SNAPSHOT_URL` env var injection                                                         | **Consumed by** this stream's T-9                                 | **Injected by** PLAN-cdk-infra (ECS task definition)                                                                                | URL points at the snapshot S3 object (or a CloudFront distribution); daemon validates the JSON via `ProviderSnapshotEntry` schema.                                                                                                                                                                                          |
| `ORCHESTRA_WEBHOOK_SINK_URL` env var injection                                                              | **Consumed by** this stream's T-8                                 | **Injected by** PLAN-cdk-infra                                                                                                      | If unset, all webhook emits no-op (Day-1 acceptable).                                                                                                                                                                                                                                                                       |
| App-side dispatch on `runs[N].status:"failed"`, `interrupt:true`, `loops[].text` cap message                | None (daemon emits the binding shapes)                            | **Authored by** PLAN-app                                                                                                            | Round-19 captures referenced from `examples/` — both sides must reference the same captures to avoid drift.                                                                                                                                                                                                                 |
| App-side dispatch on `rpc_error{code:"quota_exceeded"}`                                                     | **Emitted by** this stream's T-12                                 | **Authored by** PLAN-app                                                                                                            | New typed code; back-compat fall-through to `handler_error` for old clients (per protocol-contract rule).                                                                                                                                                                                                                   |
| Heartbeat second-hop bug fix on the lifecycle-worker side                                                   | **Heartbeat emit unchanged** in this stream (D-2 T-4 shape)       | **Worker-side read shape** authored by PLAN-lifecycle-worker                                                                        | Contract test verifies the round-trip; T-13 confirms.                                                                                                                                                                                                                                                                       |

---

## Open questions / assumptions (for operator's synthesis round; do NOT decide here)

### O-1: Who fires `workspace.created` — the AGPL daemon or the auth service?

The `workspace.created` event is listed in `open-core-architecture.md:56-60` as an AGPL-core event. But the workspace-create flow today is auth-side (auth's `POST /api/v1/cloud/workspaces` issues `ecs:RunTask`). The daemon doesn't observe the workspace's first existence on its own — it learns about itself at boot via `PASEO_WORKSPACE_ID`. Two interpretations:

- **A — daemon emits.** The daemon emits `workspace.created` on first-boot per workspace (gate on a "boot is first lifetime" flag persisted in DDB at first heartbeat). Preserves "AGPL core emits its own externally-observable behavior." Cost: re-firing risk if the daemon respawns and the flag write fails — needs idempotency on the subscriber side.
- **B — auth emits.** The auth service emits `workspace.created` immediately after the DDB write succeeds, before the RunTask succeeds. Decouples the event from container start latency. **Boundary blur:** the AGPL core's documented event catalogue gets emitted by a proprietary service. The spec doc would need to clarify this (open-core-architecture.md:54 says "The AGPL core emits events to a configured webhook endpoint" — strictly, this means the auth service is doing AGPL-core-defined emission).

**This stream's recommendation:** B (auth emits) — minimizes the daemon's bootstrap complexity and avoids the idempotency requirement on the subscriber side. But the doc needs updating to say "the open-core boundary's webhook catalogue can be emitted by either the AGPL core OR a proprietary service, provided the schema is AGPL-core-defined." Decision needed before T-8 closes.

### O-2: Should an `archived` workspace's schedule fire?

T-7 above raises the case: a schedule was created when the workspace was `active`. The workspace is now `archived` (per D-2's workspace-lifecycle.md). The schedule's `cloudOwnerWorkspaceId` points at the archived workspace. When EventBridge Scheduler fires at `nextRunAt`, the lifecycle worker spawns the daemon container... but the workspace is archived. What happens?

- **A — schedule fires, daemon starts, agent runs.** The user expects "I archived this workspace; nothing should happen there." Violates user expectation.
- **B — schedule is deregistered on archive, never fires.** Preserves user expectation. Requires the archive flow (PLAN-auth-and-shared T-13) to walk the workspace's schedule partition and deregister each one. The schedule's DDB row could be retained for un-archive recovery.
- **C — schedule fires, daemon starts, agent immediately rejects with `archived` error.** Wasteful (RunTask cost) but covers user expectation. Worth measuring.

**This stream's recommendation:** B. But the archive flow is PLAN-auth-and-shared's territory; this stream surfaces the question only.

### O-3: `provisioning_failed` cap-trap fix path (a/b/c from LEARNINGS 2026-05-25 operator UAT)

Recapping the three options for the `provisioning_failed` cap-trap:

- (a) make `provisioning_failed → archived` a legal transition;
- (b) have rollback `DeleteItem` instead of writing tombstones;
- (c) add a lifecycle-worker sweep for stale `provisioning_failed`.

The daemon stream has no preference and surfaces the decision back to the operator. **Recommendation: (b)** — rollback should clean up its own mess; tombstones in the cap-counter are a confusing UX. But the decision sits with PLAN-auth-and-shared.

### O-4: S3 offload threshold for loop logs (T-3)

The default of N=1000 is arbitrary. A loop that completes 10 iterations in 1 minute will not hit this; a loop that runs for hours and produces N>1000 log entries will. The trade-off: smaller N means more S3 writes (latency + cost); larger N means the DDB row grows (DDB item-size cap is 400KB). The pure-DDB approach (no S3) caps out at the DDB item size; pure-S3 has high read latency for short loops.

**Recommendation:** start with N=1000. Tune post-Day-1 based on observed loop log sizes. The store layer's threshold is configurable via env (`ORCHESTRA_LOOP_LOGS_DDB_THRESHOLD`).

### O-5: Webhook delivery — should we add a retry layer at the daemon side (separate from EventBridge Scheduler retry)?

D-2's webhook emit primitive is single-shot (no retries; the spec says EventBridge retries). But `agent.turn_completed` (T-8) is NOT EventBridge-driven; it fires from the daemon's turn-end hook directly. If the subscriber endpoint is down, the event is lost.

- **A — accept loss Day-1.** Subscriber is no-op anyway; the Day-N billing module would add its own retry layer.
- **B — daemon-side retry (1 retry with 5s backoff).** Cost: complexity in the emit primitive; risk of duplicate delivery.
- **C — emit to a daemon-internal queue (in-memory ring buffer) and retry up to N times.** More robust; OOM risk for high-rate events.

**Recommendation:** A — accept loss Day-1. The billing module is the layer that cares about exactly-once; defer its retry-semantics design to D-4 when the module lands.

### O-6 (LOW): Provider-snapshot freshness vs daemon image immutability

T-9's image-baked fallback (`/paseo/provider-snapshot.json`) creates a tight coupling between the daemon image's tagged version and the provider catalog version. If a new provider lands between image releases, the URL-fetch path picks it up; the fallback does not. This is acceptable Day-1, but worth noting: when the URL fetch fails for an extended period, the daemon serves a stale catalog. The TTL refresh (default 5 min) bounds the staleness window — but if the URL is down for hours, the fallback is hours-stale. Surface to PLAN-cdk-infra: ensure the URL has high availability (CloudFront with origin failover, or similar).

---

## Verification commands (operator)

A short script to confirm the stream is done. Each command corresponds to one acceptance criterion above.

```bash
# T-1 — DynamoChatStore round-trip
cd paseo-fork
npx vitest run packages/server/src/server/chat/dynamo-chat-store.test.ts --bail=1
npx vitest run packages/server/src/server/chat/chat-service.store-contract.test.ts --bail=1
# Expect: green.

# T-2 — DynamoScheduleStore round-trip + EventBridge notify
npx vitest run packages/server/src/server/schedule/dynamo-store.test.ts --bail=1
npx vitest run packages/server/src/server/schedule/service.store-contract.test.ts --bail=1
# Hands-on (deployed):
# - Create a schedule with cadence:"every", everyMs:60000, maxRuns:3.
# - Disconnect the WS client. Wait 3 minutes.
# - Reconnect, schedule/inspect — expect runs.length === 3, status:"completed".
# - Verify EventBridge Scheduler has the schedule registered (proprietary side).

# T-3 — DynamoLoopStore round-trip + S3 offload
npx vitest run packages/server/src/server/dynamo-loop-store.test.ts --bail=1
# Hands-on:
# - Run a loop with maxIterations:5 + sleepMs:0 + verifyPrompt that fails.
# - loop/inspect returns status:"failed" with a final logs[].text containing
#   "Reached max iterations (5)." (round-19 BINDING).

# T-4 — DynamoPermissionStore round-trip (interrupt:true + interrupt-omitted)
npx vitest run packages/server/src/server/agent/permission-store.test.ts --bail=1
# Hands-on:
# - Agent in modeId:"default" runs `curl https://example.com`.
# - Client sends agent_permission_response{behavior:"deny", interrupt:true}.
# - Agent transitions to status:"error", attentionReason:"error".
# - Client sends agent_permission_response{behavior:"deny", message:"r19"}.
# - Agent emits assistant_message describing rejection, then turn_completed.

# T-5 — Container-boot rehydration
# Hands-on: deploy a fresh daemon container with PASEO_CLOUD_MODE=1.
# - Before StopTask: create 1 schedule + 1 loop + 5 chat messages.
# - StopTask + RunTask (capacity manager — proprietary).
# - Reconnect; schedule/list + loop/list + chat/list return the prior state.
# - daemon.log shows "Rehydration completed" before the first WS upgrade lands.

# T-6 — agent_stream catchup
# Hands-on:
# - Subscribe to an agent's stream; receive 50 events.
# - Disconnect.
# - StopTask + RunTask (cross-restart simulation).
# - Reconnect; fetch_agent_timeline_request{direction:"after", cursor:{epoch,seq:30}}
#   returns events 31..50 (the post-disconnect window).

# T-7 — schedule/loop fire with workspace ALS restored
# Hands-on:
# - Create a schedule with cadence:"every", everyMs:60000.
# - daemon.log grep for "workspace auth context" — expect NO matches over 5 min.
# - The schedule's persisted record has cloudOwnerWorkspaceId === PASEO_WORKSPACE_ID.

# T-8 — Webhook event catalogue
# - ORCHESTRA_WEBHOOK_SINK_URL=https://httpbin.org/post (or a no-op log writer)
# - Run an agent; turn completes.
# - daemon.log shows "Webhook emit delivered" with eventType:"agent.turn_completed".

# T-9 — Out-of-band provider snapshot
# Local:
docker run --rm -e PASEO_CLOUD_MODE=1 \
  -e ORCHESTRA_PROVIDER_SNAPSHOT_URL=https://example.invalid/snapshot.json \
  <ecr>/paseo-daemon:dev-latest
# Expect: daemon falls back to /paseo/provider-snapshot.json baked into the image.

# T-10 — /mcp/agents workspace-bound JWT
npx vitest run packages/server/src/server/bootstrap.workspace-binding.test.ts --bail=1
# Hands-on:
# - Mint a workspace-A token. Request POST /mcp/agents on workspace-B daemon URL.
# - Expect 401 with "workspace token mismatched daemon binding" in daemon.log.

# T-11 — Probe 7 WebSocket variant
npx vitest run packages/server/src/server/cloud-auth.workspace-binding.test.ts --bail=1
# Hands-on:
# - WS upgrade with paseo.workspace.<token-for-A> to workspace-B daemon URL.
# - Expect WS close code 4401.
# - Capture artifact in D-3-plans/probe-7-ws-results.md.

# T-12 — Quota / 429 propagation
# Hands-on:
# - Configure auth-service to return 429 on schedule-registered for a workspace.
# - schedule/create in that workspace returns rpc_error{code:"quota_exceeded"}.

# Final D-3 hands-on gate (ROADMAP § Phase D-3, lines 200-211):
# - Schedule, loop, permission, agent_stream catchup all work end-to-end
#   under cross-restart and disconnect-reconnect scenarios.
```

---

## Risks / known-hard parts

1. **DDB row shapes are a 9-partition extension to `@orchestra/cloud-shared/keys.ts` — the cross-stream contract is the largest of any D-3 stream.** A typo in a partition prefix (e.g., `<workspaceId>#chat#message` vs `<workspaceId>#chat#msg`) is invisible until rehydration silently returns empty. The D-2 lesson (LEARNINGS 2026-05-25 ECS-tagresource bite × 4) applies: every helper added to `cloud-shared/keys.ts` should be paired with a daemon-side consumer test BEFORE any deploy. The anti-drift guard from D-1.5 (still open) becomes load-bearing here — without it, the daemon and the lifecycle worker can drift in opposite directions.

2. **Daemon-restart auto-stop for loops MUST preserve `loop.md:332-343` exactly.** A cross-tenant test where the daemon is suspended → resumed mid-loop must show `status:"stopped"`, `failureReason:"Daemon restarted"` on the iteration, and the final log entry. Failing this is a silent regression — the loop will look "still running" to the client until the next mutation, then transition; the client's polling will see an inconsistent state. Add a regression test that simulates the restart explicitly.

3. **Permission store on-host parity (T-4) introduces persistence where there was none.** Self-host operators upgrading past the D-3 release land a new directory under `$PASEO_HOME/permissions/`. The directory shape is forward-compat (the on-host file path is opaque to operators), but document in the AGPL fork's CHANGELOG so operators know to expect the new dir.

4. **`agent_stream` cross-restart catchup (T-6) lays a new contract on the durable-store side: the in-memory window cap + the older-rows-from-store path.** Long-lived agents (1M+ rows) is a Day-N concern today but the cap design happens at D-3. If the cap is too aggressive, paginated history reads (UI scroll-back) hit DDB more than expected; if too generous, the daemon's memory grows linearly. Default 10K rows; tunable.

5. **The fail-loud branch in `cloud-credentials.ts:170-174` is the "canary" for T-7.** The whole D-3 closure depends on that branch never firing under normal operation. A regression test that asserts "no `workspaceAuthStorage` errors in daemon.log during a 10-minute schedule firing run" is the load-bearing check. Without it, T-7 looks done but is brittle.

6. **Provider snapshot bundling (T-9) creates a CI-side dependency on `PLAN-cdk-infra`'s snapshot-publish step.** If the daemon image is rebuilt without the snapshot file, the image fallback path is missing. The Dockerfile must FAIL the build if the snapshot is absent (rather than COPY a 0-byte file). Add `--from=<snapshot-builder>` discipline.

7. **The new `rpc_error{code:"quota_exceeded"}` (T-12) is the FIRST forward-compat-additive code in the catalog.** Existing typed codes are baked into the wire. A 6-month-old client will fall through to the `handler_error` default per `permission.md:259-261`, surface a generic error. The COMPAT comment in messages.ts should mark a 6-month removal date for the back-compat fall-through (per CLAUDE.md protocol-rules). Verify clients (mobile) ship the dispatch before the removal date.

8. **Webhook events are persistent contracts.** D-2 shipped one (`workspace.hard_delete_imminent`); D-3 adds two or three more. Once published, the schema is forever (`.optional()` extensions only). Every reviewer of T-8 should treat each new event as "API of last resort" per the D-2 PLAN-daemon's framing.

---

## Deferred follow-ups (filed, not bundled)

Surfaced while planning; NOT in scope for this PR — same anti-bundle discipline D-1.5 / D-2 closeout used.

1. **The `cloudOwnerWorkspaceId` / `cloudOwnerAccountId` rename across schedule + loop + agent records (T-7) — adopt a single canonical name** when the proprietary side settles on `tenantId` per the D-1.5/D-2 deferred item. Today's `workspaceId` / `accountId` (camelCase, paired) match the JWT claim shape but collide with on-host worktree `workspaceId`. Rename in one sweep.

2. **Schedule firing while archived (O-2 open question) — once decided, codify in the AGPL fork's docs.** The AGPL fork is the source of `archive_workspace_request` on-host RPC semantics; cloud-side schedule-archive coordination must be documented in `workspace-lifecycle.md` once chosen.

3. **Loop logs S3 lifecycle policy.** Day-1: store indefinitely. Day-N: per-plan retention (free tier 30d, paid tier 1y, etc.). Daemon stream's piece is to ensure the path shape allows lifecycle rules; PLAN-cdk-infra owns the actual rule.

4. **Agent timeline durable-store TTL.** Day-1: store indefinitely. Day-N: a TTL for archived workspaces (`archived` + 30d → purge with the workspace). The path partition prefix `<workspaceId>#agent#timeline` makes per-workspace cleanup tractable.

5. **Webhook subscriber-side back-pressure / delivery acknowledgements.** Day-1: fire-and-forget. Day-N: when a real subscriber (billing module) lands, revisit at-least-once delivery semantics.

6. **The `daemonImageTag: "unknown"` carry-in (DEFERRED.md D-2) — flag for completion when CDK runtime injection lands.** D-2 carry-in to D-3+ from LEARNINGS.md:2391; CDK side owes it; this stream merely consumes the value.

7. **Per-account archived-workspace cap** (workspace-lifecycle.md:126 — TBD). Likely owned by PLAN-auth-and-shared, not the daemon.

8. **Anti-drift guard for AGPL ↔ proprietary duplicated schemas** — still open from D-1.5 (LEARNINGS.md:2398). D-3 adds the largest set of duplicates yet (9 DDB key-shape helpers). Single sweep, post-D-3.

9. **`/api/files/download` cross-instance token store.** ROADMAP § Phase D-3 lists this; **but** Day-1's single-daemon-per-workspace topology means there is no cross-instance case at the daemon side. The token is minted by the daemon's WS handler, redeemed by the same daemon's HTTP handler — both in the same container. **Nothing for this stream to do.** When/if Day-N introduces sticky-session-but-multi-instance (e.g., per-workspace daemon's HTTP and WS routed to different ALB targets), revisit. For Day-1, this is a no-op for daemon stream.

10. **EMF metric publisher per `observability.md:88` "5-EMF-metric pattern".** The 5 metrics from the prior attempt's Phase 39b. Daemon emits the structured log lines; PLAN-cdk-infra extracts. This stream's piece: ensure logger output is JSON with the required fields. The fields are already in the daemon's structured logger (`logger.ts`); confirm during T-1..T-9 implementation.

---

## Summary

- **T-1** `DynamoChatStore implements ChatStore` — load/save per `<workspaceId>#chat#room` + `<workspaceId>#chat#msg`; round-trip chat-lifecycle captures; cross-restart rehydration. **M.**
- **T-2** `DynamoScheduleStore implements ScheduleStore` + EventBridge Scheduler register/deregister notify — round-trip round-19 `runs[N].status:"failed"` (BINDING); 5-field cron rejection preserved; HMAC notify on every mutation. **L.**
- **T-3** `DynamoLoopStore implements LoopStore` + S3 offload — round-trip round-19 `maxTimeMs` cap (text in `logs[]`, not `failureReason`; BINDING); daemon-restart auto-stop preserved per `loop.md:332-343`. **L.**
- **T-4** NEW `PermissionStore` interface + `DynamoPermissionStore` + on-host `FileBackedPermissionStore` — round-trip both round-19 deny shapes (`interrupt:true` and `interrupt`-omitted). **L.**
- **T-5** Container-boot rehydration in cloud mode — populate ChatService / ScheduleService / LoopService / AgentManager from DDB before serving WS. **M.**
- **T-6** `agent_stream` catchup on cross-restart / reconnect — durable `DynamoAgentTimelineStore`; `(epoch, seq)` cursor semantics preserved (BINDING). **L.**
- **T-7** Persist `cloudOwnerWorkspaceId` + `cloudOwnerAccountId` on schedule/loop/agent records; restore ALS at fire time; eliminates the `cloud-credentials.ts:170-174` fail-loud branch for scheduled/loop/background spawns. **M.**
- **T-8** Webhook catalogue expansion — `workspace.created` + `agent.turn_completed`/`agent.turn_failed`. **M.**
- **T-9** Out-of-band provider snapshot consumer — F1 closed. ProviderSnapshotManager reads from URL + image-baked fallback. **M.**
- **T-10** `/mcp/agents/*` workspace-bound JWT enforcement regression test (defense-in-depth alongside CDK SG/PrivateLink). **S.**
- **T-11** Probe 7 WebSocket variant capture (D-2 ACCEPTANCE carry-in). **S.**
- **T-12** Quota / 429 propagation — new typed `rpc_error{code:"quota_exceeded"}`; back-compat fall-through to `handler_error` per protocol-contract rule. **M.**
- **T-13** D-2 heartbeat second-hop bug carry-in (verification; mostly cross-stream).
- **T-14** D-2 `provisioning_failed` cap-trap carry-in (cross-stream only; daemon has no contribution).

**Hardest part:** the 9 DDB row-shape contracts with `@orchestra/cloud-shared` (T-1..T-4, T-6). D-2's lesson — synthesis amendments must rewrite both sides of cross-stream contracts (LEARNINGS.md:2507-2511) — is load-bearing here. Without the anti-drift guard (deferred item #8), drift between the daemon's reader and the worker's writer is a silent class of failure.

**Total estimate:** ~12–18 days of focused engineering (excluding cross-stream coordination), assuming PLAN-auth-and-shared's `@orchestra/cloud-shared/keys.ts` extensions land before T-1 starts. The 4 stores (T-1..T-4) are the bulk of the work; T-5..T-7 wire them together; T-8..T-12 add the new surfaces.
