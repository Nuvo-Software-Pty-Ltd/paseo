import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useToast } from "@/contexts/toast-context";
import {
  unarchiveCloudWorkspace,
  OrchestraSessionExpiredError,
  type WorkspaceRecord,
} from "@/lib/orchestra-cloud-client";
import { invalidateCloudWorkspacesCache } from "@/hooks/cloud-workspaces-cache";

// Single writer per side effect (F9): the only place that calls
// unarchiveCloudWorkspace lives here. Both the explicit [Unarchive] button
// AND the unarchive-on-open path on archived rows fire mutateAsync against
// this mutation so the cache invalidate + error toast are consistent.
export function useUnarchiveWorkspace(): UseMutationResult<
  WorkspaceRecord,
  Error,
  { workspaceId: string }
> {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation<WorkspaceRecord, Error, { workspaceId: string }>({
    mutationFn: ({ workspaceId }) => unarchiveCloudWorkspace(workspaceId),
    onSuccess: () => {
      invalidateCloudWorkspacesCache(queryClient);
    },
    onError: (error) => {
      // Session-expired bounces via OrchestraSessionProvider; don't toast on
      // top of the global handler's redirect.
      if (error instanceof OrchestraSessionExpiredError) {
        return;
      }
      toast.error(`Failed to unarchive — ${error.message}`);
    },
  });
}
