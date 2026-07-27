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
export function resolveSelectedIsGit(input: {
  probeIsGit: boolean | undefined;
  projectCanCreateWorktree: boolean | undefined;
}): boolean {
  return input.probeIsGit === true || input.projectCanCreateWorktree === true;
}
