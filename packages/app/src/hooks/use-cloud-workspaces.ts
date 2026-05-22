import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { CLOUD_WORKSPACES_QUERY_KEY_INNER } from "@/hooks/cloud-workspaces-cache";
import { listWorkspaces, type WorkspaceRecord } from "@/lib/orchestra-cloud-client";
import { useIsCloudHost } from "@/runtime/host-runtime";

export const CLOUD_WORKSPACES_QUERY_KEY = CLOUD_WORKSPACES_QUERY_KEY_INNER;

// Cache lifecycle: list cached for 15s; invalidate via CLOUD_WORKSPACES_QUERY_KEY
// from any mutation (archive / unarchive / create). OrchestraSessionExpiredError
// propagates — the global OrchestraSessionProvider handles the bounce.

interface UseCloudWorkspacesOptions {
  enabled?: boolean;
}

export function useCloudWorkspaces(
  serverId: string | null | undefined,
  options: UseCloudWorkspacesOptions = {},
): UseQueryResult<WorkspaceRecord[], Error> {
  const isCloudHost = useIsCloudHost(serverId);
  const enabled = (options.enabled ?? true) && isCloudHost;

  return useQuery<WorkspaceRecord[], Error>({
    queryKey: CLOUD_WORKSPACES_QUERY_KEY,
    queryFn: () => listWorkspaces(),
    enabled,
    staleTime: 15_000,
    retry: false,
  });
}
