import type { QueryClient } from "@tanstack/react-query";

// Single key for the cloud workspace list — re-exported from
// use-cloud-workspaces.ts as CLOUD_WORKSPACES_QUERY_KEY for backward
// compatibility. Owned here so the cache helper does not pull the rest of
// use-cloud-workspaces (which imports expo modules) into pure tests.
export const CLOUD_WORKSPACES_QUERY_KEY_INNER = ["cloud-workspaces"] as const;

// Single invalidation seam (F9 / Task 10 sanity check): every mutation that
// changes the cloud-workspace list MUST go through this helper so the picker,
// setup-wizard chooser, and any future surface stay in sync with one cache
// key. Don't invent a second invalidation site — see use-cloud-workspaces.ts.
export function invalidateCloudWorkspacesCache(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: CLOUD_WORKSPACES_QUERY_KEY_INNER });
}
