# Probe 7 — WebSocket variant — capture results

**Date:** 2026-05-26
**Phase:** D-3 (PLAN-daemon T-11)
**Branch:** `d-3-plan-daemon` (paseo-fork)
**Status:** captured at the unit/integration level via the daemon-side test suite. Operator-driven hands-on capture against the deployed dev stack is still pending (lifts the D-2 probe-7 HTTP capture pattern from `orchestra-cloud-private/D-2-plans/PROBE-RESULTS-2026-05-25.md`).

## Context

The D-2 ACCEPTANCE post-mortem (`LEARNINGS.md` 2026-05-25 (later)) caught a daemon-side cross-tenant bypass: `cloud-auth.ts:validateWorkspaceToken` validated the JWT signature but did not assert `claims.workspace_id === PASEO_WORKSPACE_ID` / `claims.account_id === PASEO_ACCOUNT_ID`. Paseo PR #5 added the binding for the HTTP `/api/status` path (probe 7a/7b → 401).

LEARNINGS.md 2026-05-25 "What's still uncertain / deferred for D-3+" flagged:

> Probe 7 WebSocket variant — today's probe 7 hit HTTP `/api/status`; the rubric also mentions a WS-upgrade variant. The daemon's WS handler likely shares the same auth middleware (HTTP Bearer required even for WS upgrade), so the fix should cover both, but not explicitly verified.

T-11 closes this gap.

## Verification

The daemon's WS-upgrade path at `websocket-server.ts:630-680` extracts the `paseo.workspace.<jwt>` subprotocol, passes the token through the same `validateWorkspaceToken` callback that `requireWorkspaceMiddleware` uses, and closes with `WS_CLOSE_DAEMON_AUTH_FAILED = 4401` (`websocket-server.ts:70`) when the callback returns `null`.

`cloud-auth.test.ts` already exercises the callback's cross-tenant rejection at the unit level (3 tests landed in paseo PR #5: workspace_id mismatch; account_id mismatch; both mismatch).

T-11 adds the WS-upgrade integration capture at `packages/server/src/server/cloud-auth.workspace-binding.test.ts` (5 tests):

| Scenario                    | Subprotocol                        | Expected                              | Result  |
| --------------------------- | ---------------------------------- | ------------------------------------- | ------- |
| Own-tenant token            | `paseo.workspace.<jwt-self>`       | open + welcome message                | ✅ pass |
| Cross-tenant `workspace_id` | `paseo.workspace.<jwt-other-ws>`   | close 4401 "Invalid workspace token"  | ✅ pass |
| Missing subprotocol         | (omitted)                          | close 4401 "Workspace token required" | ✅ pass |
| Malformed subprotocol       | `paseo.bearer.<…>`                 | close 4401 "Workspace token required" | ✅ pass |
| Wrong `account_id`          | `paseo.workspace.<jwt-wrong-acct>` | close 4401 "Invalid workspace token"  | ✅ pass |

```
$ npx vitest run packages/server/src/server/cloud-auth.workspace-binding.test.ts --bail=1
 ✓ packages/server/src/server/cloud-auth.workspace-binding.test.ts (5 tests) 500ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

The constant `WS_CLOSE_DAEMON_AUTH_FAILED = 4401` is mirrored verbatim in the test fixture so a future rename in `websocket-server.ts` would surface the binding mismatch loudly (the test would still pass against a renamed-but-same-value constant; the test asserts the literal value, which is the wire shape).

## Operator-driven dev-stack capture (deferred — operator action)

The unit/integration capture above proves the daemon-side semantics. The full hands-on capture per the D-2 probe-7 pattern requires the operator to run against the deployed dev stack:

```bash
# (Operator-side; runs against the deployed stack with two workspaces.)
WS_A_TOKEN="$(./scripts/mint-workspace-token.sh ws_workspace_A)"
WS_B_HOST="https://ws_workspace_B.dev.orchestra.nuvo.software"

# Probe 7c: WS upgrade with workspace-A token to workspace-B daemon URL.
# Expected: close code 4401, "Invalid workspace token".
node -e "
const { WebSocket } = require('ws');
const ws = new WebSocket('wss://${WS_B_HOST#https://}/ws', \`paseo.workspace.\${process.env.WS_A_TOKEN}\`);
ws.on('close', (code, reason) => {
  console.log('close', code, reason.toString());
  process.exit(0);
});
ws.on('open', () => {
  console.log('UNEXPECTED OPEN');
  process.exit(1);
});
setTimeout(() => { console.log('timeout'); process.exit(2); }, 5000);
" WS_A_TOKEN="$WS_A_TOKEN"
```

Expected output: `close 4401 Invalid workspace token` and exit 0.

Filed as a hands-on follow-up in `D-3-plans/STATUS-daemon.md` § Operator-driven items.

## References

- `packages/server/src/server/cloud-auth.workspace-binding.test.ts` — the regression suite.
- `packages/server/src/server/cloud-auth.test.ts` — JWT-callback unit tests (D-2 PR #5).
- `packages/server/src/server/websocket-server.ts:70, 630-680` — production WS-upgrade auth path.
- `paseo-cloud-daemon/LEARNINGS.md` 2026-05-25 (later) — D-2 ACCEPTANCE entry that surfaced the binding gap.
- `orchestra-cloud-private/D-2-plans/PROBE-RESULTS-2026-05-25.md` — the HTTP-side capture artifact this complements.
