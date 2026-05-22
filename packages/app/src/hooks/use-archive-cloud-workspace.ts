import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useToast } from "@/contexts/toast-context";
import {
  archiveCloudWorkspace,
  OrchestraSessionExpiredError,
  type WorkspaceRecord,
} from "@/lib/orchestra-cloud-client";
import { CLOUD_WORKSPACES_QUERY_KEY } from "@/hooks/use-cloud-workspaces";
import { purgeLocalStateForArchivedWorkspace } from "@/workspace/cloud-workspace-gc";

export interface ArchiveCloudWorkspaceInput {
  serverId: string;
  workspaceId: string;
}

// Single writer per side effect (F9): the only place that calls
// archiveCloudWorkspace lives here. On success it (a) purges local
// session-store state for the now-dead workspace (Task 7 — the D-1.5
// two-worktree drift carry-over), then (b) invalidates the cloud workspaces
// list cache so the picker re-renders.
export function useArchiveCloudWorkspace(): UseMutationResult<
  WorkspaceRecord,
  Error,
  ArchiveCloudWorkspaceInput
> {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation<WorkspaceRecord, Error, ArchiveCloudWorkspaceInput>({
    mutationFn: ({ workspaceId }) => archiveCloudWorkspace(workspaceId),
    onSuccess: (_record, { serverId, workspaceId }) => {
      purgeLocalStateForArchivedWorkspace({
        serverId,
        cloudWorkspaceId: workspaceId,
      });
      void queryClient.invalidateQueries({ queryKey: CLOUD_WORKSPACES_QUERY_KEY });
    },
    onError: (error) => {
      if (error instanceof OrchestraSessionExpiredError) {
        return;
      }
      toast.error(`Failed to archive — ${error.message}`);
    },
  });
}
