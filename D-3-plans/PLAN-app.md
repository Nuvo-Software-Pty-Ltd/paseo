# Plan: D-3 — App (Orchestra web client)

## Stream summary

D-3 ("Day-1 wire-surface completion") lights up the remaining Day-1 surfaces in the AGPL web client and folds in the D-2 cap-trap / `markStateActive` UX carryovers. This stream owns **everything in `paseo-fork/packages/app/`** plus the cross-repo D-3 plan doc itself; no source/infra changes in this PR, just the plan.

The locked architectural decisions (post-D-2 synthesis + 2026-05-25 acceptance entries) this stream consumes:

- **Schedule failure UI dispatch on `runs[N].status:"failed"`** (round-19 binding; example `paseo-cloud-daemon/examples/schedule-record/round-19-fired-failed-bad-cwd.json`). The wire shape is a free-form `runs[N].error` string + `agentId:null` + `output:null`. No top-level `failureReason`.
- **Loop cap-failure UI dispatch on `logs[].text`** (round-19 binding; example `paseo-cloud-daemon/examples/loop-record/round-19-loop-maxTimeMs-cap.json`). Top-level `status:"failed"` is set, but the human-meaningful cap-text lives in the last `logs[].text` ("Reached max time (1000ms).") — there is **no top-level `failureReason`** for the cap-class.
- **Permission deny bifurcation on `interrupt`** (round-19 binding; examples `examples/websocket/round-19-permission-deny-interrupt-{true,omitted}.jsonl`).
  - `interrupt:true` → hard abort: close prompt, surface abort banner, agent terminal state `status:"error"`, `attentionReason:"error"`.
  - `interrupt` omitted → graceful tool-error: prompt closes, the deny `message` is fed back to the tool result, agent continues turn and ends with `status:"idle"`, `attentionReason:"finished"`.
- **`agent_stream` epoch-aware catchup** (`paseo-cloud-daemon/10-interfaces/websocket/catalog/agent-stream.md` § Resumption). The session-stream reducer's `(epoch, seq)` cursor model already exists (`paseo-fork/packages/app/src/timeline/session-stream-reducers.ts:107-132`); D-3 lifts it into a reconnect-driven `fetch_agent_timeline_request{direction:"after", cursor, subscribe}` flow with a "Resuming from <timestamp>" indicator and suppression of local UI side-effects for catchup-classified items.
- **File-download token redemption is cross-instance** (`day-1-scope-recommendations.md` § HTTP routes). The WS RPC that mints a token and the HTTP redemption may land on different EC2 instances / daemon containers, so the existing `buildDownloadUrl` flow at `paseo-fork/packages/app/src/stores/download-store.ts:285-297` must continue to work without sticky routing assumptions.
- **Quota error envelope** surfaced by the daemon (5 cap classes per `statefulness-and-multitenancy.md` § "Per-workspace rate limits and quotas"): workspace count, agent count, API spend, push-token, EFS storage. The client renders the appropriate cap message + actionable affordance (Upgrade plan placeholder; Archive workspaces button).
- **Provider snapshot consumer wiring** (F1 design-out per `IMPLEMENTATION-ROADMAP.md` § "Architectural design-outs"). Today the app reads the snapshot from the per-session daemon client RPC (`paseo-fork/packages/app/src/hooks/use-providers-snapshot.ts:42-52`), which is exactly the F1 bug (relay-gated, no container pre-spawn). D-3 swaps in an out-of-band catalog query at app startup driven by an auth-service REST endpoint (or a static manifest); PLAN-auth-and-shared owns the upstream contract.
- **MCP per-tenant connection UX** (`subprocess-isolation.md` § "Provider auth side-channels"). Under daemon-per-workspace topology the MCP endpoint is intra-container loopback — but the _workspace-token-bound MCP URL_ construction lives in the agent-config flow, which D-1.5 already fixed (`packages/server/src/server/session.ts:1118-1141`) on the daemon side. The client surface is mostly "use the workspace-bound MCP URL the daemon emits in `welcome`/agent-config"; the verifiable change is to drop any path that hard-codes a non-workspace-bound MCP URL.
- **D-2 carryover — `provisioning_failed` cap-trap UX** (`LEARNINGS.md` 2026-05-25 D-2 operator-driven UAT). Auth-side picks the actual fix (delete-on-rollback / `provisioning_failed → archived` transition / lifecycle-worker sweep) per PLAN-auth-and-shared. App surfaces the user-visible error message when create rolls back, plus the recovery affordance ("This workspace failed to provision. Archive it to free up capacity." — fires the cloud-archive REST call which auth-and-shared makes legal for the `provisioning_failed` state if it picks fix (a)).
- **D-2 carryover — `markStateActive` premature-active gap** (`LEARNINGS.md` 2026-05-25 6/6 probes pass). Auth flips workspace to `active` the instant ECS `RUNNING` lands — _not_ when the daemon is healthy. Until auth-and-shared bolts on a `/api/health` gate, the client must tolerate a brief window where `state="active"` but the WS upgrade 502s / times out. D-3 hardens the post-create probe with a bounded health-poll + clear "still booting…" copy rather than the current hard-fail.

## Synthesis amendments (2026-05-26)

Operator accepted ALL synthesis recommendations from `d-3-plan-synthesis/D-3-plans/CROSS-STREAM-SYNTHESIS.md` (commit `9dc8972`). Four items in synthesis § 4 PLAN-app apply to this stream; three are confirmations that the existing plan already aligned, one is a pinning amendment.

| Synthesis item                                                  | Apply to PLAN-app                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Status                                                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **C2 — Provider snapshot source of truth** (`§ 1 C2`)           | App already calls `GET /api/v1/cloud/providers/snapshot` against the auth service (Task 4). Resolved direction: auth-served from a cloud-shared TS constant; daemon also imports the same constant; the S3 manifest path is **NOT** a live consumer Day-1. Implementation note pinned in Task 4 below: the app must **never probe S3 directly** for the snapshot; auth's REST endpoint is the only source.                                                                                            | Confirmed — no behavior change, one implementation note added to Task 4.                    |
| **C3 — Download token cross-instance ownership** (`§ 1 C3`)     | Resolved direction: auth-and-shared owns mint + redeem; auth's `GET /api/files/download/:tokenId` 302-redirects to the daemon's `/api/files/download/internal/:tokenId` (a new daemon route added per synthesis A4). The app's existing `stores/download-store.ts` mint-then-HTTP-redeem flow is cross-instance-by-construction; no client change. Hands-on probe in Task 11 stays as the verification gate.                                                                                          | Confirmed — no behavior change, one explanatory line added to Task 11.                      |
| **C5 — `provisioning_failed` cap-trap recovery** (`§ 1 C5`)     | Resolved direction: (a) make `provisioning_failed → archived` a legal transition + cap exclusion. PLAN-auth-and-shared implements the transition table change + cap exclusion; lifecycle-worker adds an orphan-detect signal for stale rows (D-3-5). Task 5's "Archive this failed workspace" affordance now has a guaranteed-legal call site and the contact-support fallback narrows to "auth's archive returned a 5xx network error" only.                                                         | Confirmed — no behavior change; Open Questions § 2 closes; the (b) and (c) fork is removed. |
| **A8 — Quota envelope shape + webhook env var name** (`§ 2 A8`) | Operator-locked shape: cloud-shared exports `rpc_error{code:"quota_exceeded", quotaClass, current, cap}`; PLAN-daemon emits it on WS quota failures and PLAN-auth-and-shared's REST `quota/check` returns the same payload on `429` along with `X-RateLimit-*` headers. Discriminator values: `workspace_count`, `agent_count`, `api_spend`, `efs_storage`, `push_token` (Open Questions § 1 closes). Task 8 imports the type from `@orchestra/cloud-shared` instead of the provisional inline shape. | Amended — Task 8 pinned.                                                                    |

These amendments do not change the closure criteria, the 12-task structure, or the cross-stream merge ordering. They harden the contract surface that Wave-B and the hands-on gate depend on.

## D-3 closure criteria (for this stream)

This stream closes when:

1. **Schedule failure UI** dispatches on `runs[N].status:"failed"` and renders `runs[N].error` verbatim + `scheduledFor`/`startedAt`/`endedAt` next to it. Tested against the round-19 fixture (bad cwd → `"Working directory does not exist: <path>"`); golden-path "succeeded" run still renders correctly.
2. **Loop failure UI** dispatches on top-level `status:"failed"` AND surfaces the trailing `logs[N].text` ("Reached max time …" / "Reached max iterations …") as the cap-class explanation. No reliance on a top-level `failureReason` field that does not exist.
3. **Permission deny UI** has two visibly distinct deny actions: "Stop the agent" (`interrupt:true`) which closes the prompt and shows an abort banner tied to the agent's `status:"error"`, and "Block this call" (`interrupt` omitted) which closes the prompt and lets the agent's next assistant message render as the deny-acknowledgment.
4. **`agent_stream` catchup** on reconnect emits a "Resuming from <timestamp>" indicator while `fetch_agent_timeline_request{direction:"after", cursor}` walks the gap; local-only UI side effects (toasts, sound, notifications, badge bumps) are suppressed for items inside the catchup window; epoch-mismatch is surfaced as a soft "Timeline restarted" notice rather than a silent rewind.
5. **File download** flow uses the existing mint-then-HTTP-redeem path (`stores/download-store.ts`) end-to-end and is verified against the dev stack with a token redeemed on a _different_ daemon container than the issuer (manual probe: scale-up the workspace's task family, mint on instance A, redeem on instance B). Failure mode is a clean "download expired" toast, not a silent hang.
6. **Quota error surfacing** renders distinct messages for each of the 5 cap classes (workspace, agent, API spend, push-token, EFS storage) plus the per-account workspace cap. Each has an "Upgrade plan" link (placeholder href; D-4 billing wires the destination) and, for the workspace-count + EFS classes, an "Archive workspaces" entry point that opens the project picker's Archived tab.
7. **Provider snapshot** is fetched at app startup via the out-of-band REST endpoint exposed by the auth service (path owned by PLAN-auth-and-shared). The daemon-RPC fallback inside `useProvidersSnapshot` is preserved for on-host operators (since the F1 design-out is cloud-specific), gated on cloud mode.
8. **MCP per-tenant URL** is the only MCP URL the agent-config flow uses. Grep across `packages/app/src/` returns no hard-coded MCP base URL — the URL comes from the daemon's `welcome` or agent-config response.
9. **`provisioning_failed` UX** — on workspace-create rollback, the user sees an explanatory inline error and an "Archive this failed workspace" affordance (calls auth-and-shared's `POST /api/v1/cloud/workspaces/:id/archive` once that route accepts `provisioning_failed → archived`). If auth picks a fix that doesn't expose archive of `provisioning_failed`, the app surfaces "Contact support" with the workspaceId pre-filled.
10. **`markStateActive` tolerance** — post-create, the client polls workspace health (auth-side `/api/v1/cloud/workspaces/:id` plus, where exposed, a daemon `/api/health` proxy) up to ~30 s before declaring the workspace ready. The setup-screen's `connectAndProbe` step is wrapped in a bounded retry instead of failing on the first 502.
11. **Hands-on D-3 gate** — operator drives every Day-1 surface by hand (`IMPLEMENTATION-ROADMAP.md:200-211`):
    - Create a 1-minute cron schedule with a deliberately bad cwd → see the failure row with the error string.
    - Run a loop with `maxTimeMs:1000` against a worker that overshoots → see the cap-class message in the loop UI.
    - Deny a Bash permission with `interrupt:true` → see the abort banner.
    - Deny a Bash permission without `interrupt` → see the agent acknowledge the deny and end the turn cleanly.
    - Disconnect mid-turn for ≥30 s, reconnect → see the "Resuming from <timestamp>" indicator, then the missed events.
    - Trigger a file download, verify token redeems even after a daemon container roll.
    - Hit `agentCountCap=10` → see the per-class quota toast + Upgrade link.
    - Trigger workspace-create rollback (bad repo or IAM-not-propagated) → see the cap-trap recovery affordance.
12. **No source/infra change in this PR.** This document is the plan only; implementation commits land separately on `paseo-fork`.

## Locked decisions inherited

| Decision                                 | Value                                                                                                     | Source                                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Cloud archive RPC                        | `POST /api/v1/cloud/workspaces/:id/archive` (session-token); NOT `archive_workspace_request` WS RPC       | `workspace-lifecycle.md:18`, 2026-05-22 synthesis                                                                         |
| Workspace state machine                  | `active` / `suspended` / `billing_locked` / `archived` / `(purged)`; plus transient `provisioning_failed` | `workspace-lifecycle.md`, PLAN-auth-and-shared § 12                                                                       |
| Pre-flight token-mint status codes       | `200` resume-active, `202` resuming, `409` archived, `402` billing_locked, `503` provisioning_failed      | PLAN-auth-and-shared Task 16, INTEGRATION-NOTE bug 3 fix                                                                  |
| Workspace-token TTL boundary             | open WS continues past `exp`; fresh upgrade is 4401                                                       | `paseo-cloud-daemon/70-security/saas-auth.md` (D-1.5 capture); `examples/ws/captures/workspace-token-ttl-boundary.ndjson` |
| Permission `deny.interrupt` semantics    | bifurcation captured round 19                                                                             | `10-interfaces/websocket/catalog/permission.md` § "`deny` side-effects"                                                   |
| Schedule `runs[N].status:"failed"` shape | free-form `error:string`, `agentId:null`, `output:null`                                                   | round 19 capture                                                                                                          |
| Loop cap-failure shape                   | top-level `status:"failed"`, message in trailing `logs[].text`                                            | round 19 capture                                                                                                          |
| `agent_stream` cursor                    | `(epoch, seq)`; `fetch_agent_timeline_request{direction:"after", cursor, subscribe}` for resume           | `agent-stream.md` § Resumption                                                                                            |

## Critical files

### App package (`paseo-fork/packages/app/`)

Read-only context — none of these is edited by this plan PR. The implementation PRs will touch these:

- `src/screens/orchestra/orchestra-setup-screen.tsx` (524 lines) — workspace + Anthropic-credential wizard. Add the `markStateActive` tolerance + `provisioning_failed` recovery affordance here.
- `src/contexts/session-context.tsx` (1870 lines) — owns the `agent_permission_request` / `_resolved` subscriptions at lines 1291-1310. Adds the deny-bifurcation action handlers here (or routes through the existing permission card).
- `src/components/agent-stream-view.tsx` — owns the in-timeline permission card (`PermissionRequestCard`); lines 1004-1095 currently emit only the `behavior:"deny"` (interrupt-omitted) deny. Add the `interrupt:true` action variant + the abort banner.
- `src/timeline/session-stream-reducers.ts` (1006 lines) — `(epoch, seq)` cursor logic already lives here; D-3 adds the catchup-window classification + UI side-effect suppression gate.
- `src/components/stream-strategy-web.tsx` — the WS reconnect glue; D-3 wires the `fetch_agent_timeline_request{direction:"after", cursor}` call on reconnect.
- `src/hooks/use-providers-snapshot.ts` — switch the snapshot source: out-of-band REST in cloud mode, fall back to RPC for on-host. The hook contract stays unchanged.
- `src/lib/orchestra-cloud-client.ts` — add `archiveWorkspace(workspaceId)` (POSTs to `/api/v1/cloud/workspaces/:id/archive`), `getProvidersSnapshot()` (out-of-band cloud catalog), plus quota-error parse helpers. The auth-side contracts come from PLAN-auth-and-shared.
- `src/stores/download-store.ts:240-296` — file-download mint-then-redeem flow. Verify behavior unchanged under cross-instance redemption; no code change expected, but the hands-on probe is part of the gate.
- New: `src/components/quota-error-banner.tsx` (or similar) — renders the 5 cap-class error envelopes with their actionable links.
- New: `src/components/schedule-failed-run-row.tsx` (or fold into existing schedule view if it exists post-D-1) — renders `runs[N].status:"failed"` rows.
- New: `src/components/loop-failure-summary.tsx` — extracts the trailing `logs[].text` cap-class message.
- New: `src/hooks/use-agent-timeline-catchup.ts` — owns the reconnect-driven gap-fill + "Resuming from <timestamp>" indicator state.

### Test files (vitest, alongside src as today)

- `src/timeline/session-stream-reducers.test.ts` — extend with catchup-window classification + side-effect-suppression assertions.
- `src/components/agent-stream-view.test.tsx` — assert the two deny variants render and dispatch distinct `response` shapes.
- `src/components/quota-error-banner.test.tsx` (NEW) — one assertion per cap class.
- `src/screens/orchestra/orchestra-setup-screen.test.tsx` — extend with `provisioning_failed` rollback + `markStateActive` health-poll cases.
- `src/hooks/use-providers-snapshot.test.ts` — cover the cloud-mode REST path + on-host RPC fallback.
- `src/lib/orchestra-cloud-client.test.ts` — extend with `archiveWorkspace` + the new pre-flight token-mint status codes (202/402/409/503).

## Approach

D-3 app work is **parallelizable in two waves** with one synchronization point:

1. **Wave A — surface dispatchers (round-19 wire shapes).** Schedule-failed UI, loop cap-failure UI, permission-deny bifurcation. Each is an independent component touch with a small reducer/test delta. No cross-stream dependencies.

2. **Sync point — auth-and-shared REST contracts.** Provider-snapshot out-of-band endpoint, pre-flight token-mint status codes, archive-of-`provisioning_failed` legality. Once PLAN-auth-and-shared lands these (D-3 phase 4, tracked there), Wave B can proceed.

3. **Wave B — reconnect / catchup / quotas / setup tolerance.** Agent_stream catchup hook, quota error envelope renderer, `markStateActive` health-poll, `provisioning_failed` recovery affordance. Each consumes a contract from Wave-A or auth-and-shared.

## Tasks

### Task 1 — Schedule failure-run UI dispatch (Wave A)

**Files:** `src/components/schedule-failed-run-row.tsx` (NEW), surrounding schedule list view (presumed to exist; if not, scaffolded as part of this task). Tests: `schedule-failed-run-row.test.tsx`.

**Behavior:**

- Component takes a `ScheduleRun` (shape from `10-interfaces/websocket/catalog/schedule.md` § `ScheduleRun`).
- Branches on `run.status`: `"running"` (spinner + scheduledFor relative time), `"succeeded"` (output preview, agentId link), `"failed"` (red icon, `run.error` verbatim, no agentId link because `agentId` may be `null`).
- Surrounding schedule list view shows the schedule's top-level `status:"completed"` even when the only run failed (round-19 binding: a `maxRuns:1` schedule that failed still flips to `completed`).
- The schedule-failure UI is _also_ the schedule's `lastRunAt` row in the projects picker — when an operator sees a recently-fired schedule that ended in failure, the entry surfaces an explicit "Last run failed at <time>" hint rather than a silent green checkmark.

**Acceptance criteria:**

- Round-19 fixture rendered: `error:"Working directory does not exist: /tmp/paseo-spec-r19-DOES-NOT-EXIST"` appears verbatim.
- Successful run renders the captured `output:"ok"` (round-14 fixture).
- `agentId:null` does not produce a broken agent link.
- Snapshot test of the row's accessibility text matches the cited wire shape.

**Wire shapes pinned:** `examples/schedule-record/round-19-fired-failed-bad-cwd.json` (failed), `examples/schedule-record/fired-one-shot.json` (succeeded).

**Size: M.**

### Task 2 — Loop cap-failure UI dispatch (Wave A)

**Files:** `src/components/loop-failure-summary.tsx` (NEW), surrounding loop detail view. Tests: `loop-failure-summary.test.tsx`.

**Behavior:**

- Takes a `LoopRecord` with `status:"failed"`.
- Walks `logs[]` in reverse, picks the first entry where `source === "loop" && level === "error"`. The text of that entry is the cap-class message ("Reached max time (Nms).", "Reached max iterations.", etc.).
- If no such entry exists (e.g., worker-crash class), falls back to the last log entry's `text` regardless of source/level, prefixed with "Loop failed: ".
- Above the summary, lists the failed `iterations[N]` with their `failureReason` (which DOES exist on iterations, unlike the top-level loop — distinct from the top-level cap message).

**Acceptance criteria:**

- Round-19 fixture rendered: top summary reads "Reached max time (1000ms)."; below, iteration 1 shows `failureReason:"Verify check failed: false"`.
- A fabricated `maxIterations` cap fixture renders "Reached max iterations." correctly (the wording is daemon-side, but the test fixture mirrors the round-19 capture pattern).
- No reference to a top-level `failureReason` field anywhere in the code or tests.

**Wire shape pinned:** `examples/loop-record/round-19-loop-maxTimeMs-cap.json`.

**Size: M.**

### Task 3 — Permission deny bifurcation (Wave A)

**Files:** `src/components/agent-stream-view.tsx:990-1095` (existing permission card), `src/contexts/session-context.tsx:1291-1310` (subscription glue if any side-effect lives there). Tests extend `agent-stream-view.test.tsx`.

**Behavior:**

- The default action list (`resolvedActions` at lines 997-1019) currently has one Deny action emitting `behavior:"deny"` without `interrupt`. Replace with TWO defaults when `request.actions` is empty:
  - "Block this call" → `{behavior:"deny", selectedActionId, message: <user-typed-or-default>}` (interrupt omitted; graceful tool-error).
  - "Stop the agent" → `{behavior:"deny", selectedActionId, message: <user-typed-or-default>, interrupt: true}` (hard abort).
- When the request carries `request.actions[]` (provider-supplied actions), the client respects those verbatim; the two defaults only apply to actionless requests.
- On `interrupt:true` resolution, listen for the agent's `agent_stream` `turn_failed` event and render an abort banner that ties to the agent's `status:"error"` + `attentionReason:"error"`. Banner text: "You stopped this agent. Send a message to continue." with a "Dismiss" affordance that clears `attentionReason` via the existing `useAgentAttentionClear` hook.
- On `interrupt`-omitted resolution, no extra UI work — the existing agent_stream renders the agent's `assistant_message` summarizing the deny.

**Acceptance criteria:**

- Round-19 capture replayed in unit test: `interrupt:true` triggers banner; agent's terminal state matches `status:"error"` end-state.
- Round-19 capture replayed: `interrupt`-omitted does NOT trigger banner; agent's `turn_completed` flows through naturally.
- The user-typed deny message reaches the wire as `response.message` in both branches.
- The "Stop the agent" action is visually distinguished (e.g., destructive variant) from "Block this call".

**Wire shapes pinned:** `examples/websocket/round-19-permission-deny-interrupt-true.jsonl`, `examples/websocket/round-19-permission-deny-interrupt-omitted.jsonl`.

**Size: M.**

### Task 4 — Provider-snapshot out-of-band wiring (Sync point + Wave B)

**Files:** `src/hooks/use-providers-snapshot.ts`, `src/lib/orchestra-cloud-client.ts` (new `getProvidersSnapshot()`), tests.

**Behavior:**

- At app startup (after session-token presence is confirmed), call `await getProvidersSnapshot()` against the auth service's new REST endpoint (path is PLAN-auth-and-shared's call; this plan assumes `GET /api/v1/cloud/providers/snapshot` returning `{entries: ProviderSnapshotEntry[], generatedAt: string}`).
- Seed the React Query cache at `providersSnapshotQueryKey(null)` with the response. The existing `useProvidersSnapshot(serverId)` hook reads this when `serverId === null` (no active session yet) and falls through to the daemon-RPC path when a session is connected (preserves on-host operator behavior).
- The daemon-RPC path is the **fallback** — the F1 design-out specifies the cloud client must not need a running container to render the provider picker.

**Cross-stream pin:** PLAN-auth-and-shared owns the endpoint shape and adds it under its `/api/v1/cloud/*` namespace (session-authed). Pin this in the cross-stream pins table below.

**Synthesis amendment (2026-05-26, ref CROSS-STREAM-SYNTHESIS § 1 C2):** the auth REST endpoint is the **only** Day-1 consumer surface for the provider snapshot. The implementation MUST NOT also probe `s3://orchestra-cloud-workspaces-<stage>/_meta/providers-snapshot.json` directly — the S3 path remains as an ops-only artifact (publishable from CI) but is not load-bearing and the app has no AWS credentials to read it anyway. Grep gate: no `s3://` or `s3.amazonaws.com` literal in `src/hooks/use-providers-snapshot.ts` or `src/lib/orchestra-cloud-client.ts`. Daemon imports the same shape via the cloud-shared TS constant (PLAN-daemon T-9 rewritten per synthesis); anti-drift CI catches divergence between daemon import and auth-served constant.

**Acceptance criteria:**

- App startup with no active session populates the provider picker (verified by an integration test that calls `getProvidersSnapshot()` with a mocked auth service).
- On-host operator flow (no auth service) continues to use the daemon RPC unchanged.
- The provider picker never renders "No models match your search" pre-spawn (the F1 bug).
- No direct S3 access from the app (synthesis C2).

**Wire shape pinned:** `paseo-cloud-daemon/.audit/2026-05-07-prior-attempt-postmortem.md` § F1 (F1 bug description).

**Size: M.**

### Task 5 — Cloud archive REST consumer + `provisioning_failed` recovery affordance (Wave B)

**Files:** `src/lib/orchestra-cloud-client.ts` (new `archiveWorkspace`), `src/screens/orchestra/orchestra-setup-screen.tsx`, `src/components/project-picker-modal.tsx` (existing — extend the cloud-workspaces section with an Archived tab). Tests extend each.

**Behavior:**

- `archiveWorkspace(workspaceId)`: `POST /api/v1/cloud/workspaces/:id/archive` (session-authed). Surfaces `OrchestraSessionExpiredError` on 401 (existing pattern).
- Project-picker modal: add an "Archived" tab that lists workspaces with `state:"archived"`. Each row shows the relative-time `archivedAt` + "Unarchive" button (calls `unarchiveWorkspace(workspaceId)`, which auth-and-shared also exposes) + an inline "Permanently removed in N days" countdown.
- Setup-screen: when `createWorkspace()` returns a `provisioning_failed` state, render an inline error:
  - "This workspace failed to provision. Archive it to free up capacity." + an [Archive] button → calls `archiveWorkspace(workspaceId)`.
  - If `archiveWorkspace` returns 4xx on `provisioning_failed` (auth picked fix (b) or (c) — see PLAN-auth-and-shared § "Surfaced for operator decision"), fall through to: "Contact support — workspace ID: `<id>`."

**Cross-stream pin:** PLAN-auth-and-shared owns whether `provisioning_failed → archived` is a legal transition. **Synthesis amendment (2026-05-26, ref CROSS-STREAM-SYNTHESIS § 1 C5):** operator picked (a) — the transition IS legal and PLAN-auth-and-shared implements it + cap exclusion. The contact-support fallback narrows from "auth picked a different fix" to "auth's archive route returned a 5xx network error during recovery"; the affordance is the load-bearing recovery path under normal operation.

**Acceptance criteria:**

- Archive flow round-trip works against the dev stack: create → archive → reappears in Archived tab → unarchive → reappears in active picker.
- `provisioning_failed` recovery shows the right copy and dispatches the right call.
- D-1.5 regression: deleting a workspace (the D-1.5 atomic-delete REST path) is NO LONGER user-facing — the archive flow is the only user-driven destructive action per `workspace-lifecycle.md` § Day-1 simplifications. (Verify no UI affordance exposes the old DELETE.)

**Wire shapes pinned:** PLAN-auth-and-shared Task 13 (`POST /api/v1/cloud/workspaces/:id/archive`); `workspace-lifecycle.md` § States.

**Size: M.**

### Task 6 — Pre-flight token-mint dispatch shell (Wave B)

**Files:** `src/lib/orchestra-cloud-client.ts` — `mintWorkspaceToken` discrimination on HTTP status. `src/screens/orchestra/orchestra-setup-screen.tsx` + `src/components/stream-strategy-web.tsx` (the reconnect/resume splash).

**Behavior:**

- `mintWorkspaceToken(workspaceId)` returns a discriminated union:
  - `{kind:"active", token, expiresAt}` (200)
  - `{kind:"resuming", retryAfterMs}` (202)
  - `{kind:"billing_locked", planManagementUrl}` (402)
  - `{kind:"archived"}` (409)
  - `{kind:"provisioning_failed"}` (503)
- The reconnect splash (`stream-strategy-web.tsx` or its equivalent) renders distinct UX per kind:
  - `resuming` → "Resuming workspace…" splash with a bounded retry loop honoring `retryAfterMs` (cap at ~30 s, then surface a "Still resuming — refresh to retry" affordance).
  - `billing_locked` → "Reactivate your plan to resume this workspace." + link.
  - `archived` → "This workspace is archived." + [Unarchive] (calls `unarchiveWorkspace`, then re-attempts the token mint).
  - `provisioning_failed` → Task 5's recovery affordance.

**Cross-stream pin:** PLAN-auth-and-shared Task 16 (pre-flight token-mint). The integration-note from 2026-05-22 (`D-2-plans/INTEGRATION-NOTE.md` Bug 3) flags this as the exact contract that the D-2 app stream silently mishandled by treating any 2xx as `{token, expiresAt}`. D-3 lands the discrimination.

**Acceptance criteria:**

- Each status code renders the right UX (unit test per branch with a mocked fetch).
- The 202 retry loop terminates (does not spin forever).
- The 409 archived branch routes through the unarchive flow cleanly.

**Wire shapes pinned:** PLAN-auth-and-shared Task 16; `D-2-plans/INTEGRATION-NOTE.md` Bug 3.

**Size: M.**

### Task 7 — `agent_stream` epoch-aware catchup (Wave B)

**Files:** `src/components/stream-strategy-web.tsx` (reconnect glue), `src/timeline/session-stream-reducers.ts` (catchup-window classification), `src/hooks/use-agent-timeline-catchup.ts` (NEW). Tests extend `session-stream-reducers.test.ts`.

**Behavior:**

- On WS reconnect, for every subscribed agent: send `fetch_agent_timeline_request{agentId, direction:"after", cursor:{epoch, seq}, subscribe:{subscriptionId}}` using the last-known cursor (already stored in the session-stream reducer's `cursor` field).
- While the catchup is in flight, render a small banner above the agent timeline: "Resuming from <timestamp>" using the last-known event's `timestamp`. Banner clears when `agent_stream` resumes pushing live events.
- The reducer classifies items as `kind:"catch_up"` (already present at line 25 of `session-stream-reducers.ts`) versus live `kind:"realtime"`. UI side-effects bound to the reducer state — toast, sound, badge bump, push-notification — read this kind and suppress for catchup.
- On epoch mismatch (the agent was reset / forked in the gap), the daemon's response semantics are still UNVERIFIED per `agent-stream.md` § Resumption. Defensive behavior: if `response.events[0].epoch !== cursor.epoch`, surface a soft "Timeline restarted" notice (not an error) and rewind the reducer to a fresh epoch starting from `response.events[0]`.

**Acceptance criteria:**

- Unit test: catch_up items do NOT trigger the side-effect hooks; realtime items do.
- Unit test: epoch mismatch surfaces the soft notice and rewinds cleanly.
- Manual gate: disconnect mid-turn for 30 s, reconnect; observe the indicator + the missed events appearing without notification noise.

**Wire shapes pinned:** `10-interfaces/websocket/catalog/agent-stream.md` § Resumption.

**Size: L.** (Most complex single task in this stream — touches reducer + reconnect + new hook.)

### Task 8 — Quota error envelope renderer (Wave B)

**Files:** `src/components/quota-error-banner.tsx` (NEW), wired into the screens that surface quota failures (project picker for workspace-count, setup-screen for the same, agent screen for agent-count, settings for API spend / EFS / push-token). Tests: `quota-error-banner.test.tsx`.

**Behavior:**

- Reads the structured quota error envelope exported from `@orchestra/cloud-shared`. **Synthesis amendment (2026-05-26, ref CROSS-STREAM-SYNTHESIS § 2 A8):** operator-locked shape — `rpc_error{code:"quota_exceeded", quotaClass, current, cap}` (discriminator values `"workspace_count" | "agent_count" | "api_spend" | "efs_storage" | "push_token"`). PLAN-daemon emits this envelope on WS quota failures; PLAN-auth-and-shared's REST `quota/check` returns the same payload on `429` along with `X-RateLimit-*` headers. **Task 8 imports the type from `@orchestra/cloud-shared`** instead of redeclaring an inline shape — single source of truth across all three streams.
- Renders a banner / toast / inline error appropriate to each class:
  - `workspace_count` → "You've reached your workspace cap (`current`/`cap`). Archive a workspace or upgrade your plan." with [Archive] (opens project-picker Archived tab) + [Upgrade plan] (placeholder href).
  - `agent_count` → "You've reached the per-workspace agent cap (`current`/`cap`). Close an agent or upgrade your plan." with [Close agent] (focuses the agent list) + [Upgrade plan].
  - `api_spend` → "Anthropic spend cap reached for this workspace. Reset on <next billing cycle>." + [Upgrade plan].
  - `push_token` → silent for the user; logged for the operator (push-token cap is a quiet limit, not a user-facing failure).
  - `efs_storage` → "Workspace storage limit reached. Archive old workspaces or upgrade your plan." with both affordances.
- The "Upgrade plan" link Day-1 is a placeholder (`href="/upgrade-coming-soon"` or similar). D-4 billing wires the real destination.

**Cross-stream pin:** the cloud-shared envelope type (`rpc_error{code:"quota_exceeded", quotaClass, current, cap}`) is the binding contract; PLAN-daemon emits it on WS responses, PLAN-auth-and-shared returns it on REST 429 responses with parallel `X-RateLimit-*` headers. PLAN-auth-and-shared owns the cloud-shared TS type definition.

**Acceptance criteria:**

- Each of the 5 classes (+ per-account workspace cap) has a unit-tested rendering.
- The "Upgrade plan" link is a placeholder gated on a feature flag so D-4 can flip it without re-shipping the app.
- The "Archive workspaces" affordance routes to the project picker's Archived tab consistently.
- The envelope type is imported from `@orchestra/cloud-shared`, not redeclared locally.
- HTTP `429` responses with the same envelope shape (auth side) are parsed via the same helper as WS `rpc_error` events (daemon side).

**Wire shapes pinned:** `@orchestra/cloud-shared` exports `rpc_error{code:"quota_exceeded", quotaClass, current, cap}` (operator-locked 2026-05-26 per CROSS-STREAM-SYNTHESIS § 2 A8); `statefulness-and-multitenancy.md` § "Per-workspace rate limits and quotas" enumerates the 5 quota classes.

**Size: M.**

### Task 9 — `markStateActive` health-poll tolerance + setup-screen hardening (Wave B)

**Files:** `src/screens/orchestra/orchestra-setup-screen.tsx` — wrap the `connectAndProbe(...)` step (around the `"connecting"` step transition) in a bounded retry. `src/utils/test-daemon-connection.ts` — extend the probe to return a structured outcome (`{kind:"ok"} | {kind:"still_booting", attempt:N} | {kind:"failed", reason}`). Tests: `orchestra-setup-screen.test.tsx`.

**Behavior:**

- After `createWorkspace()` returns `state:"active"`, the client polls `connectAndProbe` up to N=15 times with ~2 s spacing (~30 s total budget) before declaring the workspace unhealthy.
- The setup splash reads "Starting workspace…" during this window; if the budget exhausts, the splash flips to "Workspace is still starting — try refreshing in a minute" with a [Retry] affordance.
- Health-poll integrates with the pre-flight token-mint (Task 6): if `mintWorkspaceToken` returns `kind:"resuming"`, use the response's `retryAfterMs` as the loop spacing instead of the default 2 s.

**Cross-stream pin:** PLAN-auth-and-shared owns the `markStateActive` shape. If auth lands a daemon-`/api/health`-gated state transition (the proper fix per `LEARNINGS.md` 2026-05-25 "Note for D-3+"), this task's bounded retry shrinks proportionally. If auth defers that fix to D-4, the bounded retry is the load-bearing recovery on the client side.

**Acceptance criteria:**

- Unit test: 15 503/502 responses then a 200 → setup completes successfully.
- Unit test: 15 consecutive failures → setup surfaces the still-booting copy + [Retry] action.
- Hands-on: create a workspace and observe no transient "Workspace failed to provision" error during the ~5-10 s ECS RUNNING-to-daemon-ready window.

**Wire shapes pinned:** `LEARNINGS.md` 2026-05-25 D-2 ship gate § "Note for D-3+" (the auth-side `markStateActive` semantics).

**Size: M.**

### Task 10 — MCP per-tenant URL grep + cleanup (Wave A)

**Files:** entire `paseo-fork/packages/app/src/`. Tests: anti-drift grep run as part of CI.

**Behavior:**

- Grep `src/` for any hard-coded MCP base URL (`http://localhost:6767/mcp`, etc.) outside test fixtures and on-host fallback. Replace with reads from the daemon's `welcome.mcp` / `agent.config.mcp` payload (whichever the daemon emits per D-1.5's MCP HTTP transport auth fix).
- Add a one-line CI lint to `paseo-fork`'s eslint config (or a tiny grep step in the existing `npm run check`) that fails if a literal `/mcp/agents/` URL appears in `src/` outside an allow-list.

**Cross-stream pin:** PLAN-daemon already owns the MCP-URL-emitted-by-daemon side (D-1.5 row 1 fix). This task is the client-side enforcement that no path bypasses it.

**Acceptance criteria:**

- Grep returns no matches outside the allow-list after the cleanup.
- CI fails if a new hard-coded MCP URL lands in `src/`.

**Size: S.**

### Task 11 — File-download cross-instance verification (Wave A)

**Files:** none in source (the `stores/download-store.ts` path is already cross-instance-safe by construction — the token lives in DDB-with-TTL per `day-1-scope-recommendations.md` § HTTP routes). The work is a hands-on probe + test fixture.

**Behavior:**

- Hands-on probe (operator-driven): force a workspace's daemon container to roll between mint and redeem (e.g., trigger an idle-suspend cycle via the lifecycle worker, then mint→suspend→resume→redeem). Confirm the file downloads through the new daemon container.
- Unit-test fixture: a new `download-store.test.ts` case that asserts `buildDownloadUrl` does not embed the issuer's instance identity — the URL is purely `<base>/api/files/download?token=<...>` with no host-affinity hint.

**Cross-stream pin:** **Synthesis amendment (2026-05-26, ref CROSS-STREAM-SYNTHESIS § 1 C3):** resolved direction — PLAN-auth-and-shared owns mint + redeem (`POST /api/auth-internal/files/mint-download-token` HMAC, `GET /api/files/download/:tokenId` 302 redirect); PLAN-daemon adds the `/api/files/download/internal/:tokenId` byte-streaming route the 302 lands on (synthesis A4). The app's existing `stores/download-store.ts` URL builder is cross-instance-correct by construction — no client behavior change. The hands-on probe is the verification gate that the auth→daemon redirect chain works across a daemon container roll (D-2's suspend/resume cycle is the canonical test case, not ALB target replacement).

**Acceptance criteria:**

- Hands-on probe passes end-to-end.
- Unit-test fixture protects against future host-affinity regressions.

**Size: S.**

### Task 12 — `OrchestraSessionExpiredError` centralized handler (D-2 carryover; Wave B)

**Files:** `src/runtime/host-runtime.ts` (or wherever the global session-error trap lives), `src/lib/orchestra-cloud-client.ts`, all sites that catch this error today.

**Behavior:**

- Per `LEARNINGS.md` 2026-05-22 D-1.5 closeout § Deferred: "Centralized `OrchestraSessionExpiredError` handler that bounces to `/welcome` instead of swallowing to `data: []` in 1 place and propagating to inline error in another."
- Single owner: a top-level error boundary or React-Query global error handler that catches `OrchestraSessionExpiredError` and `router.replace("/welcome")` after clearing the local session.
- Remove the per-call swallowing in `use-cloud-workspaces.ts` and the per-call inline-error treatment in setup-screen — both flow through the central handler.

**Acceptance criteria:**

- Force a 401 from auth mid-session (via dev-stack token revocation); observe a single, clean redirect to `/welcome` regardless of which call triggered the 401.
- No data-`[]` swallowing remains anywhere outside the central handler.

**Size: S.**

## Cross-stream pins consumed

| This stream consumes                                                                                                                      | Produced by                                                                                                                           | Wire/REST shape cited                                                                                                                                                                   | Must land before |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `POST /api/v1/cloud/workspaces/:id/archive` (session-authed)                                                                              | PLAN-auth-and-shared Task 13                                                                                                          | `paseo-cloud-daemon/90-cloud-considerations/workspace-lifecycle.md:18`                                                                                                                  | Task 5           |
| `POST /api/v1/cloud/workspaces/:id/unarchive` (session-authed)                                                                            | PLAN-auth-and-shared                                                                                                                  | `workspace-lifecycle.md:18` (the "Unarchive" UX promise)                                                                                                                                | Task 5           |
| `POST /api/v1/cloud/workspaces/:id/token` discriminated status codes (200/202/402/409/503)                                                | PLAN-auth-and-shared Task 16                                                                                                          | `D-2-plans/INTEGRATION-NOTE.md` Bug 3; `D-2-plans/PLAN-auth-and-shared.md` Task 16                                                                                                      | Tasks 6, 9       |
| `GET /api/v1/cloud/providers/snapshot` (out-of-band provider catalog)                                                                     | PLAN-auth-and-shared (new D-3 task)                                                                                                   | `IMPLEMENTATION-ROADMAP.md` § "Architectural design-outs" F1; `90-cloud-considerations/subprocess-isolation.md` § "Provider auth side-channels"                                         | Task 4           |
| `provisioning_failed → archived` transition legality OR alternate recovery                                                                | PLAN-auth-and-shared (decision per § Open Questions)                                                                                  | `LEARNINGS.md` 2026-05-25 UAT § "`provisioning_failed` cap-trap"                                                                                                                        | Task 5           |
| Schedule `runs[N].status:"failed"` wire shape                                                                                             | PLAN-daemon (already shipped; round 19 binding)                                                                                       | `examples/schedule-record/round-19-fired-failed-bad-cwd.json`; `10-interfaces/websocket/catalog/schedule.md` § `ScheduleRun`                                                            | Task 1           |
| Loop cap-failure `logs[].text` wire shape                                                                                                 | PLAN-daemon (already shipped; round 19 binding)                                                                                       | `examples/loop-record/round-19-loop-maxTimeMs-cap.json`; `10-interfaces/websocket/catalog/loop.md`                                                                                      | Task 2           |
| Permission `deny.interrupt:true` vs omitted bifurcation                                                                                   | PLAN-daemon (round 19 binding)                                                                                                        | `examples/websocket/round-19-permission-deny-interrupt-{true,omitted}.jsonl`; `10-interfaces/websocket/catalog/permission.md` § "`deny` side-effects"                                   | Task 3           |
| `agent_stream` epoch + seq cursor; `fetch_agent_timeline_request{direction:"after"}`                                                      | PLAN-daemon                                                                                                                           | `10-interfaces/websocket/catalog/agent-stream.md` § Resumption                                                                                                                          | Task 7           |
| File-download token store is cross-instance                                                                                               | PLAN-daemon (DDB-with-TTL or ElastiCache)                                                                                             | `paseo-cloud-daemon/90-cloud-considerations/day-1-scope-recommendations.md` § HTTP routes                                                                                               | Task 11          |
| Quota error envelope shape `rpc_error{code:"quota_exceeded", quotaClass, current, cap}` (operator-locked 2026-05-26 per synthesis § 2 A8) | PLAN-auth-and-shared owns the cloud-shared TS type; PLAN-daemon emits on WS; PLAN-auth-and-shared emits on REST 429 + `X-RateLimit-*` | `90-cloud-considerations/statefulness-and-multitenancy.md` § "Per-workspace rate limits and quotas"; `d-3-plan-synthesis/D-3-plans/CROSS-STREAM-SYNTHESIS.md` § 2 A8 (commit `9dc8972`) | Task 8           |
| MCP URL emitted by daemon (per-workspace-bound)                                                                                           | PLAN-daemon (D-1.5 row 1)                                                                                                             | `paseo-cloud-daemon/LEARNINGS.md` 2026-05-22 § "Row 1 (MCP HTTP cloud-mode auth)"                                                                                                       | Task 10          |
| `markStateActive` health-gating (or absence of)                                                                                           | PLAN-auth-and-shared (or D-4 deferral)                                                                                                | `LEARNINGS.md` 2026-05-25 § "Note for D-3+"                                                                                                                                             | Task 9           |

## CDK / IAM impact (mandatory)

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
>
> If **yes** to any item: file a one-line entry in `D-2-plans/PLAN-cdk-infra.md` § "Cross-stream dependencies" describing the contract, and confirm the CDK PR lands **BEFORE** the consuming-service PR (or — if a shim is feasible — confirm a backward-compat shim is in place so either order works). If **no**, write "No CDK impact." inline so reviewers can see the question was considered.

**Answer for this PLAN-app scope: No CDK impact.**

The app is a browser/desktop client; it has no AWS-side identity, no IAM role, no Secrets Manager footprint, no ALB ingress (it is _served_ from the ALB origin or a static-hosting CDN out of scope here). Every cross-stream pin this plan consumes is owned by another stream — `paseo-fork` server (daemon), auth-and-shared, lifecycle-worker, or PLAN-cdk-infra itself — and any CDK / IAM delta required to make those consumers work lands in those streams' PR sets, not here.

Two adjacent concerns worth flagging so the reviewer doesn't have to chase them:

- The new `GET /api/v1/cloud/providers/snapshot` REST endpoint (Task 4) needs an ALB rule entry under `/api/v1/cloud/*` which already routes to the auth target group — no new rule, no new env var, no new IAM. PLAN-auth-and-shared owns the route registration; nothing on the CDK side moves.
- The `/upgrade-coming-soon` placeholder URL (Task 8) is a static path served by the app itself; no Route 53 / ACM impact.

If a later D-3 implementation PR uncovers a hidden CDK delta (e.g., the providers-snapshot endpoint needs a new IAM grant on the auth task role for an out-of-band data source), this row gets re-answered "yes" in that PR's description and PLAN-cdk-infra picks up the cross-stream entry.

## Verification

How the operator confirms each task end-to-end.

1. **Schedule failure UI (Task 1)** — dev-stack: create a schedule with `target.config.cwd = "/tmp/does-not-exist"`, `cadence:{type:"every", everyMs:5000}`, `maxRuns:1`. Wait ~6 s. Open the schedule detail view; observe the run row showing red icon + the daemon's error string verbatim.
2. **Loop cap-failure UI (Task 2)** — dev-stack: create a loop with `maxTimeMs:1000` and a worker prompt that runs for ~2 s. Wait for completion. Loop detail surfaces "Reached max time (1000ms)." prominently.
3. **Permission deny bifurcation (Task 3)** — dev-stack: agent in `modeId:"default"`; send a `curl` Bash prompt; when the permission prompt appears, click "Stop the agent". Observe abort banner + agent in error state. Repeat with "Block this call"; observe the agent's clean turn-completion assistant message.
4. **Provider snapshot out-of-band (Task 4)** — dev-stack: clear localStorage, log in via OAuth, observe the provider picker is populated _before_ opening any workspace. Network tab shows a `/api/v1/cloud/providers/snapshot` call, not a daemon RPC.
5. **Archive flow (Task 5)** — dev-stack: create a workspace; archive it; verify it disappears from the active picker and appears in the Archived tab; unarchive it; verify it returns to the active picker.
6. **Pre-flight token-mint discrimination (Task 6)** — dev-stack: force a suspended workspace (wait ~17 min idle); reload the client; observe the "Resuming workspace…" splash with a bounded retry honoring `retryAfterMs`. Force an archived workspace; observe the [Unarchive] affordance.
7. **agent_stream catchup (Task 7)** — dev-stack: send an agent a long prompt; mid-turn, kill the WS (close tab or disable network); wait ≥30 s; reopen. Observe "Resuming from <timestamp>" briefly, then the missed events appear without notification noise.
8. **Quota error rendering (Task 8)** — dev-stack: create workspaces until the per-account cap fires (currently 3 — `LEARNINGS.md` 2026-05-25); observe the workspace-count cap banner with Archive + Upgrade affordances. Trigger an agent-count cap (10 agents in one workspace); observe the per-class message.
9. **`markStateActive` tolerance (Task 9)** — dev-stack: create a workspace; observe the setup splash holds for ~5-10 s without a transient "failed to provision" error. Repeat with a deliberately-broken repo URL; observe the rollback path lands on the `provisioning_failed` affordance, not the bare error.
10. **MCP cleanup (Task 10)** — `npm run lint` (or the project's grep gate) returns clean on a worktree-with-hard-coded-URL fixture.
11. **File-download cross-instance (Task 11)** — dev-stack: scale to 2 task replicas; mint a token on instance A; redeem via curl pinned to instance B; observe the file downloads.
12. **Session-expired handler (Task 12)** — dev-stack: revoke the session token mid-use; observe a single redirect to `/welcome` regardless of which UI surface was active.

The D-3 hands-on gate sequences these into one operator-driven session per `IMPLEMENTATION-ROADMAP.md:200-211`.

## Open questions / assumptions

### Surfaced for operator decision

1. **Quota error envelope discriminator.** **RESOLVED 2026-05-26** (operator decision, synthesis § 2 A8 / commit `9dc8972`). Cloud-shared exports `rpc_error{code:"quota_exceeded", quotaClass, current, cap}`; discriminator values `workspace_count | agent_count | api_spend | efs_storage | push_token`. PLAN-daemon emits on WS; PLAN-auth-and-shared's REST `quota/check` returns the same payload on `429` with parallel `X-RateLimit-*` headers. Task 8 imports the type from `@orchestra/cloud-shared`; the provisional inline shape is removed.

2. **`provisioning_failed` recovery fix.** **RESOLVED 2026-05-26** (operator decision, synthesis § 1 C5 / commit `9dc8972`). Picked **(a)** — make `provisioning_failed → archived` a legal transition + cap exclusion. PLAN-auth-and-shared implements the transition table change + cap exclusion; PLAN-lifecycle-worker adds an orphan-detect signal (D-3-5) for stale rows. Task 5's affordance is the load-bearing recovery path under normal operation; the contact-support fallback narrows to "auth's archive route returned a 5xx network error."

3. **"Upgrade plan" link destination Day-1.** Day-1 is "free during beta" per `day-1-scope-recommendations.md` § OAuth scopes / What this flow does NOT do — so the Upgrade button is a placeholder. Options: hide it entirely Day-1 (cleanest), or render with a "Coming soon" copy and a click-to-feedback form. This plan recommends the second (preserves the cap message's call-to-action shape) and gates the destination behind a feature flag for D-4 billing to flip.

4. **"Resuming from <timestamp>" indicator visibility duration.** Should the indicator stay up for a minimum N seconds even if catchup completes instantly (so the user reads the "we caught you up" affirmation)? This plan recommends a 1-second minimum visibility to avoid flicker; revisit if user feedback indicates otherwise.

### Carried-forward assumptions

5. **The Setup-wizard `existing[0]` shortcut is still in place** (`LEARNINGS.md` 2026-05-22 D-1.5 § "Setup-wizard `existing[0]` shortcut"). D-3 does NOT lift this — the "create a _new_ workspace" affordance is a separate D-3 task tracked in `paseo-fork`'s followups, not in this PLAN. Task 5's `provisioning_failed` recovery does not require multi-workspace UI.

6. **Two-worktree drift in local session store after archive** (`LEARNINGS.md` 2026-05-22 D-1.5 § Surprising). Once archive is the only destructive verb (no more DELETE from the user), and archived workspaces appear in the Archived tab rather than vanishing, the drift surfaces less acutely. This plan does NOT add a separate "purge local session store" task — observe in the D-3 hands-on gate whether it still bites and file as a D-4 followup if so.

7. **The daemon's `provider.snapshot` RPC is unchanged on the on-host path.** Task 4 only swaps the cloud-mode behavior; self-host operators still get the existing per-session RPC.

8. **No HTTPS / custom domain in D-3.** Inherited from D-2; not in scope for this plan.

9. **`/api/files/download` token TTL** is set on the producer side; the client does not need to know the TTL beyond rendering a "download expired" message when the redemption returns a 4xx.

10. **Anti-drift CI** (PLAN-auth-and-shared Task 17) is assumed to be in place. Task 10's grep gate is independent (it's an app-side `paseo-fork` lint, not the cross-repo Zod-schema anti-drift).

## Risks / hard parts

### 1. `agent_stream` catchup epoch-mismatch behavior is UNVERIFIED

`agent-stream.md` § Resumption explicitly flags this: "If the agent's `epoch` changed in the gap … the daemon's response handling is **UNVERIFIED**." Task 7's "rewind on epoch mismatch" recommendation is defensive; if the daemon's actual response is, e.g., a hard `rpc_error code:"epoch_mismatch"`, the UI surface changes. Resolve by capturing the actual response shape during D-3 implementation — a 30-line scratch script that resets an agent during a gap is enough.

### 2. Quota error envelope shape — RESOLVED 2026-05-26

Originally flagged: Task 8 ships against a provisional envelope; if PLAN-daemon and PLAN-auth-and-shared diverge, the app stream becomes the integration-audit site. **Resolved** by operator decision (synthesis § 2 A8 / commit `9dc8972`): cloud-shared exports `rpc_error{code:"quota_exceeded", quotaClass, current, cap}` with the 5-class discriminator; Task 8 imports the type directly. Residual risk: anti-drift CI (PLAN-auth-and-shared Task 17 from D-2) must cover the new type so a one-sided edit cannot silently break parsing on the app side.

### 3. `markStateActive` tolerance is a load-bearing client workaround

Per `LEARNINGS.md` 2026-05-25 D-2 ship gate § "Auth's `markStateActive` reframes 'active' semantics", the auth service flips `state="active"` the instant ECS `RUNNING` lands — not when the daemon is healthy. Task 9's bounded retry is the client-side mitigation. If auth lands a proper `/api/health`-gated transition in D-3 or D-4, Task 9's budget shrinks. The risk is forgetting Task 9 was a workaround and leaving the 30-second retry in place forever — file as a D-4 followup at minimum.

### 4. Pre-flight token-mint dispatch dependent on auth-and-shared landing first

Task 6 assumes the 200/202/402/409/503 contract from PLAN-auth-and-shared Task 16. The D-2 INTEGRATION-NOTE.md bug 3 shows this exact contract was silently mishandled the _first_ time. Mitigation: paired implementation (cross-stream pair-review on the dispatch shell + the producer route, simultaneously) before the merge ordering allows either side to land in isolation.

### 5. Provider-snapshot out-of-band endpoint owner

PLAN-auth-and-shared has not (as of this PLAN's writing) explicitly scoped the out-of-band provider catalog endpoint. The recommendation here is that it lands under `/api/v1/cloud/providers/snapshot` (session-authed, cached statically with a generated-at timestamp), but the producer-side decision is auth-and-shared's. If the answer is "static JSON manifest on the CDN," Task 4 swaps the fetch source accordingly. The contract (entries shape + generatedAt) stays the same.

### 6. Cross-tenant token-cache pollution risk

If the app caches the provider snapshot keyed by serverId, a switch-account flow could surface tenant-A's catalog to tenant-B for a tick. Today's `providersSnapshotQueryKey(serverId)` already provides the tenant boundary; the out-of-band fetch in Task 4 keys on `null` (no session) and re-keys when a session is established. Document this in the implementation PR description so a future refactor doesn't collapse the keys.

## References

- `paseo-cloud-daemon/IMPLEMENTATION-ROADMAP.md` § Phase D-3 + § "Architectural design-outs"
- `paseo-cloud-daemon/LEARNINGS.md` § 2026-05-22 D-1.5 closeout, § 2026-05-22 D-2 kickoff, § 2026-05-22 D-2 cross-stream synthesis, § 2026-05-22 D-2 parallel implementation closeout, § 2026-05-24 deploy recovery, § 2026-05-24 preflight, § 2026-05-25 6/6 probes pass, § 2026-05-25 ACCEPTANCE complete, § 2026-05-25 UAT
- `paseo-cloud-daemon/90-cloud-considerations/day-1-scope-recommendations.md`
- `paseo-cloud-daemon/90-cloud-considerations/saas-signup-flow.md`
- `paseo-cloud-daemon/90-cloud-considerations/statefulness-and-multitenancy.md`
- `paseo-cloud-daemon/90-cloud-considerations/subprocess-isolation.md`
- `paseo-cloud-daemon/90-cloud-considerations/workspace-lifecycle.md`
- `paseo-cloud-daemon/90-cloud-considerations/open-core-architecture.md`
- `paseo-cloud-daemon/10-interfaces/websocket/catalog/{chat,schedule,loop,permission,agent-stream}.md`
- `paseo-cloud-daemon/examples/schedule-record/round-19-fired-failed-bad-cwd.json`
- `paseo-cloud-daemon/examples/loop-record/round-19-loop-maxTimeMs-cap.json`
- `paseo-cloud-daemon/examples/websocket/round-19-permission-deny-interrupt-true.jsonl`
- `paseo-cloud-daemon/examples/websocket/round-19-permission-deny-interrupt-omitted.jsonl`
- `D-2-plans/PLAN-auth-and-shared.md` (especially § "Cross-stream dependencies" + Task 16)
- `D-2-plans/PLAN-lifecycle-worker.md` § 2 (heartbeat + suspend detection)
- `D-2-plans/PLAN-cdk-infra.md` (CDK / IAM cross-stream pins)
- `D-2-plans/PLAN-template-snippet.md` (mandatory CDK/IAM impact row)
- `D-2-plans/INTEGRATION-NOTE.md` (Bug 3 — pre-flight token-mint discrimination)
- `paseo-fork/packages/app/src/components/agent-stream-view.tsx:990-1095` (existing permission card)
- `paseo-fork/packages/app/src/contexts/session-context.tsx:1291-1310` (permission subscriptions)
- `paseo-fork/packages/app/src/timeline/session-stream-reducers.ts:107-132` (epoch/seq cursor logic)
- `paseo-fork/packages/app/src/hooks/use-providers-snapshot.ts` (F1 fix site)
- `paseo-fork/packages/app/src/screens/orchestra/orchestra-setup-screen.tsx` (D-2 carryover sites)
- `paseo-fork/packages/app/src/stores/download-store.ts:240-296` (download flow)
- `paseo-fork/packages/app/src/lib/orchestra-cloud-client.ts` (REST adapter)
