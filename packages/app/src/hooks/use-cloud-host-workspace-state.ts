import { useMemo } from "react";
import { useCloudWorkspaces } from "@/hooks/use-cloud-workspaces";
import type { CloudWorkspaceState } from "@/lib/orchestra-cloud-client";
import { useHosts, useIsCloudHost } from "@/runtime/host-runtime";

// Returns the CloudWorkspaceState of the workspace the given cloud host's
// preferred connection points at, or null when:
//   * no host with serverId,
//   * host is not cloud (on-host worktrees don't have this concept),
//   * the list query hasn't resolved yet.
//
// The route gate uses this to decide between cold-resume splash, billing-
// locked prompt, and the regular loading/ready flow.
export function useCloudHostWorkspaceState(
  serverId: string | null | undefined,
): CloudWorkspaceState | null {
  const isCloudHost = useIsCloudHost(serverId);
  const hosts = useHosts();
  const cloudWorkspaceId = useMemo(() => {
    if (!isCloudHost || !serverId) {
      return null;
    }
    const host = hosts.find((entry) => entry.serverId === serverId);
    if (!host) {
      return null;
    }
    const preferred = host.connections.find(
      (connection) => connection.id === host.preferredConnectionId,
    );
    if (preferred?.type !== "directTcp" || typeof preferred.workspaceId !== "string") {
      return null;
    }
    return preferred.workspaceId;
  }, [hosts, isCloudHost, serverId]);

  const cloudWorkspacesQuery = useCloudWorkspaces(serverId, { enabled: isCloudHost });
  return useMemo(() => {
    if (!cloudWorkspaceId) {
      return null;
    }
    const data = cloudWorkspacesQuery.data;
    if (!data) {
      return null;
    }
    const match = data.find((row) => row.workspaceId === cloudWorkspaceId);
    return match?.state ?? null;
  }, [cloudWorkspaceId, cloudWorkspacesQuery.data]);
}
