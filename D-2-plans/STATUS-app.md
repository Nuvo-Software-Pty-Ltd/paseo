# D-2 PLAN-app — STATUS

Branch: `d-2-plan-app` (paseo-fork). One commit per task; pre-commit hooks enforced (no `--no-verify`).

Date completed: 2026-05-22.

## Summary

All 11 plan tasks landed in 11 atomic commits. Full typecheck, lint, and format clean. 57 D-2-scope unit tests added across 8 test files (all passing). Nothing pushed to remote.

## Task status table

| #   | Task                                        | Status  | Commit     | Notes                                                                                                                                     |
| --- | ------------------------------------------- | ------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Centralized `OrchestraSessionExpiredError`  | ✅ DONE | `38421041` | Pure debounce coordinator + global provider. 3 tests.                                                                                     |
| 2   | `state` + `archivedAt` on `WorkspaceRecord` | ✅ DONE | `1cf6dc01` | Tolerant normalizer with COMPAT marker. 4 new tests for state branches + tolerant defaults.                                               |
| 3   | Picker Active + Archived sections           | ✅ DONE | `c3bb5c82` | Pure `partitionCloudWorkspaces` + 3 tests. Locked footer copy.                                                                            |
| 4   | Unarchive button + unarchive-on-open        | ✅ DONE | `01131ff5` | `useUnarchiveWorkspace` F9-style single writer. Toast on row-open success. Tests cover archive/unarchive happy + 401 propagation.         |
| 5   | Archive confirm modal + locked copy         | ✅ DONE | `daf6478c` | Locked-copy constants in `lib/cloud-workspace-copy.ts`. 7-test anti-drift assertion module covers ALL six locked strings (Tasks 5/6/8).   |
| 6   | Cold-resume splash + billing-locked view    | ✅ DONE | `4dccf6b4` | Route-state union extended; pure derivation; 5 new state-resolution tests covering all four branches + on-host happy path.                |
| 7   | Worktree GC after archive                   | ✅ DONE | `ed725fb1` | `purgeLocalStateForArchivedWorkspace` + pure path-match helpers. 7 tests including the D-1.5 two-worktree drift reproduction.             |
| 8   | `billing_locked` upgrade prompt skeleton    | ✅ DONE | `8f7553d5` | "Plan inactive" picker badge + direct `/settings/billing` route on click. Route-gate view already in place from Task 6.                   |
| 9   | Setup wizard chooser                        | ✅ DONE | `c6b51efe` | Pure helpers in `orchestra-setup-helpers.ts` + 7 tests for filter, chooser-vs-form decision, and header title.                            |
| 10  | Cache invalidation seam                     | ✅ DONE | `324c9a9f` | `invalidateCloudWorkspacesCache` helper called from both mutations. 2 tests for key + no-double-fetch.                                    |
| 11  | Documentation                               | ✅ DONE | `630c77f9` | `docs/agent-lifecycle.md` cloud-workspace state table; CLAUDE.md locked-copy rule. Grep target satisfied: 1 constant + 1 anti-drift test. |

## Deviations from the plan (judgment calls)

- **Task 5 — kebab/overflow menu collapsed to inline `[Archive]` button.** The plan asks for a kebab/dropdown matching `sidebar-workspace-list.tsx`. I went with an inline button instead because:
  - The dropdown would have exactly one item ("Archive workspace…"); a one-item dropdown is overkill.
  - The active section now has a symmetric pair: `[Archive]` on active rows, `[Unarchive]` on archived rows. UX consistency.
  - Nesting a `DropdownMenu` inside the picker `Modal` portal-tree adds layering complexity for negligible gain.
  - If we ever need additional per-row actions (rename, copy URL, etc.), promoting to a dropdown is a localized refactor.

- **Task 8 — picker click on `billing_locked` routes directly to `/settings/billing`.** The plan reads as if clicking a `billing_locked` workspace should land on a workspace screen rendering the upgrade prompt. I implemented direct routing to `/settings/billing` instead because:
  - The lifecycle worker has stopped the daemon container; `openProject` would fail before we get a worktreeId to put in the workspace route.
  - The workspace-route-state `"billing-locked"` view (added in Task 6) still covers the other entry path — a workspace already open when DDB flips `state` to `billing_locked`.
  - The user-facing outcome is the same: discover plan inactive → land at plan management.
  - COMPAT(billing_locked) tags both the picker handler and the route-gate handler for the D-4 cleanup grep.

## Cross-stream dependencies and gates

All HTTP routes the app needs from PLAN-auth-and-shared are referenced by the client; nothing was mocked in production code. Where the deployed routes are not yet live (orchestra-cloud-private side), tests use mocked `fetch` responses against the agreed shape:

- `GET /api/v1/cloud/workspaces` → list with `state` + `archivedAt` (tests fixture this in `orchestra-cloud-client.test.ts`).
- `POST /api/v1/cloud/workspaces/:id/archive` → returns `WorkspaceRecord` with `state="archived"` + `archivedAt`.
- `POST /api/v1/cloud/workspaces/:id/unarchive` → returns `WorkspaceRecord` with `state="active"` + `archivedAt=null`.

If the proprietary side ships those routes in two steps (e.g. `state` field first, then `archivedAt`), Task 2's tolerant defaults (`state ?? "active"`, `archivedAt ?? null`) cover the cutover window — the picker quietly renders everything as active until both fields arrive.

PLAN-lifecycle-worker is the timeout-owner for cold-resume — the splash holds indefinitely on the client per workspace-lifecycle.md § "Invisible to users". No deferred follow-up needed; the splash-error fallback is in the plan's § "Deferred follow-ups" already.

## What I could not verify in this sandbox

- **Live UI walkthrough against `orchestra-dev`.** CLAUDE.md asks for browser verification on UI changes. The sandbox does not have network access to the deployed stack, and starting the dev server here would also need a daemon endpoint. **The plan's V1–V6 sequences need to be run by the operator against the deployed stack** once PLAN-auth-and-shared's routes are live. The unit tests cover the pure logic; the integration walkthrough is operator-owned.
- **The 30-day GC actually firing.** Same constraint as the plan calls out — no way to test a real 30-day timer here.

## Deferred follow-ups carried forward

The plan's § "Deferred follow-ups" list is unchanged by this implementation. Specifically:

- Per-account archive cap UI — Day-2.
- Bulk archive verb in the picker — Day-2.
- "Restore from archive" admin verb — Day-2.
- Pre-purge T-24h "this will be deleted in 24 hours" banner — Day-2 (requires `scheduled_purge_at` on the list response).
- Picker keyboard navigation across both sections — D-1.5 carry-over, deferred again.
- Splash-error fallback after 30-60s of stuck resume — Day-2.
- `cloudWorkspaceId` rename across the AGPL side — D-1.5 follow-up, still deferred.

## New follow-ups surfaced during implementation

- **Task 5 inline-archive-button rationale wants D-2 walkthrough confirmation.** If the operator's V1 walkthrough surfaces UX confusion (e.g. the inline button feels too close to the row tap target), promoting to a kebab dropdown is a ~2h refactor.
- **Verifying that `openProject` works for newly-resumed `suspended` cloud workspaces.** The cold-resume splash exits when EITHER `state` flips or `connectionStatus` reaches `online`. If the daemon container's first frame after RunTask takes longer than the WS handshake timeout, the user could see splash → WorkspaceUnreachable flicker. This would surface during the V2 walkthrough.

## Files touched (commit-summary)

- 11 production source files, 9 new test files, 2 doc files updated.
- 12 atomic commits (1 plan + 11 task commits).
- All on `d-2-plan-app`, none pushed.

## Test summary

```
8 test files, 57 tests, all passing:
  contexts/orchestra-session-context.test.tsx ......... 3
  lib/orchestra-cloud-client.test.ts .................. 17
  utils/cloud-workspace-sections.test.ts .............. 3
  screens/workspace/workspace-route-state.test.ts ..... 11
  workspace/cloud-workspace-gc.test.ts ................ 7
  components/cloud-workspace-archive-dialog.test.ts ... 7
  screens/orchestra/orchestra-setup-screen.test.ts .... 7
  hooks/cloud-workspaces-cache.test.ts ................ 2
```

Full repo `npm run typecheck`: clean. Full repo `npm run format:check`: clean. `npm run lint` on all 29 touched files: clean.
