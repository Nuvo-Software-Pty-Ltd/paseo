// D-3.5a (app T-1) — helpers for the refounded workspace → projects[] (1:N)
// model. The store's `WorkspaceDescriptor` carries the canonical `projects[]`
// plus a COMPAT shim of singular `project*` fields (the first project). Read
// multi-project state through these helpers so the eventual removal of the
// singular fields is a single-file change.

import type { ProjectDescriptor, WorkspaceDescriptor } from "@/stores/session-store";
import type { ProjectDescriptorPayload } from "@server/shared/messages";

// Convert a daemon `list_projects` row into the client ProjectDescriptor. The
// daemon guarantees `repoUrl` is credential-free (VERIFY-3.5a finding #1).
export function projectDescriptorFromPayload(payload: ProjectDescriptorPayload): ProjectDescriptor {
  return {
    projectId: payload.projectId,
    workspaceId: payload.workspaceId,
    displayName: payload.displayName,
    rootPath: payload.rootPath,
    repoUrl: payload.repoUrl,
    kind: payload.kind,
    archivedAt: payload.archivedAt,
  };
}

// The canonical projects[] for a workspace, defaulting to [] so callers never
// have to null-check the optional store field.
export function workspaceProjects(workspace: WorkspaceDescriptor): ProjectDescriptor[] {
  return workspace.projects ?? [];
}

// The number of (non-archived) projects in a workspace — drives the empty /
// single / multi-project views (T-4, T-6).
export function workspaceProjectCount(workspace: WorkspaceDescriptor): number {
  return workspaceProjects(workspace).filter((project) => project.archivedAt === null).length;
}

// COMPAT(workspaceSingularProject): the first project, the value the legacy
// singular `projectId`/`projectRootPath` fields derive from. Null for a
// repo-less / empty workspace (the valid 0-project case).
export function primaryProject(workspace: WorkspaceDescriptor): ProjectDescriptor | null {
  return workspaceProjects(workspace)[0] ?? null;
}

// COMPAT singular getters — derive from the first project, falling back to the
// legacy descriptor fields when projects[] has not been hydrated yet.
export function workspacePrimaryProjectId(workspace: WorkspaceDescriptor): string {
  return primaryProject(workspace)?.projectId ?? workspace.projectId;
}

export function workspacePrimaryRootPath(workspace: WorkspaceDescriptor): string {
  return primaryProject(workspace)?.rootPath ?? workspace.projectRootPath;
}

export function workspacePrimaryDisplayName(workspace: WorkspaceDescriptor): string {
  return primaryProject(workspace)?.displayName ?? workspace.projectDisplayName;
}

// The workspace's user-facing container name. Prefers the explicit
// `displayName`, falls back to the legacy `name`.
export function workspaceDisplayName(workspace: WorkspaceDescriptor): string {
  return workspace.displayName ?? workspace.name;
}

// Replace a workspace's projects[] with an authoritative `list_projects`
// result, keeping the COMPAT singular fields in sync with the new first
// project. Returns a new descriptor (does not mutate).
export function withWorkspaceProjects(
  workspace: WorkspaceDescriptor,
  projects: ProjectDescriptor[],
): WorkspaceDescriptor {
  const first = projects[0] ?? null;
  return {
    ...workspace,
    projects,
    ...(first
      ? {
          projectId: first.projectId,
          projectDisplayName: first.displayName,
          projectRootPath: first.rootPath,
          projectKind: first.kind,
        }
      : {}),
  };
}
