import { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";

export interface PurgeLocalStateInput {
  serverId: string;
  cloudWorkspaceId: string;
}

// Returns the canonical mount-path prefix the daemon container exposes for a
// given cloud workspace. Anything under this prefix belongs to that workspace
// and is fair game for cleanup when the workspace is archived.
export function cloudWorkspaceMountPrefix(cloudWorkspaceId: string): string {
  return `/workspace/${cloudWorkspaceId}/`;
}

// Pure helper: identifies the workspaces in a sessions Map whose paths belong
// to the archived cloud workspace. Exported for the test seam.
export function selectWorkspaceKeysForCloudWorkspace(
  workspaces: ReadonlyMap<string, WorkspaceDescriptor>,
  cloudWorkspaceId: string,
): string[] {
  const prefix = cloudWorkspaceMountPrefix(cloudWorkspaceId);
  const keys: string[] = [];
  for (const [key, descriptor] of workspaces) {
    if (descriptorBelongsToCloudWorkspace(descriptor, prefix)) {
      keys.push(key);
    }
  }
  return keys;
}

function descriptorBelongsToCloudWorkspace(
  descriptor: WorkspaceDescriptor,
  prefix: string,
): boolean {
  return (
    descriptor.workspaceDirectory === prefix.slice(0, -1) ||
    descriptor.workspaceDirectory.startsWith(prefix) ||
    descriptor.projectRootPath === prefix.slice(0, -1) ||
    descriptor.projectRootPath.startsWith(prefix)
  );
}

// Same idea for agents: an agent's cwd lives under the workspace's mount
// path. Exported for tests.
export function selectAgentIdsForCloudWorkspace(
  agents: ReadonlyMap<string, Agent>,
  cloudWorkspaceId: string,
): string[] {
  const prefix = cloudWorkspaceMountPrefix(cloudWorkspaceId);
  const agentIds: string[] = [];
  for (const [agentId, agent] of agents) {
    if (typeof agent.cwd === "string" && agent.cwd.startsWith(prefix)) {
      agentIds.push(agentId);
    }
  }
  return agentIds;
}

// Public seam called from useArchiveCloudWorkspace.onSuccess. Walks the
// session-store for the given serverId, removes any workspace descriptor whose
// path belongs to the archived cloudWorkspaceId, and clears agent records
// whose cwd is rooted there. Leaves the host-runtime connection alone — the
// daemon endpoint is shared across workspaces; the workspace identity is the
// thing that's gone.
//
// Idempotent: a second call after the first leaves the store untouched.
//
// See LEARNINGS.md 2026-05-22 § "Surprising" for the D-1.5 two-worktree drift
// this seam exists to close.
export function purgeLocalStateForArchivedWorkspace(input: PurgeLocalStateInput): void {
  const { serverId, cloudWorkspaceId } = input;
  if (!serverId || !cloudWorkspaceId) {
    return;
  }
  const store = useSessionStore.getState();
  const session = store.sessions[serverId];
  if (!session) {
    return;
  }

  for (const key of selectWorkspaceKeysForCloudWorkspace(session.workspaces, cloudWorkspaceId)) {
    store.removeWorkspace(serverId, key);
  }

  const agentIds = selectAgentIdsForCloudWorkspace(session.agents, cloudWorkspaceId);
  if (agentIds.length === 0) {
    return;
  }
  store.setAgents(serverId, (prev) => {
    let next: Map<string, Agent> | null = null;
    for (const agentId of agentIds) {
      if (!prev.has(agentId)) {
        continue;
      }
      next ??= new Map(prev);
      next.delete(agentId);
    }
    return next ?? prev;
  });
}
