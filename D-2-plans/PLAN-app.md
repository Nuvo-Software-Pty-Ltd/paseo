# D-2 PLAN-app — client/UI slice

Scope: AGPL fork (`paseo-fork`), branch `d-2-plan-app`. The client-side surface area for D-2's per-workspace tenancy: lifecycle UX (archive/unarchive/resume splash/billing-locked), the centralized session-expired handler the D-1.5 closeout filed, a "create new workspace" affordance for the setup wizard that no longer falls through `existing[0]`, and the local session-store / worktree GC that D-1.5's two-worktree drift surfaced.

Sibling streams (out of scope here, but every item below names the cross-stream dependency it relies on):

- **PLAN-daemon** (`paseo-fork`) — per-workspace daemon container, mount layout under `/workspace/<id>/.git-canonical`, repair-on-missing.
- **PLAN-auth-and-shared** (`orchestra-cloud-private`) — new `archive`/`unarchive` HTTP routes, `state` field on `WorkspaceRecord`, `archivedAt` on the list response, `keys.archiveSchedule(workspaceId)` helper, `userString({maxLength})` reuse.
- **PLAN-lifecycle-worker** (`orchestra-cloud-private`) — async ECS service that drives `active ↔ suspended` and fires the EventBridge-Scheduler-scheduled hard-delete.
- **PLAN-cdk-infra** (`orchestra-cloud-private`) — ALB rules, ECS task defs, IAM, EventBridge Scheduler bootstrap.

**Terminology note** (carried forward from D-1.5 § "Terminology note"). `workspaceId` is overloaded. In this plan:

- **`cloudWorkspaceId`** = the cloud tenancy identifier (`ws_xxxxx`), issued by the auth service, stored on `WorkspaceRecord.workspaceId` (`packages/app/src/lib/orchestra-cloud-client.ts:20`) and `HostConnection.workspaceId` (`packages/app/src/runtime/host-runtime.ts:1431`).
- **`worktreeId`** = on-host paseo's worktree/project identifier (also called `workspaceId` in `packages/app/src/stores/session-store.ts` and `packages/server/src/shared/messages.ts`).

When this plan writes `workspaceId` unqualified, it means **cloudWorkspaceId**. The D-1.5 closeout filed the AGPL-side `cloudWorkspaceId` rename as a follow-up; this plan does not touch the rename. PLAN-auth-and-shared owns the proprietary-side type rename decision; the AGPL side follows in a later cleanup.

---

**Post-planning synthesis (LEARNINGS.md 2026-05-22) — no changes required for this plan:**

The 2026-05-22 cross-stream review resolved three contradictions across the other four plans (cloud-workspace archive → session-authed REST; KMS CMK → per-workspace; suspend detection → DDB heartbeat). This plan's Task 5 (the user-facing Archive button calling `POST /api/v1/cloud/workspaces/:id/archive` directly via the existing session-authed client) was already aligned with the resolved shape — the synthesis explicitly confirmed "PLAN-app: no changes — Task 5's direct REST archive flow is correct as-written." The other two decisions (CMK granularity, suspend mechanism) are server-side and do not affect the client UX.

---

## Stream summary

D-1.5 shipped the picker section (a flat list of `WorkspaceRecord`s, every row routes to `/workspace/<id>/.git-canonical`) and the reconcile-on-credential-submit guard. D-2 grows the UI to handle a richer lifecycle:

- **Archived workspaces are first-class** — a separate "Archived" tab in the picker with the unarchive button and the 30-day GC promise visible.
- **Auto-suspend is invisible day-to-day** — a "Resuming workspace…" splash appears on the cold-resume path, then disappears the moment the WS upgrades to `online`.
- **`billing_locked` is a reserved state** — a non-actionable upgrade prompt with a TODO link to the (D-4) plan-management page. Wire so D-4 can flip a flag, no UX retrofit needed.
- **Session expiry is one seam, not three** — `OrchestraSessionExpiredError` triggers a single canonical "bounce to `/welcome`" path; the picker hook and the setup wizard both stop swallowing it locally.
- **"Create a new workspace" is reachable** — the setup wizard's `existing[0]` shortcut becomes one of two affordances on a chooser screen.
- **Worktree GC after archive/delete** — local session-store reset so the two-worktree drift D-1.5 surfaced does not reproduce in a multi-workspace world.

The PLAN does **not** ship: any cross-tenant probe instrumentation (that's the D-2 hands-on gate's owner — operator-side scripting), per-workspace daemon container surfaces beyond consuming the new `state` field, or any change to the AGPL-core wire shape. Existing `archive_workspace_request` stays unchanged; this plan introduces a parallel cloud-archive HTTP path that flips DDB + schedules GC, leaving the on-host RPC for the daemon's internal worktree concept.

## D-2 closure criteria for this slice

The client-side D-2 work is done when every one of the following passes against the deployed stack:

1. **Archive lifecycle, end-to-end.**
   - From the picker, an active cloud workspace can be archived. The row disappears from the active section, reappears in the "Archived" tab. Confirmation modal shows the locked copy: _"Archive this workspace? Archived workspaces will be permanently removed after 30 days."_
   - In the Archived tab, the workspace's `archivedAt` renders as a relative time ("Archived 2 days ago"); a single `[Unarchive]` button is visible per row.
   - Pressing Unarchive returns the workspace to the active section. Pressing the row body (opening the workspace) also unarchives it, matching the on-host's cwd-reopen behavior.
   - Archived tab footer renders the locked copy: _"Archived workspaces will be permanently removed after 30 days."_

2. **Cold-resume splash.**
   - Opening a `suspended` workspace shows a "Resuming workspace…" splash while the WS is upgrading. Splash dismisses the moment `connectionStatus === "online"`. No copy about idle timeout or "your workspace was paused."
   - Cold-resume target per the spec is <5 s warm-pool; the splash must render even on a sub-second resume so users don't see a flicker of the empty workspace before the timeline loads.

3. **`billing_locked` skeleton.**
   - Opening a `billing_locked` workspace surfaces the locked copy: _"Reactivate your plan to resume this workspace."_ with a link target that resolves to `/settings/billing` (the route doesn't have to exist yet — the link target is the contract).
   - No WS connection is attempted while a workspace is in this state; the picker row remains visible (it's a "you can see this but can't open it" state, not a hidden state).

4. **Session-expired single seam.**
   - `OrchestraSessionExpiredError` thrown from any HTTP call to the auth service (list/create/credential/archive/unarchive/mintToken) triggers a single global handler that clears the session token and routes to `/welcome` with an inline banner ("Your session expired. Sign in again to continue.").
   - The setup wizard's `handleSetCredential` catch block stops rendering the inline error string for the session-expired case (still renders for actual setAnthropicCredential / mintWorkspaceToken errors).
   - `useCloudWorkspaces` stops swallowing the error to `data: []`; the picker's section just doesn't render while the bounce is in flight.

5. **"Create a new workspace" reachable.**
   - When the user has 0 cloud workspaces, the setup wizard's `workspace` step renders as today (form for repoUrl + displayName).
   - When the user has ≥1 cloud workspaces, the wizard's `workspace` step renders a chooser: a list of existing workspaces (each tappable to reuse with new credential) plus a "Create a new workspace" affordance that opens the form. No silent `existing[0]` shortcut.

6. **Worktree GC after archive/delete.**
   - Archiving a cloud workspace (which also stops its daemon container via the lifecycle worker) leaves no phantom worktree under that workspace's serverId in the local `session-store`. Specifically: opening the picker after the archive completes shows no rows under "Cloud workspaces" for that workspace; opening the active host's sidebar shows no worktree rows for the archived workspace; and unarchiving + reopening the workspace produces exactly one worktree row, not two.

7. **No regressions in D-1.5 happy path.**
   - The 8-step D-1 UAT (welcome → OAuth → setup → workspace create → picker → workspace open → agent prompt → refresh) still passes with no operator-visible changes outside the new chooser-vs-form decision on the `workspace` step (it still defaults to "Create" when the account has zero workspaces).

8. **Open-core boundary intact.**
   - No proprietary `@orchestra/*` imports in `packages/app/src/`. Every new HTTP call sits in `packages/app/src/lib/orchestra-cloud-client.ts`. The Zod-duplication anti-drift comments are preserved.

---

## Numbered task list

Tasks are ordered so that each task's prerequisites land first. Sizes are S/M/L (~hours): S ≤ 2h, M 2–6h, L 6h+.

### Task 1 — Centralized `OrchestraSessionExpiredError` handler (P0)

**Size:** M. (Foundation for everything else: items 2–7 all throw this error.)

**Cross-stream dependency.** None — pure client work. Trusts the existing `authedFetch` 401-throws behavior in `packages/app/src/lib/orchestra-cloud-client.ts:59-61`.

**Files touched.**

- `packages/app/src/lib/orchestra-cloud-client.ts` — wire a process-global event emitter on `OrchestraSessionExpiredError`; add a `signalSessionExpired()` helper called from `authedFetch` before throwing.
- `packages/app/src/contexts/orchestra-session-context.tsx` (new) — a thin context provider that subscribes to the emitter, calls `clearSession()`, and `router.replace("/welcome?reason=session-expired")`.
- `packages/app/src/app/_layout.tsx` — mount the new provider above `AppShell` (inside `RuntimeProviders`, below `ToastProvider` so the bounce can render a toast on its way out).
- `packages/app/src/components/welcome-screen.tsx` — read the `?reason=session-expired` param (or a transient store flag — see Acceptance) and render an inline banner above the action buttons: _"Your session expired. Sign in again to continue."_
- `packages/app/src/hooks/use-cloud-workspaces.ts` — **remove** the in-hook `OrchestraSessionExpiredError → data:[]` swallow (currently lines 27-33). Let it propagate; the global handler bounces; the picker simply renders zero rows while the bounce is in flight.
- `packages/app/src/screens/orchestra/orchestra-setup-screen.tsx` — drop the inline-error path for the session-expired case from `handleCreateWorkspace` / `handleSetCredential` (keep the inline-error path for actual operation failures).

**Acceptance.**

- Manually corrupting the `orchestra:session_token` in AsyncStorage between two HTTP calls bounces the user to `/welcome` exactly once, regardless of which call (list / create / credential / mint / archive / unarchive) tripped the 401.
- `?reason=session-expired` in the URL is the wire that survives a router replace; **alternative:** if the query-param approach fights `expo-router`, fall back to a tiny synchronous store (`useSessionExpiryStore`) that the welcome screen reads on mount and clears after one render. Pick whichever is cleaner during implementation; both meet the AC.
- Unit test (`packages/app/src/contexts/orchestra-session-context.test.tsx`, new): firing the emitter calls `clearSession` once and `router.replace("/welcome?reason=session-expired")` once even when multiple in-flight requests throw simultaneously (debounce in the provider).
- After the bounce, the picker on the next sign-in shows the just-restored cloud workspaces (the bounce did not corrupt the react-query cache).
- The single seam is grep-able: `rg "OrchestraSessionExpiredError" packages/app/src/` should show one _throw_ site (`orchestra-cloud-client.ts`) and one _catch-and-handle_ site (the new context).

**Rationale.** D-1.5 § "Centralized auth-session reset on `OrchestraSessionExpiredError`" filed this as the P0 unblocker for multi-tenancy: silent expired-sessions are how operators get stuck mid-workflow with no UI affordance to recover (as observed during the D-1.5 walkthrough). Bouncing to `/welcome` is the canonical "you're signed out, sign back in" gesture this app already uses; the new context just makes it automatic.

---

### Task 2 — Cloud workspace state surfacing (P0; foundation for tasks 3-6)

**Size:** S. (Schema wire-up; no UX yet.)

**Cross-stream dependency.** **Blocked on PLAN-auth-and-shared** adding `state` (`"active"|"suspended"|"billing_locked"|"archived"`) and `archivedAt` (`string|null`) to the `WorkspaceRecord` shape served by `GET /api/v1/cloud/workspaces`. The list response is the only place the client reads this; if the proprietary side ships in two steps (state first, archivedAt second), this task can land alongside the first step and re-land the second.

**Files touched.**

- `packages/app/src/lib/orchestra-cloud-client.ts` — extend the `WorkspaceRecord` interface with `state: "active"|"suspended"|"billing_locked"|"archived"` and `archivedAt: string | null`. **Protocol contract:** both fields are tolerant — `state` defaults to `"active"` if absent; `archivedAt` defaults to `null`. Old clients reading new daemons keep working; new clients reading old daemons (during the cutover window) treat every workspace as `state="active"`. Mark with `// COMPAT(workspaceState): added in v0.1.X, drop the default when daemon floor >= v0.1.X` per CLAUDE.md § "All back-compat shims are tagged and dated for cleanup."
- `packages/app/src/lib/orchestra-cloud-client.test.ts` — extend the existing list-workspace tests with one fixture per state.

**Acceptance.**

- `npm run typecheck` clean.
- `useCloudWorkspaces()` consumers can read `.state` and `.archivedAt` on every row.
- A list response with `state` and `archivedAt` omitted still parses; the in-memory shape carries `state:"active", archivedAt:null`.

**Rationale.** Every downstream task in this plan filters or branches on `state`. Locking the type once at the boundary keeps the branches in component code from drifting (the F11 single-discriminator design-out applies here too — `state` is THE workspace discriminator on the client side).

---

### Task 3 — Split picker into "Active" + "Archived" sections (P0)

**Size:** M.

**Cross-stream dependency.** Builds on Task 2 (needs `state` + `archivedAt`). No new auth-service routes for this task (read-side only — the existing `GET /workspaces` returns archived rows too).

**Files touched.**

- `packages/app/src/components/project-picker-modal.tsx` — partition `cloudWorkspaces` by `state === "archived"`. Render the existing "Cloud workspaces" header above the active rows. Add a new "Archived" section header below the directory-suggestions block. Archived rows use a faded text color and a different icon (e.g., `Archive` from `lucide-react-native`).
- `packages/app/src/components/project-picker-modal.tsx` — append a permanent footer line under the Archived section (only when ≥1 archived row): _"Archived workspaces will be permanently removed after 30 days."_ This is locked copy from `workspace-lifecycle.md` § "UX copy" — do not paraphrase.
- `packages/app/src/utils/relative-time.ts` (likely already exists; if not, add) — format `archivedAt` ISO timestamp into "Archived 2 days ago" / "Archived 30 minutes ago". Use a tiny in-house formatter, not a new dep.

**Acceptance.**

- Two cloud workspaces, one active, one with `state:"archived"` and `archivedAt="2026-05-20T...".` → picker shows the active one in the existing section and the archived one in the new "Archived" section.
- Switching `state` from `"active"` to `"archived"` (DDB-poke-then-refetch in dev) moves the row between sections after the next 15s react-query refresh window or an explicit invalidate.
- Footer copy is exact: _"Archived workspaces will be permanently removed after 30 days."_ No abbreviation. The 30-day window is product-locked.
- Empty "Archived" tab/section: no header rendered (no empty-state copy needed Day-1).
- Keyboard navigation: archived rows are **not** part of the existing `activeIndex` walk (same decision as D-1.5; arrow keys still walk only the directory-suggestions list; archived is tap/click-only). File a deferred follow-up consistent with D-1.5's existing one.

**Rationale.** Closest parallel to the on-host's "hidden from sidebar" archived semantics. Putting the GC promise visible in the section that contains the archived rows means a user who archived 30 days ago sees the warning while it still matters. Keeping the picker as the canonical "where do I open a workspace" surface (rather than a new "Manage workspaces" screen) keeps the modal-vs-page surface count low.

---

### Task 4 — "Unarchive" button + unarchive-on-open behavior (P0)

**Size:** M.

**Cross-stream dependency.** **Blocked on PLAN-auth-and-shared** shipping:

- `POST /api/v1/cloud/workspaces/:id/unarchive` (HTTP, session-auth) — flips DDB `state:"active"`, clears `archivedAt`, deletes the EventBridge T-24h + T-0 schedules registered at archive time.
- The on-host `findOrCreateWorkspaceForDirectory` clears `archivedAt` for the on-disk workspace when the cwd is reopened. This is unchanged AGPL behavior; the cloud parity is: opening an archived cloud workspace from the picker fires the HTTP unarchive **before** opening the daemon WS, so the cloud-side DDB row also flips back.

**Files touched.**

- `packages/app/src/lib/orchestra-cloud-client.ts` — add `unarchiveWorkspace(workspaceId): Promise<WorkspaceRecord>`. Same Zod shape on success as the existing setAnthropicCredential helpers. Throws `OrchestraSessionExpiredError` on 401 (caught by Task 1's handler); other errors propagate.
- `packages/app/src/components/project-picker-modal.tsx` — `ArchivedWorkspaceRow` component (separate from `CloudWorkspaceRow`) carries a small `[Unarchive]` button on the right edge plus the row press handler. Button click stops propagation; row press handler triggers the unarchive-on-open path.
- `packages/app/src/hooks/use-unarchive-workspace.ts` (new) — react-query mutation wrapping `unarchiveWorkspace`. On success: `queryClient.invalidateQueries({ queryKey: CLOUD_WORKSPACES_QUERY_KEY })`. On error: toast `"Failed to unarchive — {error.message}"`.
- `packages/app/src/components/project-picker-modal.tsx` — on archived row press, the handler awaits `unarchiveWorkspace.mutateAsync(...)` first, then calls the existing `handleSelectPath("/workspace/<id>/.git-canonical")`. The Toast surface added in Task 1 covers the failure case (sticky banner: _"Unarchived — this workspace is active again"_ matches the spec's locked copy from `workspace-lifecycle.md` § "UX copy").

**Acceptance.**

- Clicking `[Unarchive]` on an archived row: row moves to the active section after the mutation completes. No workspace is opened; the picker stays open so the user can choose what to do next.
- Clicking the row body of an archived workspace: workspace opens AND a one-shot banner renders inside the workspace shell — _"Unarchived — this workspace is active again."_ The banner auto-dismisses after ~5 s.
- If the cloud-side unarchive succeeds but the daemon-side reopen fails (network glitch, missing path), the picker shows the workspace moved to active but the user sees the existing `WorkspaceUnreachable` view; retrying from there does NOT re-fire the unarchive (the row is already `state:"active"`).
- Test plan covers: (a) successful unarchive-and-stay; (b) successful unarchive-and-open; (c) unarchive request fails after the optimistic UI moved the row (re-revert on error).
- The two unarchive paths share **one** code path (`unarchiveWorkspace` mutation) — F9 design-out (one writer per side effect). Do not duplicate the HTTP call inside the row-press handler.

**Rationale.** The on-host's "unarchive-on-cwd-reopen" parity is load-bearing per `LEARNINGS.md` 2026-05-22: _"Skipping either side breaks the parity (one would surprise on-host migrants; the other would be a discoverability gap)."_ The explicit button is the discoverable affordance for users who only want to revive the workspace without opening it. The row-press is the on-host parity. Both go through one HTTP call.

---

### Task 5 — Archive confirmation modal with the locked copy (P0)

**Size:** S–M.

**Cross-stream dependency.** **Blocked on PLAN-auth-and-shared** shipping:

- `POST /api/v1/cloud/workspaces/:id/archive` — flips DDB `state:"archived"`, sets `archivedAt = now()`, registers EventBridge T-24h + T-0 schedules. **Note for the auth agent:** the route should also cause a `StopTask` on the per-workspace daemon container; that's a sub-stream concern between auth and the lifecycle worker. The client doesn't observe it.

**Files touched.**

- `packages/app/src/lib/orchestra-cloud-client.ts` — add `archiveCloudWorkspace(workspaceId): Promise<WorkspaceRecord>`. Distinct from the existing on-host `client.archiveWorkspace` (the on-host WS RPC) — name mirrors the layer split. Add a comment in the file that calls out the distinction so a future reader doesn't accidentally swap them.
- `packages/app/src/hooks/use-archive-cloud-workspace.ts` (new) — react-query mutation. Wraps `archiveCloudWorkspace`. On success: invalidate `CLOUD_WORKSPACES_QUERY_KEY` and call into Task 7's worktree-GC helper.
- `packages/app/src/components/cloud-workspace-archive-dialog.tsx` (new) — a confirmation dialog using the existing `confirmDialog` helper (same one `sidebar-workspace-list.tsx` uses for on-host hide). Locked title and message:
  - Title: _"Archive this workspace?"_
  - Message: _"Archived workspaces will be permanently removed after 30 days."_
  - Confirm label: _"Archive"_ (destructive variant)
  - Cancel label: _"Cancel"_
- Wire the dialog into the picker: on the active section's `CloudWorkspaceRow`, add a kebab/overflow menu (matches the pattern in `sidebar-workspace-list.tsx`) with one item: "Archive workspace…". Choosing it shows the dialog. (Per CLAUDE.md § "Platform gating" — kebab visibility uses `isHovered || isNative || isCompact`; ensure native/iPad shows the kebab always.)

**Acceptance.**

- Active row → kebab → "Archive workspace…" → modal renders with the exact title/message/labels above. Cancel closes; Archive fires the mutation.
- After Archive success: row moves to "Archived" section in the same picker session; the active section's count decrements. No page refresh required.
- Optimistic UI: row vanishes from active immediately; reappears in archived after server roundtrip (no flicker on success path). On error: row re-appears in active + toast.
- The modal's copy is exact and not paraphrasable — pull it from a single source-of-truth constant (`ARCHIVE_DIALOG_TITLE` / `ARCHIVE_DIALOG_MESSAGE` in `cloud-workspace-archive-dialog.tsx`) so any future copy change is one edit. Add a unit test that asserts the constant equals the spec string verbatim, to prevent silent drift.
- Test plan covers: (a) confirm → success path; (b) confirm → server 500 path (row restored, toast); (c) confirm → 401 path (Task 1's global handler bounces; no inline error in the picker).

**Rationale.** The locked copy is load-bearing: it is the **only** place the user-visible 30-day promise appears at the time the destructive action is taken. The Archived tab footer (Task 3) carries the same message for users who archived earlier and are now revisiting. Two locations, one string, locked in code so a marketing-driven rephrase has to walk through this anti-drift assertion.

---

### Task 6 — Cold-resume splash UX (P0)

**Size:** M.

**Cross-stream dependency.** **Blocked on PLAN-lifecycle-worker** for the actual suspend/resume mechanism (whichever it picks for suspend detection — DDB heartbeat / ALB connection metric / daemon webhook — the client doesn't care). Soft-blocked on PLAN-daemon making sure the daemon container's WS upgrade path tolerates the cold-resume window (no first-frame timeout failures that look like errors instead of "resuming"). Soft-blocked on PLAN-auth-and-shared for the `state` field surfaced in Task 2 so the splash logic can distinguish "user clicked a suspended workspace" from "user clicked an active workspace that's just slow."

**Files touched.**

- `packages/app/src/components/cloud-resume-splash.tsx` (new) — minimal splash component. Reuses the `LogoShimmer` / spinner pattern from `packages/app/src/screens/startup-splash-screen.tsx` (do not import the full splash screen — that one carries error-state UI we don't want here). Copy: _"Resuming workspace…"_ — locked copy.
- `packages/app/src/screens/workspace/workspace-route-state-views.tsx` — extend `renderWorkspaceRouteGate` to handle a new `"cold-resume"` kind. The state derivation in `workspace-route-state.ts` picks `"cold-resume"` when (a) the active host's preferred connection has a `workspaceId`, (b) the matching `WorkspaceRecord.state === "suspended"` per the latest `useCloudWorkspaces()` cache, AND (c) `connectionStatus === "connecting"`. Falls through to the existing `"loading"` view once `state` flips to `"active"` (the lifecycle worker writes this after `RunTask`) or `connectionStatus === "online"`, whichever fires first.
- `packages/app/src/screens/workspace/workspace-route-state.ts` — extend the state union to include `"cold-resume"`. Update the type narrowing in the views file.

**Acceptance.**

- Open an active workspace → existing "Loading workspace" / spinner view renders. No splash text change. (Regression-free for the D-1.5 happy path.)
- Open a `suspended` workspace → "Resuming workspace…" splash renders while the WS upgrade is in flight. As soon as `connectionStatus === "online"`, the splash dismisses and the timeline loads. **No** error-state UI even if the resume takes >5 s — splash holds indefinitely (the lifecycle worker is the timeout-owner; the client just waits).
- On a fresh cold-resume the splash must render even on a sub-second resume — there should be no flicker where the user sees the empty workspace shell before the timeline loads. Implementation: gate the workspace screen's children on `connectionStatus === "online"` for cloud-host routes; the splash sits above. (This is a defensive small chrome change; ensure it does not regress the on-host happy path's instant-render behavior — the gate is only active when `useIsCloudHost(serverId)` is true.)
- Test plan covers: (a) state="active" + connecting → "Loading workspace"; (b) state="suspended" + connecting → "Resuming workspace…"; (c) state="suspended" → "active" mid-connect → splash dismisses; (d) state stays "suspended" but connectionStatus → "online" → splash dismisses (defensive: the lifecycle worker's state flip and the WS online event are independent; either should end the splash).
- Locked copy assertion (same pattern as Task 5): one constant, one unit test asserting the string equals the spec.

**Rationale.** Per `workspace-lifecycle.md` § "UX copy" Invisible-to-users: _"Auto-suspend has no copy, no confirmation, no settings toggle Day-1."_ The splash is the only user-visible artifact of the suspend mechanism. Holding it indefinitely (no timeout, no retry button) reinforces that suspend is mechanical and not user-recoverable — which is the right tone for a state the user did not ask for.

---

### Task 7 — Worktree GC after archive/delete (P0)

**Size:** M–L. (The two-worktree drift D-1.5 surfaced is the empirical evidence this is non-trivial.)

**Cross-stream dependency.** Sequential after Task 5 (the archive call). Soft-coupled to PLAN-daemon — when the lifecycle worker StopTasks the per-workspace daemon, the next picker click will trigger a fresh RunTask, and the new container has no EBS-attached state from the previous incarnation. The client's job is to make sure the local `session-store` reflects the same fresh state.

**Files touched.**

- `packages/app/src/workspace/cloud-workspace-gc.ts` (new) — `purgeLocalStateForArchivedWorkspace({ serverId, cloudWorkspaceId })` helper. Walks the local `useSessionStore` and the `useHostRuntimeStore`:
  - From the session store: remove every workspace descriptor under `sessions[serverId].workspaces` whose path/id corresponds to the archived cloud workspace (the canonical mount is `/workspace/<cloudWorkspaceId>/.git-canonical` — match by that). Use the existing `removeWorkspace` mutator. Also clear agent records under `sessions[serverId].agents` that belonged to the archived workspace (if any are present; the D-1.5 footgun specifically called out phantom worktree rows).
  - From the host-runtime store: archived cloud workspace's `HostConnection` (the directTcp connection carrying `workspaceId=cloudWorkspaceId`) **stays** — the host is still the same daemon endpoint; the workspace identity is separate from the connection identity. Do NOT call `removeConnection` from here; that path is for explicit host-management actions.
- `packages/app/src/hooks/use-archive-cloud-workspace.ts` — invoke `purgeLocalStateForArchivedWorkspace` in the mutation's `onSuccess` callback, before the react-query invalidate. Order matters: clear local state first so the picker's next render reads no stale rows.
- `packages/app/src/workspace/cloud-workspace-gc.test.ts` (new) — deterministic test that seeds the session store with two workspaces for the same `serverId` (mimicking the D-1.5 drift: an old archived workspace + a fresh one), calls the helper for the archived one, asserts only the fresh one remains. Cover the case where the user has multiple cloud workspaces on the same daemon (D-2 scenario): archiving one must not touch the others.

**Acceptance.**

- Archive a cloud workspace → open the host's sidebar → no worktree row exists for the archived workspace's `/workspace/<id>/.git-canonical` path. No phantom row.
- Archive a cloud workspace, then unarchive it, then reopen → exactly **one** worktree row exists in the sidebar (the fresh one). Not two.
- The D-1.5 reproduction (delete agora workspace, recreate with new `ws_id`) ports to D-2 (archive agora workspace, archive-then-unarchive, recreate) and produces exactly one sidebar row.
- The `purge` helper is idempotent — calling it twice for the same `cloudWorkspaceId` is a no-op the second time.

**Rationale.** D-1.5 LEARNINGS 2026-05-22 § "Surprising": _"When the agora workspace was deleted from DDB and recreated (different `ws_id`), the browser's local session store retained the old worktree entry alongside the new one — sidebar showed two 'main' branches under 'Nuvo-Software-Pty-Ltd/agora'."_ This is the canonical bug-shape. In D-2 with multiple workspaces per account, the drift compounds — every archive-then-recreate cycle adds a phantom. The GC helper is the seam the D-1.5 closeout filed for D-2. Note the daemon-side EBS path cleanup is a separate concern owned by PLAN-daemon / PLAN-lifecycle-worker; this task only does the client-side reset.

---

### Task 8 — `billing_locked` upgrade prompt skeleton (P0; wired-not-connected)

**Size:** S.

**Cross-stream dependency.** **Blocked on PLAN-auth-and-shared** for the `state="billing_locked"` value (Task 2). Not coupled to D-4 billing — D-4 lights up the link target. Day-1 the link points at `/settings/billing` which 404s gracefully (or a static "Coming soon" page); that's intentional.

**Files touched.**

- `packages/app/src/screens/workspace/workspace-route-state-views.tsx` — add a new `"billing-locked"` view kind. Title: _"Reactivate your plan to resume this workspace."_ (locked copy per `workspace-lifecycle.md` § "UX copy"). Single button: "Manage plan" → `router.push("/settings/billing")`.
- `packages/app/src/screens/workspace/workspace-route-state.ts` — derive `"billing-locked"` when `WorkspaceRecord.state === "billing_locked"`, before the route attempts a WS connection. (Important: this short-circuits before `connectToDaemon` is invoked — we don't want the daemon container to RunTask for a `billing_locked` workspace.)
- `packages/app/src/components/project-picker-modal.tsx` — picker still shows the workspace row in the active section (per the spec, it's visible-but-not-openable). Add a small text below the row name: _"Plan inactive"_ in a muted/warning color. Opening still triggers the `"billing-locked"` view; we deliberately let the user click through to discover the upgrade prompt.

**Acceptance.**

- A workspace with `state="billing_locked"` is visible in the active section with a "Plan inactive" badge. Clicking it does not open a WS; instead the `"billing-locked"` view renders with the locked copy and the "Manage plan" button.
- The route does **not** attempt a daemon connection while `state="billing_locked"`. (Verify in the host-runtime — `connectToDaemon` is short-circuited on this path.)
- Once D-4 flips `state` back to `"active"`, the view advances normally on the next list refresh.
- Test plan covers: (a) row visible in picker; (b) opening → upgrade view; (c) link target navigates to `/settings/billing` (even if 404 — that's D-4's job to land); (d) no daemon WS upgrade attempt is observable on the network tab.
- COMPAT comment marking this skeleton — `// COMPAT(billing_locked): D-2 ships the UX; D-4 wires the route. When D-4 closes, drop the "Coming soon" fallback at /settings/billing.`

**Rationale.** Per `workspace-lifecycle.md` § "Day-1 simplifications": _"`billing_locked` state reserved but not wired. Lands with billing module at D-4. The lifecycle worker handles the transition trigger; D-2 just allocates the state value and ensures the picker UX accepts it."_ Locking the UX in D-2 means D-4 needs zero client work to light up — just a server-side state flip. This is exactly the "reserved state" pattern.

---

### Task 9 — Setup wizard: split "create new" from "reuse existing"

**Size:** M.

**Cross-stream dependency.** None — pure client work. Depends on Task 2 only insofar as the chooser shows `state` per workspace (for parity with the picker).

**Files touched.**

- `packages/app/src/screens/orchestra/orchestra-setup-screen.tsx` — restructure the `workspace` step. The current `handleCreateWorkspace` (lines 191-221) has the `if (existing.length > 0) { setWorkspace(existing[0]); setStep("credential"); return; }` shortcut that hides the create-new path. Split into:
  - **New chooser step** (call it `chooser`): rendered as a list of existing workspaces (one card per `WorkspaceRecord`, showing displayName/repoUrl/state) PLUS a "Create a new workspace" call-to-action card.
  - Step routing: app enters `workspace` step → if `existing.length === 0`, render the form (today's `WorkspaceStep` component) → if `existing.length > 0`, render the chooser → user taps an existing → set `workspace = picked; setStep("credential")` → user taps "Create new" → render the form inline (no further step), submission creates via `createWorkspace(...)` as today.
- Hide archived workspaces from the chooser (filter `state !== "archived"`). They're for the picker, not the wizard. The wizard's whole point is "pick an active workspace to set credentials on" or "create a new one."
- Wire the "Create new workspace" CTA so it always uses the existing form path — same `repoUrl` / `repoLess` / `displayName` fields as today. **Do not** reset state between the chooser and the form on Back nav; preserve the user's typed values.
- `packages/app/src/screens/orchestra/orchestra-setup-screen.test.tsx` (extend or create) — cover: (a) zero workspaces → form renders directly; (b) one workspace → chooser with one card + "Create new" CTA → tap card → credential step; (c) one workspace → chooser → tap "Create new" → form renders → submit creates a second workspace.

**Acceptance.**

- A user with zero cloud workspaces sees the same form they see today.
- A user with one or more cloud workspaces sees the chooser and can either (a) pick an existing workspace OR (b) tap "Create new" to reach the form. No silent shortcut.
- Back-nav from the credential step returns to whichever sub-state the user was on (chooser or form). The reconcile-on-credential-submit added in D-1.5 still fires (this task does not regress D-1.5 § Item 6).
- The "Create new" CTA renders distinctly from the existing-workspace cards (e.g., dashed border + plus icon).
- Visual change is consistent with the existing setup-screen typography (theme tokens, no new design language).

**Rationale.** Per D-1.5 LEARNINGS 2026-05-22 § "Surprising": _"`existing[0]` shortcut hides the 'create from scratch' path when a workspace already exists… intentional for the D-1 happy path (one workspace per account) but it makes the new-create-from-scratch path unconditionally unreachable from the UI once any workspace exists."_ In D-2, an account can have N workspaces; the shortcut is wrong. This task introduces the chooser as the canonical N>0 affordance.

---

### Task 10 — Refresh `useCloudWorkspaces` cache after archive / unarchive

**Size:** S.

**Cross-stream dependency.** Sequential after Tasks 4 and 5 (both mutations invalidate the same key).

**Files touched.**

- `packages/app/src/hooks/use-archive-cloud-workspace.ts` and `packages/app/src/hooks/use-unarchive-workspace.ts` — both must `queryClient.invalidateQueries({ queryKey: CLOUD_WORKSPACES_QUERY_KEY })` in `onSuccess`. (Already specified inside Tasks 4 and 5; this task is a sanity check + shared test.)
- `packages/app/src/hooks/use-cloud-workspaces.ts` — keep `staleTime: 15_000` and `retry: false`. Document the cache lifecycle in a 2-line comment so the next dev does not invent a third invalidation site.

**Acceptance.**

- After archive: picker reflects the move from active → archived inside 1 frame of the mutation success.
- After unarchive: picker reflects the reverse move.
- Two archive mutations fired in parallel (e.g., user-driven bulk archive — not Day-1 but defensive) coalesce into one invalidate; no double-fetch storm.

**Rationale.** Single cache-invalidation key for the workspace list keeps the picker, setup wizard, and any future surface in sync without per-component refetch wiring. Mirror's D-1.5's setup-screen invalidate pattern.

---

### Task 11 — Documentation: app-side surfaces of the workspace lifecycle

**Size:** S.

**Cross-stream dependency.** Lands after tasks 1-10 (so the doc reflects what shipped).

**Files touched.**

- `docs/agent-lifecycle.md` — extend to call out the cloud-workspace lifecycle states (`active|suspended|billing_locked|archived`) and the user-visible affordances per state. Three sentences max; the spec source-of-truth is `paseo-cloud-daemon/90-cloud-considerations/workspace-lifecycle.md` (link to it; do not duplicate).
- `CLAUDE.md` § "Critical rules" — add one bullet referencing the locked archive copy: _"The 30-day GC message and the Resuming-workspace splash copy are user-visible promises. Treat the strings as binding; centralize per-file constants."_

**Acceptance.**

- `docs/agent-lifecycle.md` shows the four states and one-line UX for each.
- A grep for `"Archived workspaces will be permanently removed after 30 days"` returns exactly 1 source-of-truth constant.

---

## Cross-stream dependencies (summary table)

| App task                    | Depends on (sibling stream)                                | Specifically                                                                                    |
| --------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1 (session-expired handler) | —                                                          | None                                                                                            |
| 2 (state surface)           | PLAN-auth-and-shared                                       | `state` + `archivedAt` on `WorkspaceRecord` list response                                       |
| 3 (picker sections)         | Task 2 + PLAN-auth-and-shared (list returns archived rows) | Existing `GET /workspaces` already returns all, but verify it does not filter                   |
| 4 (unarchive)               | PLAN-auth-and-shared                                       | `POST /api/v1/cloud/workspaces/:id/unarchive` route                                             |
| 5 (archive)                 | PLAN-auth-and-shared                                       | `POST /api/v1/cloud/workspaces/:id/archive` route + EventBridge T-24h/T-0 schedule registration |
| 6 (cold-resume splash)      | PLAN-lifecycle-worker, soft PLAN-daemon                    | Suspend-detection mechanism (any of the three candidates is fine — client doesn't care)         |
| 7 (worktree GC)             | PLAN-lifecycle-worker, PLAN-daemon                         | StopTask + EBS cleanup happens server-side; the client GC mirrors that locally                  |
| 8 (billing_locked)          | PLAN-auth-and-shared                                       | `state="billing_locked"` value plumbed; D-4 lights up `/settings/billing`                       |
| 9 (chooser)                 | —                                                          | None (pure client)                                                                              |
| 10 (cache refresh)          | —                                                          | Pure client                                                                                     |
| 11 (docs)                   | All others                                                 | Last in the sequence                                                                            |

The two routes the app needs from PLAN-auth-and-shared:

```
POST /api/v1/cloud/workspaces/:id/archive   { } → 200 WorkspaceRecord (state:"archived", archivedAt:<ISO>)
POST /api/v1/cloud/workspaces/:id/unarchive { } → 200 WorkspaceRecord (state:"active",   archivedAt:null)
```

Both are session-auth (Bearer session JWT) per the existing auth-service pattern. Both throw 401 → `OrchestraSessionExpiredError` per `authedFetch`.

---

## Open questions / assumptions

These are flagged for the operator to confirm before implementation begins. Each is either an explicit assumption baked into the plan or a question whose answer affects the implementation.

1. **Is the cloud-archive verb a NEW route (`POST /workspaces/:id/archive`) or is it the existing on-host `archive_workspace_request` plumbed through a daemon → auth webhook?** This plan assumes new HTTP route — cleaner separation of concerns, no webhook seam, no AGPL-core wire-shape changes. The spec (`workspace-lifecycle.md` line 18) says: _"user → `archive_workspace_request` (existing AGPL RPC)."_ The two interpretations:
   - **(picked)** The "existing AGPL RPC" remains for the on-host concept; the cloud archive is a new HTTP route. The client surfaces two separate code paths (on-host hide via WS RPC, cloud archive via HTTP). This is what Task 5 plans against.
   - **Alternative:** The client only ever calls `archive_workspace_request`; the daemon emits a webhook to the auth service which mirrors to DDB + schedules GC. Simpler client code (one verb), more wire surface (webhook subscriber). If the operator picks this, Task 5 collapses to "use the existing `archiveWorkspaceOptimistically` call" and PLAN-daemon owns the webhook emission.
   - **Recommendation:** stick with the new HTTP route. The on-host RPC's "soft-delete from listings" semantic is mechanically different from the cloud's "DDB flip + EventBridge T-24h/T-0 schedule + StopTask"; collapsing them under one wire surface hides that asymmetry. Filed as an explicit decision for the operator.

2. **Where do we put the "Archived" section in the picker — same modal or a separate tab?** The plan picks "two sections in the same modal, separated by an explicit header" rather than a separate tab control. Pros: one modal, less navigation; matches the existing "Cloud workspaces" + directory-suggestions pattern. Cons: when an account has many archived workspaces, scroll becomes long. If the operator wants a tab control, Task 3 expands by ~2h.

3. **Should archived workspaces in the chooser of Task 9 be hidden, shown-but-greyed, or shown-with-unarchive-button?** The plan hides them entirely from the wizard. The wizard's purpose is to set credentials on an active workspace; archived isn't a valid pick target. The picker is the surface for unarchive. If the operator disagrees, Task 9 expands.

4. **The `?reason=session-expired` query param on `/welcome` — does it survive Expo Router's `router.replace` cleanly, or do we need the transient store?** Filed as a "pick whichever is cleaner during implementation" note in Task 1. If the query param fights expo-router on native (the Linking module has had odd behavior with replace + query in the past), the store path is a 20-line drop-in.

5. **Suspend-detection mechanism is undecided per `workspace-lifecycle.md` § "Open questions".** Task 6 ships the client UX without depending on the mechanism — the client only reads `state` from DDB and `connectionStatus` from the local runtime. **Assumption:** the lifecycle worker writes `state:"active"` _before_ the daemon container is fully warm, OR the WS upgrade succeeds _before_ the state flip — either order ends the splash. If both end up taking >5 s consistently, we may want to expose a tiny on-route "Still resuming…" subtitle, but that's a Day-2 polish.

6. **Does the cloud-archive HTTP call also stop the daemon container synchronously, or is StopTask async via the lifecycle worker?** Plan assumes async — `POST /archive` returns 200 immediately on DDB success, and the lifecycle worker StopTasks the container in the background. The client treats archive as "fire and move on" without awaiting StopTask completion. PLAN-lifecycle-worker should confirm.

7. **What happens to in-flight agent turns when a workspace is archived?** Plan does not address this — the assumption is the user wouldn't archive a workspace mid-turn. The lifecycle worker StopTasks the container; in-flight turns are dropped. If the operator wants a "you have an active agent — really archive?" preflight, that's a Day-2 polish on Task 5.

8. **Does the chooser in Task 9 also display the workspace's `state`?** Plan: yes — show "Suspended" / "Billing inactive" as a subtitle on chooser cards so the user sees the same context as the picker. Archived ones are filtered out per Q3.

---

## Verification

The operator confirms the slice by walking the following sequences against the deployed `orchestra-dev` stack. Each sequence is short and reproduces a discrete contract from § "D-2 closure criteria."

### V1 — Archive lifecycle (the centerpiece)

1. Sign in fresh. Create two cloud workspaces (A, B). Set credentials on A. Open A. Confirm agent prompt streams (D-1.5 regression check).
2. Return to picker. Kebab on A → "Archive workspace…" → modal renders with exact title/message. Confirm.
3. A vanishes from the "Cloud workspaces" section, appears in the "Archived" section. Footer reads exactly _"Archived workspaces will be permanently removed after 30 days."_
4. Click `[Unarchive]` on A in the Archived section. Row moves back to active; no workspace is opened. Picker stays open.
5. Re-archive A. This time click the row body (not the unarchive button). Workspace opens; banner inside the workspace shell: _"Unarchived — this workspace is active again."_ Banner dismisses after ~5 s.
6. From the sidebar, confirm no phantom worktree row exists for A. Reload the page. Confirm the sidebar still has exactly one worktree row for A.

### V2 — Auto-suspend cold-resume (the only user-visible artifact of D-2's lifecycle machinery)

1. Open workspace A. Confirm online; do anything (`ls` prompt). Leave it idle for >15 min (or trigger suspend manually via the lifecycle-worker debug knob if one exists — PLAN-lifecycle-worker should expose one for ops).
2. Re-open the workspace (click it in the sidebar or in the picker). Expect: "Resuming workspace…" splash for ~3-5 s. Splash text exact; spinner only; no error UI.
3. Splash dismisses; workspace timeline loads. Agent records intact (the EBS snapshot is the source-of-truth — confirmed indirectly).

### V3 — Billing-locked skeleton (wired, not connected)

1. DDB-poke a workspace to `state:"billing_locked"`. Refresh picker.
2. Workspace row visible in active section with "Plan inactive" badge.
3. Click row. Workspace shell renders "Reactivate your plan to resume this workspace." with "Manage plan" button → routes to `/settings/billing` (which 404s gracefully at Day-1).
4. DDB-poke back to `state:"active"`. Refresh picker. Workspace opens normally.

### V4 — Session expiry single seam

1. Sign in. Open picker; cloud workspaces appear.
2. DevTools → set `orchestra:session_token` in localStorage to a malformed value (or wait 1h for natural expiry).
3. Trigger ANY of: open picker → list call; create workspace → POST call; archive → POST call. Each path should bounce to `/welcome` with the inline banner _"Your session expired. Sign in again to continue."_
4. Sign back in. Confirm previous workspaces appear; nothing was destructively cleared other than the session token.

### V5 — "Create new" chooser

1. Account with zero workspaces: setup wizard → workspace step → form renders directly. (D-1 happy path, unchanged.)
2. Create one workspace. Sign out + back in. Setup wizard → workspace step → chooser renders with one card + "Create new" CTA.
3. Tap the existing card → credential step (D-1.5 happy path, unchanged).
4. Back-nav → chooser → tap "Create new" → form renders → submit a fresh workspace → credential step on the _new_ workspace.

### V6 — Worktree GC, the D-1.5 footgun

1. Two cloud workspaces (A, B). Open A and B at different times; confirm sidebar shows worktrees for both.
2. Archive A.
3. Sidebar should now show worktrees for B only — no phantom A row.
4. Unarchive A. Open A. Sidebar shows exactly one worktree row for A and one for B.
5. Re-archive A. Sidebar: B only again.

### V7 — Cross-tenant (D-2 hands-on gate, operator-owned)

Out of scope for this client-side plan but mentioned for completeness: the operator runs the cross-tenant probe scripts from `IMPLEMENTATION-ROADMAP.md:164-174` against the deployed stack. The client UI is observably the same in both tenants — V1–V6 should be reproducible side-by-side with no leakage.

### What we cannot verify in this slice

- **The 30-day GC actually firing.** No way to run a real 30-day timer. Verification stand-in: PLAN-lifecycle-worker should expose a debug knob that lets the operator fire the EventBridge schedule manually for a specific workspace; running that knob and confirming the workspace disappears from the Archived section (because the auth service no longer returns the row) is the closest test. The webhook subscriber's idempotency is similarly a lifecycle-worker test concern, not a client one.
- **The pre-purge T-24h webhook fan-out.** Same constraint as above. The client has no surface for the webhook — Day-1 ships a no-op subscriber on the cloud side.

---

## Risks / hard parts

### R1 — Worktree GC + session-store cleanup (Task 7)

**Why it's hard.** D-1.5's two-worktree drift was the canary: a single archive event has effects across (a) DDB row state, (b) per-workspace daemon container, (c) per-workspace EBS volume (D-2 introduces this), (d) the client's local react-query cache, (e) the client's local zustand session-store, and (f) the client's local host-runtime store. Tasks 1–10 mostly handle (a)–(d). Task 7 handles (e). (f) is intentionally untouched (the daemon endpoint stays). When D-2 introduces multiple workspaces per account, the failure mode is no longer "two phantom rows" — it's "every archive-then-recreate cycle adds another phantom," and the user notices quickly.

**Mitigation.** The GC helper is a single function in a single file with deterministic tests. The test seeds the multi-workspace case (two workspaces under one daemon, archive one, assert the other is untouched). If the test passes, the failure mode is closed. Worth one ad-hoc operator verification session before D-2 sign-off where the operator deliberately creates 3-4 workspaces, archives some, unarchives some, and confirms the sidebar reflects ground-truth at each step.

### R2 — The session-expired single seam (Task 1) interacts with every other task

**Why it's hard.** Every HTTP call goes through `authedFetch`. The new global handler debounces concurrent 401s to a single bounce; but if the debounce window is wrong (too short → multiple bounces, too long → user lingers on a dead screen), the failure is "weird routing behavior on session expiry," which is exactly the silent class of bug D-1.5 wanted to kill.

**Mitigation.** The unit test for the context explicitly seeds N concurrent throws and asserts exactly one `router.replace`. The bounce is idempotent (calling `clearSession()` twice is harmless; `router.replace("/welcome?...")` twice from `/welcome` is a no-op). Add operator-visible debug log on the first bounce (`console.warn("[Orchestra] Session expired — bouncing to /welcome", { firstError })`) so future investigations have a fingerprint.

### R3 — Cold-resume splash timing (Task 6)

**Why it's hard.** Three independent events race: (a) lifecycle worker writes `state="active"` to DDB; (b) daemon container's `RunTask` completes; (c) WS upgrade succeeds and `connectionStatus` flips to `"online"`. The splash should end on whichever fires first. The risk is that if the splash gates on `state==="suspended"` from a stale react-query cache, the splash may stick after the WS is already online (the cache hasn't refreshed yet to see the state flip).

**Mitigation.** Task 6 explicitly handles this: the splash exit condition is `state !== "suspended" OR connectionStatus === "online"`. The OR is load-bearing. Test case (d) in Task 6's test plan covers it. Worth a manual cross-check: open a `suspended` workspace, confirm splash, observe in the network tab that the WS upgrade arrives before the next `/workspaces` poll — splash should still dismiss.

### R4 — The chooser in Task 9 conflicts with the D-1.5 reconcile flow

**Why it's hard.** D-1.5's `reconcileCachedWorkspace` runs at the top of `handleSetCredential`. The chooser introduces a new state transition (chooser → credential), and the user could pick a workspace that gets archived out-of-band between the chooser click and the credential submission. The reconcile already covers this — but the test needs to exercise it.

**Mitigation.** Task 9's test plan explicitly extends `orchestra-setup-screen.test.tsx` to cover the chooser-picks-then-archived scenario. The fix is mechanical (the reconcile already handles cache misses); the risk is just not noticing the regression.

### R5 — Archived workspaces in the cloud picker section vs the on-host sidebar's "Hide from sidebar"

**Why it's hard.** The same word — "archive" — means different things in two surfaces: on-host worktree archive (Paseo's existing hide-from-sidebar verb) vs cloud workspace archive (the D-2 30-day GC verb). Users may confuse them; the existing on-host hide-from-sidebar dialog in `sidebar-workspace-list.tsx:1530` says "Hide workspace?", which is fine. But if we ever expose an "Archive worktree" verb on a cloud daemon (the on-host worktree concept inside a cloud container), the naming collision will bite.

**Mitigation.** Per CLAUDE.md § "The protocol stays backward-compatible. Features don't have to.": rename the on-host UI label from "Hide from sidebar" to literally "Hide" or "Remove from sidebar" if the collision becomes confusing post-D-2. Not in scope for D-2; filed.

### R6 — The `state` field on `WorkspaceRecord` adds a discriminator the codebase will lean on

**Why it's hard.** Once `state` is in the type system, code will start branching on it (Tasks 3, 6, 8 already do). The risk is that future code adds another piece of state-derived logic without going through one of the canonical seams (picker / route gate). F11 / single-discriminator design-out applies.

**Mitigation.** Add a single helper `getCloudWorkspaceState(workspace): CloudWorkspaceState` in `packages/app/src/lib/orchestra-cloud-client.ts` that returns the typed enum. Force every consumer to read state through it. Grep target: `rg "workspace\.state ===|workspace\.state !==" packages/app/src/` — if this returns anything except a wrapped helper call, it's an F11 candidate for a small refactor.

---

## Effort summary

- Task 1 (session-expired handler): ~M, ~3 h + ~80 LOC unit-test.
- Task 2 (state surface): ~S, ~1 h.
- Task 3 (picker sections): ~M, ~3 h.
- Task 4 (unarchive button + on-open): ~M, ~3 h.
- Task 5 (archive modal): ~S–M, ~2-3 h.
- Task 6 (cold-resume splash): ~M, ~3 h.
- Task 7 (worktree GC): ~M–L, ~4-6 h (most of it test scaffolding).
- Task 8 (billing_locked skeleton): ~S, ~1 h.
- Task 9 (chooser): ~M, ~3 h.
- Task 10 (cache refresh): ~S, ~0.5 h.
- Task 11 (docs): ~S, ~0.5 h.

Total: ~24-30 hours of single-developer time, parallelizable as: Task 1 in isolation; Tasks 2-10 after Task 1; Task 11 at the end.

---

## Deferred follow-ups

Each surfaced during this planning pass; filed per CLAUDE.md § "if a follow-up surfaces, file it; do not bundle":

- **Per-account archive cap UI.** `workspace-lifecycle.md` § "Open questions" flags per-account archived-workspace caps as TBD. When the cap exists, the Archive button should disable on the (N+1)th archive with a tooltip. Day-1: no cap, no UI.
- **Bulk archive verb in the picker.** Today you archive one workspace at a time via the kebab. With multi-workspace accounts, a "select multiple archived workspaces" + "Archive selected" verb is plausible Day-2.
- **"Restore from archive" admin verb.** Spec mentions admin-side recovery within 30 days. Not user-facing Day-1; not in this slice. When it lands, the Archived section's footer could mention it ("Need to recover an archived workspace? Contact support.").
- **Pre-purge "this will be deleted in 24 hours" banner.** The forward-compat webhook is wired daemon-side at T-24h; the client could surface a banner on the next list refresh if any workspace's `scheduled_purge_at` is within 24h. Filed because the client doesn't currently see `scheduled_purge_at` (it's not in the list response shape). Would need a server-side response shape change to surface; not Day-1.
- **Picker keyboard navigation across both sections (D-1.5 carry-over).** Both the "Cloud workspaces" and "Archived" sections are tap-only. Unify into one keyboard-cursor walk in a single follow-up. D-1.5 deferred this; D-2 keeps deferring.
- **Splash-error fallback if cold-resume genuinely fails.** Task 6 holds the splash indefinitely. If the lifecycle worker is degraded and `RunTask` keeps failing, the user sees a stuck splash with no escape. Day-2: after a 30-60s timer with no progress, surface a retry button + "Something went wrong resuming this workspace" — uses the existing `WorkspaceUnreachable` view.
- **`cloudWorkspaceId` rename across the AGPL side.** D-1.5 filed it pending the proprietary-side `tenantId` decision. D-2 does not unblock the rename; carry forward.

---

**Summary**

- **Task 1 (session-expired handler) lands first** — every other task depends on the 401 path going to one place.
- **Tasks 2-10 fan out** with explicit cross-stream dependencies on PLAN-auth-and-shared (`state`, `archivedAt`, archive/unarchive routes) and PLAN-lifecycle-worker (suspend mechanism, StopTask side-effects).
- **Locked copy is constant-typed** — three strings come straight from `workspace-lifecycle.md` § "UX copy" and live in single source-of-truth constants so a stray refactor cannot silently rephrase them.
- **The worktree GC (Task 7) is the riskiest task** — it is the empirical D-1.5 carry-over and the area where multi-workspace amplifies the failure mode. Deterministic test + ad-hoc operator verification cover it.
- **`billing_locked` is wired-not-connected** — D-4 lights it up with zero client changes.
- **The whole slice is operator-verifiable in ~7 sequences (V1–V7)**, no 30-day timer required for any of them.
