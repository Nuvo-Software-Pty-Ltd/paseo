import type { ProjectCheckoutLitePayload } from "@getpaseo/protocol/messages";
import { classifyDirectoryForProjectMembership } from "../workspace-registry-model.js";
import type { PersistedProjectRecord, ProjectRegistry } from "../workspace-registry.js";

// D-3.5c — maps a cwd to its 3.5a Project record the same way the rest of
// the daemon does: classify the directory (git checkout state → project
// grouping → `projectRootPath`), then find the persisted Project whose
// `rootPath` matches. This is the `resolveProjectForCwd` the shared scoped
// env resolver consumes.
//
// Using `classifyDirectoryForProjectMembership` (not a raw cwd-prefix
// match) means a worktree resolves to the SAME project as its main repo
// (they share a `projectKey`), so an agent or terminal in a worktree sees
// the project's scoped vars — "same project → same env" by construction.
//
// The returned record carries `workspaceId` — the 3.5a containment FK the
// workspace scope keys off (VERIFY-3.5c fix #2). We deliberately do NOT
// return `classifyDirectoryForProjectMembership(...).workspaceId`, which is
// the legacy per-cwd path id (PLAN-3.5a-daemon DECISION D-1).

export interface ProjectForCwdDeps {
  projectRegistry: Pick<ProjectRegistry, "list">;
  getCheckout: (cwd: string) => Promise<ProjectCheckoutLitePayload>;
}

export function createProjectForCwdResolver(
  deps: ProjectForCwdDeps,
): (cwd: string) => Promise<PersistedProjectRecord | null> {
  return async function resolveProjectForCwd(cwd: string): Promise<PersistedProjectRecord | null> {
    const checkout = await deps.getCheckout(cwd);
    const membership = classifyDirectoryForProjectMembership({ cwd, checkout });
    const rootPath = membership.projectRootPath;
    const projects = await deps.projectRegistry.list();
    return (
      projects.find((project) => !project.archivedAt && project.rootPath === rootPath) ??
      projects.find((project) => project.rootPath === rootPath) ??
      null
    );
  };
}
