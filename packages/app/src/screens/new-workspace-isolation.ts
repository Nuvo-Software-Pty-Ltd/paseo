// Does the selected project support worktree isolation?
//
// The live `checkout_status` probe answers `isGit: false` for any directory it
// cannot stat — which in cloud is the normal state of every clone until the
// tmpfs copy is rehydrated after a recycle. Taking that at face value hid the
// isolation control entirely and silently downgraded a Worktree request to
// Local, i.e. into the one create path that used to fail "Directory not found".
//
// So fall back to the durable project kind (`canCreateWorktree`, derived from
// the persisted projectKind), which survives a recycle; the server repairs the
// clone before branching off it.
//
// Takes the nullable records rather than pre-narrowed booleans so the call site
// stays free of optional chaining — `NewWorkspaceScreen` sits right on the
// oxlint complexity ceiling.
export function resolveSelectedIsGit(input: {
  checkoutStatus: { isGit: boolean } | null | undefined;
  selectedProject: { canCreateWorktree: boolean } | null | undefined;
}): boolean {
  if (input.checkoutStatus?.isGit === true) return true;
  return input.selectedProject?.canCreateWorktree === true;
}
