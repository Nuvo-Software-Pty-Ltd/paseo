import type { WorkspaceRecord } from "@/lib/orchestra-cloud-client";

export interface CloudWorkspaceSections {
  activeCloudWorkspaces: WorkspaceRecord[];
  archivedCloudWorkspaces: WorkspaceRecord[];
}

// Picker partition: only the `archived` state goes into the Archived section.
// `suspended` and `billing_locked` stay in the active list per workspace-
// lifecycle.md (the user can still see them — `billing_locked` even renders a
// "Plan inactive" badge — but only `archived` is the post-GC tombstone).
export function partitionCloudWorkspaces(
  workspaces: ReadonlyArray<WorkspaceRecord>,
): CloudWorkspaceSections {
  const active: WorkspaceRecord[] = [];
  const archived: WorkspaceRecord[] = [];
  for (const workspace of workspaces) {
    if (workspace.state === "archived") {
      archived.push(workspace);
    } else {
      active.push(workspace);
    }
  }
  return { activeCloudWorkspaces: active, archivedCloudWorkspaces: archived };
}
