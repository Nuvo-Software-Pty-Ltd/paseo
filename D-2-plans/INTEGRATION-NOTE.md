# D-2 PLAN-app — INTEGRATION-NOTE

Cross-stream fix logged 2026-05-22, post-integration with PLAN-auth-and-shared Task 16.

## Bug

`mintWorkspaceToken` in `packages/app/src/lib/orchestra-cloud-client.ts` treated every 2xx response from `POST /api/v1/cloud/workspaces/:id/token` as the active-shape `{ token, expiresAt }`. PLAN-auth-and-shared Task 16 shipped the endpoint with **six** status codes, four of them success-shaped (200/202) or recoverable (402/409/503) but none of them returning the original payload:

| Code | Variant               | Body                               |
| ---- | --------------------- | ---------------------------------- |
| 200  | `active`              | `{ token, expiresAt }`             |
| 202  | `resuming`            | `{ resuming: true, retryAfterMs }` |
| 402  | `billing_locked`      | `{ error, reactivateUrl }`         |
| 409  | `archived`            | `{ error, canUnarchive }`          |
| 409  | `provisioning_failed` | `{ error, retryable }`             |
| 503  | `provisioning`        | `{ error, retryAfterMs }`          |

The 202 case was the silent killer: pre-fix code took the `res.ok` path, parsed the body as `{ token, expiresAt }`, got `undefined.token`, and the WS transport closure handed `undefined` to the daemon. No throw, no observable error — the connect just failed cryptically.

## Fix shape

Single commit `D-2 PLAN-app (cross-stream fix): discriminate mintWorkspaceToken status codes per PLAN-auth-and-shared Task 16`.

- New `MintWorkspaceTokenResult` discriminated union exported from the client.
- `mintWorkspaceToken` dispatches on `res.status`. The two 409 shapes disambiguate by which field is present (`canUnarchive` → archived, `retryable` → provisioning_failed). Unknown 409 shape throws.
- 401 still routes through `authedFetch` → `OrchestraSessionExpiredError` (auth seam unchanged).
- All non-2xx / non-listed status codes throw with the status code in the message (preserves pre-D-2 throw shape).
- Four call sites updated:
  - `screens/orchestra/orchestra-setup-screen.tsx` — happy path requires `"active"`; any other variant maps through new `setupMintErrorMessage` helper to a sentence-length inline error and bounces back to the credential step. (Non-active here is genuinely unexpected — the workspace was created seconds ago.)
  - `runtime/host-runtime.ts` — `tokenProvider` throws `Workspace token unavailable: status=<x>` on any non-active variant. The existing reconnect cycle handles retry.
  - `utils/test-daemon-connection.ts` — same throw pattern for the probe path.
- Tests: `orchestra-cloud-client.test.ts` grows ten cases covering every status-code branch, the 409 disambiguation, the 200-missing-token defensive throw, the 401 auth seam, and a generic 500. `orchestra-setup-screen.test.ts` grows three cases on the new `setupMintErrorMessage` helper.

## Why Task 6's cold-resume splash didn't need to consume `status: "resuming"`

Task 6's gate (`workspace-route-state.ts`) is `cloudWorkspaceState === "suspended" && connectionStatus !== "online"`. The `cloudWorkspaceState` comes from `useCloudWorkspaces` polling `GET /api/v1/cloud/workspaces`, which is the workspace state machine's source of truth. The token mint is the auth-side view of "can I get a token right now"; it tracks the same lifecycle but on the auth-internal cadence.

The two views can race (mint sees `resuming` for a few seconds; the workspaces list refresh hasn't picked up the suspend → active flip yet, or vice versa), but the splash exit-condition OR (`state !== "suspended" OR connectionStatus === "online"`) handles that — whichever side flips first dismisses the splash.

So this fix does NOT plumb `status: "resuming"` into the splash directly. The two paths stay independent, and the WS reconnect cycle takes care of the next mint attempt. **The splash UX still works end-to-end** because the workspaces-list-polling path drives it.

## Operator follow-up

PLAN-app.md § Task 6 acceptance criteria should be amended to include the discriminated `mintWorkspaceToken` return type contract — the original Task 6 documented the splash UX but didn't list the HTTP-client dispatch shell as a sub-task. Concretely, add to Task 6's acceptance:

> The client's `mintWorkspaceToken` returns a discriminated union (`MintWorkspaceTokenResult`) covering all six PLAN-auth-and-shared status-code variants; the `tokenProvider` closures in `host-runtime.ts` and `test-daemon-connection.ts` throw on any non-active variant; the cold-resume splash continues to read `state` from `useCloudWorkspaces` independently of the mint dispatch.

(Alternatively, file this as a new Task 6.1 sibling and link from Task 6.)

## Verification

```
npm test --workspace=@getpaseo/app -- orchestra-cloud-client  → 28 tests pass
npm test --workspace=@getpaseo/app -- orchestra-setup-screen  → 10 tests pass
npm run typecheck --workspace=@getpaseo/app                   → clean
npm run lint  (on 7 touched files)                            → 0 warnings, 0 errors
```

Live walkthrough against `orchestra-dev` still operator-owned; cannot run from the sandbox.
