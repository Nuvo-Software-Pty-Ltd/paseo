# D-1.5 client-ux — Deferred follow-ups

These surfaced while implementing items 3 and 6 of PLAN-client.md. Per the
roadmap's "if a follow-up surfaces, file it; do not bundle" rule, they are
**not** included in the D-1.5 commits on this branch.

## From item 3 (project-picker surfacing cloud workspaces)

- **Unify keyboard navigation across recommended/directory/cloud sections in
  the project picker.** Today the directory/recommended list is the only
  keyboard-navigable surface (`activeIndex` walks `options`). The new
  "Cloud workspaces" section is tap/click-only. Merging the two lists into
  one keyboard cursor was bigger than the picker-section work and is filed
  for a later pass.
- **"Couldn't load cloud workspaces — retry" affordance in the picker.**
  `useCloudWorkspaces` hides the section on any non-`OrchestraSessionExpiredError`
  error today. A small retry UI would be friendlier; deferred to keep the
  D-1.5 surface minimal.
- **Post-setup auto-open of the just-created workspace.** After the setup
  flow redirects to `/h/<serverId>` the user still has to open the picker
  to land in their workspace. Calling `openProject(...)` before the
  `router.replace` would skip that step entirely; deferred because it
  overlaps with item 3's surface and depends on the daemon-side
  path-repair-on-missing fix (a separate D-1.5 row, owned by the daemon
  agent).
- **`listWorkspaces` shared query key vs. ad-hoc fetches.** The setup
  screen still calls `listWorkspaces()` directly (not through react-query);
  the picker hook does. If a third caller appears, consolidate behind a
  single `useCloudWorkspaces` consumer (with `refetch()` in lieu of the
  explicit `invalidateQueries` in `handleSetCredential`).
- **Centralized auth-session reset on `OrchestraSessionExpiredError`.**
  Item 3's `useCloudWorkspaces` swallows expired-session into `data: []`;
  the setup screen propagates it to the inline error string. There's no
  single seam that says "session expired → bounce to `/welcome`." Out of
  scope for D-1.5; worth a single owner before D-2 multi-tenancy.

## From item 6 (setup-screen state freshness)

- **Live reconcile on step entry via `useEffect`.** The handler-side
  reconcile in this branch catches the action-time race (user clicks
  Continue after a deletion). A `useEffect` keyed on `step === "credential"`
  would also catch the linger-on-screen race (user lingers on credential
  while another tab deletes the workspace). It introduces an async
  flash-of-error and an `isBusy` interaction; deferred until D-2 multi-tab
  scenarios make it concrete.
- **`cloudWorkspaceId` rename on the AGPL side.** `WorkspaceRecord.workspaceId`
  (cloud tenancy id) collides with the on-host worktree `workspaceId`. PLAN-client
  documents the collision; the rename follows D-2's `tenantId`-or-equivalent
  decision on the proprietary side.
