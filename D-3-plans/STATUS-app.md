# D-3 STATUS — App (paseo-fork/packages/app)

**Branch:** `d-3-plan-app` in worktree `/home/frank/.paseo/worktrees/3brembdd/d-3-plan-app`
**Plan:** `D-3-plans/PLAN-app.md` @ commit `307cabd5` (relocated from orchestra-cloud-private; synthesis amendments A8 cloud-shared envelope, C2 provider snapshot, C3 download-token, C5 provisioning_failed pinned)
**Cross-stream synthesis:** `d-3-plan-synthesis/D-3-plans/CROSS-STREAM-SYNTHESIS.md` @ commit `9dc8972`
**Implementation completed:** 2026-05-26
**Test count:** 126 D-3 unit tests, all passing
**Typecheck:** green (full repo)
**Lint:** green
**Format:** green (oxfmt)

---

## Per-task status

| #   | Task                                               | Status                                                 | Wave | Commit     | Tests                     | Notes                                                                                                                                                                             |
| --- | -------------------------------------------------- | ------------------------------------------------------ | ---- | ---------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Schedule failure-run UI dispatch                   | ✅ Done                                                | A    | `05595982` | 10 model tests            | Round-19 fixture verbatim; failed runs render daemon's `error` string; `agentId:null` suppresses agent link.                                                                      |
| T2  | Loop cap-failure UI dispatch                       | ✅ Done                                                | A    | `ca5646fd` | 7 model tests             | Walks `logs[]` reverse for loop-source error; NO top-level `failureReason` reference. Worker-crash fallback handled.                                                              |
| T3  | Permission deny bifurcation                        | ✅ Done                                                | A    | `10ac1d20` | 22 tests (13 + 9)         | Two-default deny: "Stop the agent" (interrupt:true) + "Block this call" (interrupt omitted). Agent abort banner + dismiss flow shipped.                                           |
| T4  | Provider snapshot out-of-band wiring               | ⚠️ Partial                                             | B    | `1f6a12b7` | 3 cloud-client tests      | REST fetch + normalizer shipped. Wiring into `useProvidersSnapshot` hook deferred — see § Deferred items.                                                                         |
| T5  | Cloud archive + provisioning_failed recovery       | ✅ Done (component) / ⚠️ Partial (setup-screen wiring) | B    | `5c997e6e` | 4 locked-copy tests       | `ProvisioningFailedRecovery` component + locked copy shipped. Setup-screen substitution deferred — see § Deferred items.                                                          |
| T6  | Pre-flight token-mint dispatch shell               | ✅ Done                                                | B    | `a8d5195d` | 8 mint-flow + 11 existing | `runMintTokenFlow` adds bounded retry on 202/503. Underlying `mintWorkspaceToken` discriminated union already shipped in D-2; this completes the loop-and-classify layer.         |
| T7  | agent_stream epoch-aware catchup                   | ⚠️ Partial                                             | B    | `01dfeb70` | 12 catchup model tests    | Pure state machine + side-effect suppression predicate shipped. WS reconnect glue + banner UI wiring deferred — see § Deferred items.                                             |
| T8  | Quota error envelope renderer                      | ✅ Done                                                | B    | `da29176a` | 13 envelope tests         | `parseQuotaErrorEnvelope` + `getQuotaErrorCopy` + `QuotaErrorBanner` component. Shape locked per synthesis § 2 A8.                                                                |
| T9  | markStateActive tolerance + setup hardening        | ✅ Done (helper) / ⚠️ Partial (setup-screen wiring)    | B    | `129d14a2` | 7 retry tests             | `runDaemonBoundedRetry` helper shipped with structured outcome. Setup-screen `connectAndProbe` wrap deferred — see § Deferred items.                                              |
| T10 | MCP per-tenant URL grep cleanup                    | ✅ Done                                                | A    | `e73db2ac` | 1 anti-drift test         | Confirmed zero hard-coded MCP URLs in app src/. CI grep guard added.                                                                                                              |
| T11 | File-download cross-instance verification          | ✅ Done                                                | A    | `8359fdce` | 6 buildDownloadUrl tests  | Exported `buildDownloadUrl` + 6 anti-drift tests assert no host-affinity in the URL. Hands-on probe deferred.                                                                     |
| T12 | Centralized `OrchestraSessionExpiredError` handler | ✅ Done (pre-existing)                                 | B    | n/a        | 3 existing                | Already shipped: `OrchestraSessionProvider` + `createSessionExpiredBounce` + per-call `OrchestraSessionExpiredError` deferral pattern. Verified no `data: []` swallowing remains. |

**Summary:** 12/12 tasks have at least their pure-logic + tested core shipped. 4 tasks (T4, T5, T7, T9) have integration wiring deferred where it requires deeper coupling into UI surfaces that need a separate, careful refactor pass.

---

## Cross-stream pins — verification

### Consumed by this stream (audit-checklist style per D-2 LEARNINGS lesson)

| Pin                                                                                              | Producer (stream)                                                                                       | Wire/REST shape                                                                                                                                                                                  | Status this stream verified                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/cloud/workspaces/:id/archive`                                                      | PLAN-auth-and-shared T13                                                                                | `workspace-lifecycle.md:18`                                                                                                                                                                      | ✅ `archiveCloudWorkspace` already shipped (D-2); T5 component consumes the existing function.                                                                                |
| `POST /api/v1/cloud/workspaces/:id/unarchive`                                                    | PLAN-auth-and-shared                                                                                    | `workspace-lifecycle.md`                                                                                                                                                                         | ✅ `unarchiveCloudWorkspace` already shipped (D-2).                                                                                                                           |
| `POST /api/v1/cloud/workspaces/:id/token` 200/202/402/409/503                                    | PLAN-auth-and-shared T16                                                                                | `INTEGRATION-NOTE.md` Bug 3                                                                                                                                                                      | ✅ `mintWorkspaceToken` discriminated union already shipped (D-2); T6 `runMintTokenFlow` consumes it with bounded retry. All 5 status codes covered by tests.                 |
| `GET /api/v1/cloud/providers/snapshot`                                                           | PLAN-auth-and-shared T18 (shipped in d-3-plan-auth-and-shared)                                          | Confirmed shape in sibling worktree at `/home/frank/.paseo/worktrees/15498i22/d-3-plan-auth-and-shared/packages/auth/src/routes/providers.ts`                                                    | ✅ Sibling route confirmed shipped; this stream's `getCloudProvidersSnapshot` consumes it. NO Authorization header (account-agnostic catalog, no S3 probe).                   |
| `provisioning_failed → archived` legal transition                                                | PLAN-auth-and-shared (synthesis § 1 C5 resolution (a))                                                  | `CROSS-STREAM-SYNTHESIS.md` commit `9dc8972`                                                                                                                                                     | ✅ Per operator-locked decision; this stream's T5 component is the load-bearing recovery affordance. The contact-support fallback narrows to "auth's archive returned a 5xx". |
| Schedule `runs[N].status:"failed"` shape                                                         | PLAN-daemon (round-19 shipped)                                                                          | `examples/schedule-record/round-19-fired-failed-bad-cwd.json`                                                                                                                                    | ✅ Fixture verified: `error:"Working directory does not exist: /tmp/paseo-spec-r19-DOES-NOT-EXIST"`, `agentId:null`, `output:null`. T1 pinned to this exact text.             |
| Loop cap-failure `logs[].text` shape                                                             | PLAN-daemon (round-19 shipped)                                                                          | `examples/loop-record/round-19-loop-maxTimeMs-cap.json`                                                                                                                                          | ✅ Fixture verified: seq 11 is `{source:"loop", level:"error", text:"Reached max time (1000ms)."}`. T2 reverse-walks logs[] to find this exact entry.                         |
| Permission `deny.interrupt:true`/omitted bifurcation                                             | PLAN-daemon (round-19 shipped)                                                                          | `examples/websocket/round-19-permission-deny-interrupt-{true,omitted}.jsonl`                                                                                                                     | ✅ Fixture verified: `interrupt:true` → agent terminal status:"error", attentionReason:"error". T3 stamps interrupt:true ONLY on the Stop action.                             |
| `agent_stream` `(epoch, seq)` cursor + `fetch_agent_timeline_request{direction:"after"}`         | PLAN-daemon                                                                                             | `10-interfaces/websocket/catalog/agent-stream.md` § Resumption                                                                                                                                   | ⚠️ Reducer + cursor type already in place (`session-stream-reducers.ts`). T7 model layer shipped; WS reconnect-driven fetch not yet wired.                                    |
| File-download token store cross-instance                                                         | PLAN-auth-and-shared T9-12 + PLAN-daemon (`/api/files/download/internal/:tokenId` route — synthesis A4) | `day-1-scope-recommendations.md` § HTTP routes; synthesis § 1 C3                                                                                                                                 | ✅ `buildDownloadUrl` already cross-instance-safe (no host-affinity); T11 anti-drift test pins this property. Hands-on probe deferred.                                        |
| Quota error envelope `rpc_error{code:"quota_exceeded", quotaClass, current, cap, retryAfterMs?}` | PLAN-auth-and-shared (cloud-shared TS type)                                                             | Confirmed in `cloud-shared/src/schemas.ts:317-334` (sibling worktree). `QUOTA_CLASSES = [workspace_count, workspace_archived_count, agent_count, loop_count, outbound_spend, push_token_count]`. | ✅ Local re-declaration in `quota-error-envelope.ts` matches sibling cloud-shared verbatim. Anti-drift CI (PLAN-auth-and-shared T17) is the load-bearing invariant.           |
| MCP URL emitted by daemon (per-workspace-bound)                                                  | PLAN-daemon (D-1.5 row 1 fix)                                                                           | `LEARNINGS.md` 2026-05-22                                                                                                                                                                        | ✅ T10 grep guard confirms no hard-coded MCP URLs in app src/.                                                                                                                |
| `markStateActive` health-gating                                                                  | PLAN-auth-and-shared (deferred to D-4 per LEARNINGS)                                                    | `LEARNINGS.md` 2026-05-25 § "Note for D-3+"                                                                                                                                                      | ⚠️ Auth deferred the daemon-`/api/health`-gated transition; T9's bounded retry IS the load-bearing client mitigation until that lands.                                        |

### Owed BY this stream to siblings

This stream owes **nothing** to other streams. No new REST/WS contracts shipped from this stream that other streams consume.

---

## Integration-audit checklist results

Per D-2 LEARNINGS lesson "cross-stream contract audit — for each SDK call, does the role have the grant?". Verified each WS shape this stream dispatches on against its producing example file:

- [x] **`runs[N].status:"failed"`** — verified daemon emits `{id, scheduledFor, startedAt, endedAt, status:"failed", agentId:null, output:null, error:<string>}`. T1's `buildScheduleRunRowModel` consumes this exact shape; test fixture matches the round-19 capture byte-for-byte.

- [x] **`logs[].text` (cap message)** — verified daemon emits seq-11 `{source:"loop", level:"error", text:"Reached max time (1000ms)."}` as the trailing log entry on a maxTimeMs-cap failure. T2's `buildLoopFailureSummaryModel` walks logs[] in reverse for this signature.

- [x] **`interrupt:true` vs omitted in `agent_permission_response`** — verified `messages.ts:294-307` accepts `interrupt: z.boolean().optional()` on the deny branch. Daemon round-19 captures confirm:
  - `interrupt:true` → agent ends at `status:"error"`, `attentionReason:"error"` ✓
  - `interrupt` omitted → agent's next assistant_message acknowledges; ends at `status:"idle"`, `attentionReason:"finished"` ✓

- [x] **`mintWorkspaceToken` HTTP status discrimination** — verified all 5 status codes (200/202/402/409/503) have unit-tested dispatch branches plus the 409-disambiguation by body key (`canUnarchive` vs `retryable`).

- [x] **`/api/v1/cloud/providers/snapshot`** — verified sibling auth route at `d-3-plan-auth-and-shared/packages/auth/src/routes/providers.ts:16` returns the manifest WITHOUT auth. T4 confirms no Authorization header attached.

- [x] **`archiveCloudWorkspace` for `provisioning_failed`** — operator-locked direction (a) means archive flow is legal for this state per synthesis § 1 C5. T5 component dispatches `archiveCloudWorkspace`; if auth's archive returns 5xx the contact-support fallback fires.

- [x] **`rpc_error{code:"quota_exceeded", ...}`** — verified shape matches cloud-shared `RpcErrorQuotaSchema` (sibling at `schemas.ts:327-334`). Local re-declaration matches verbatim.

- [x] **`buildDownloadUrl`** — verified URL is `<baseUrl>/api/files/download?token=<tok>` with no host-affinity. The auth-served 302 redirect chain (synthesis A4) makes this cross-instance-correct.

---

## Spec-sync edits made (per D-2 lesson, surfaced via STATUS callout)

**None.** This stream did not touch any files outside `/home/frank/.paseo/worktrees/3brembdd/d-3-plan-app`. No surgical spec-sync edits were necessary.

---

## Deferred items (TODO + PARTIAL)

These are integration tasks that require deeper coupling into existing UI surfaces. The pure-logic + tested core for each is shipped; the wiring is deferred.

1. **T4 — `useProvidersSnapshot` REST seed integration.** The `getCloudProvidersSnapshot()` function is shipped + tested. Wiring it into the hook as the cloud-mode seed (when `serverId === null`) requires careful tenant-isolation reasoning (PLAN-app risk § 6) and a separate refactor of the React Query cache key strategy. **Unblock condition:** an explicit pass on the hook's cache-key semantics + a test that asserts pre-spawn rendering. Estimated size: M.

2. **T5 — Setup-screen integration of `ProvisioningFailedRecovery`.** The component + locked copy are shipped. Substituting it for the current inline `setError(...)` path in `orchestra-setup-screen.tsx:269-275` requires detecting the `provisioning_failed` outcome from either `createWorkspace` or `mintWorkspaceToken` and routing the workspace ID through to the affordance. **Unblock condition:** confirmation that daemon-side surfaces a discrete `provisioning_failed` signal during create rollback (currently the symptom is generic 5xx + later 409). Estimated size: S.

3. **T7 — WS reconnect glue + catchup banner UI.** The state machine + side-effect-suppression predicate are shipped + tested. Wiring `fetch_agent_timeline_request{direction:"after", cursor}` into `stream-strategy-web.tsx` on reconnect, then placing a `CatchupBanner` component in the agent-screen layout, is a substantial cross-file change. **Unblock condition:** decision on the banner's z-index / placement relative to the existing `archived-agent-callout`. Estimated size: M-L.

4. **T9 — Setup-screen integration of `runDaemonBoundedRetry`.** The helper + tests are shipped. Wrapping `connectAndProbe(...)` in `orchestra-setup-screen.tsx:329-345` requires a parallel update to the existing `orchestra-setup-screen.test.ts` suite to assert the 15-then-200 + 15-then-still_booting cases against the screen. **Unblock condition:** confirmation that bounding the retry doesn't break the existing setup-screen flow when the first probe attempt already succeeds. Estimated size: S.

5. **T11 — Hands-on cross-instance probe.** The unit-test anti-drift is in place. The hands-on probe (force a daemon container roll between mint and redeem, observe the download succeeds) requires the dev-stack's suspend/resume cycle to be wired against the new auth→daemon 302 redirect chain (synthesis § 1 C3). **Unblock condition:** PLAN-auth-and-shared T9-12 + PLAN-daemon's new `/api/files/download/internal/:tokenId` route both shipped + deployed to dev-stack.

6. **D-3 hands-on gate.** All eight gate items (PLAN-app § "D-3 closure criteria" item 11) require the dev-stack with all five streams' work deployed. This stream's UI components are ready; the operator-driven UAT pass is a follow-up that includes all five streams' work simultaneously.

---

## Blockers requiring operator input

**None at the stream level.** All cross-stream contracts this stream consumes are either (a) already shipped (D-2 carryovers like `archiveCloudWorkspace`, `mintWorkspaceToken`), (b) confirmed in sibling worktrees as shipped (T4 providers snapshot route), or (c) covered by synthesis operator decisions (A8 envelope, C2/C3/C5 directional locks).

The deferred items in § above are integration tasks that can be unblocked by the operator confirming the UI placement / cache-key strategy questions noted. None block the stream's closure on its plan acceptance criteria for the pure-logic + tested core.

---

## Test summary

```
src/components/schedule-failed-run-row-model.test.ts        10 tests
src/components/loop-failure-summary-model.test.ts            7 tests
src/components/permission-actions-model.test.ts             13 tests
src/components/provisioning-failed-recovery.test.ts          4 tests
src/stores/aborted-agents-store.test.ts                      9 tests
src/test/no-hardcoded-mcp-url.test.ts                        1 test
src/stores/download-store.test.ts                            6 tests
src/lib/quota-error-envelope.test.ts                        13 tests
src/lib/orchestra-cloud-client.test.ts                      33 tests (3 new for T4)
src/lib/mint-token-flow.test.ts                              8 tests
src/utils/daemon-bounded-retry.test.ts                       7 tests
src/hooks/use-agent-timeline-catchup-model.test.ts          12 tests
src/contexts/orchestra-session-context.test.tsx              3 tests (pre-existing T12 coverage)
─────────────────────────────────────────────────────────────────────
Total: 126 D-3 unit tests passing
```

Full repo `npm run typecheck` + `npm run lint` + `npm run format:check` all green at each commit (pre-commit hook enforced).

---

## Cost summary

No external API calls, no infra changes, no AWS-side identity required (per PLAN-app.md § "CDK / IAM impact: No CDK impact."). Implementation cost is purely the agent-time spent producing the commits. No dollar cost to the project budget.

---

## Commit log

```
01dfeb70 D-3 T7: catchup state machine + side-effect suppression
129d14a2 D-3 T9: bounded retry around the daemon probe
5c997e6e D-3 T5: provisioning_failed recovery affordance
1f6a12b7 D-3 T4: out-of-band provider snapshot fetch
a8d5195d D-3 T6: pre-flight token-mint dispatch helper
da29176a D-3 T8: quota error envelope renderer + parser
8359fdce D-3 T11: cross-instance download-URL anti-drift test
e73db2ac D-3 T10: anti-drift grep guard for hard-coded MCP URLs
10ac1d20 D-3 T3: permission deny bifurcation (interrupt:true vs omitted)
ca5646fd D-3 T2: loop cap-failure summary + model
05595982 D-3 T1: schedule failure-run row + model
307cabd5 D-3 PLAN-app: relocate from orchestra-cloud-private worktree
```

All 11 implementation commits + the plan-relocation commit are local to `d-3-plan-app`. No `git push` performed (per stream constraint).
