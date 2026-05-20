import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  listWorkspaces,
  OrchestraSessionExpiredError,
  type WorkspaceRecord,
} from "@/lib/orchestra-cloud-client";
import { useIsCloudHost } from "@/runtime/host-runtime";

export const CLOUD_WORKSPACES_QUERY_KEY = ["cloud-workspaces"] as const;

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
    queryFn: async () => {
      try {
        return await listWorkspaces();
      } catch (error) {
        // Expired session is treated the same as "no cloud host" — the picker
        // simply hides the section. Redirect-to-welcome is the auth store's job.
        if (error instanceof OrchestraSessionExpiredError) {
          return [];
        }
        throw error;
      }
    },
    enabled,
    staleTime: 15_000,
    retry: false,
  });
}
