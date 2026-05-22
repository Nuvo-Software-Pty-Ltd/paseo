export interface PurgeLocalStateInput {
  serverId: string;
  cloudWorkspaceId: string;
}

// Placeholder — Task 7 fills this in. Defined now so the archive mutation
// hook can call it from onSuccess without a separate refactor when Task 7
// lands. Calling this is a no-op until Task 7; the cloud archive still
// completes (DDB flip + cache invalidate), the local session store just
// doesn't get cleaned. That matches the D-1.5 behavior; Task 7 fixes it.
export function purgeLocalStateForArchivedWorkspace(_input: PurgeLocalStateInput): void {
  // intentionally empty; Task 7 wires the session-store cleanup.
}
