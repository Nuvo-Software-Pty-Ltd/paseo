import { deriveCanonicalRepoUrl } from "./workspace-registry-model.js";
import type { PersistedProjectRecord } from "./workspace-registry.js";

// Cloud `/workspace/<ws>/...` paths are POSIX-absolute — the daemon only runs on
// Linux (ECS Fargate). Normalize by trimming trailing slashes for a stable
// comparison; deliberately NOT `node:path` / `normalizeWorkspaceId`, whose
// `path.resolve` rewrites a POSIX path to drive-letter/backslash form on Windows
// (CI test runners), which would make every prefix check miss. This code never
// executes off the Linux daemon, so POSIX semantics are the correct semantics.
function normalizePosixPath(p: string): string {
  const trimmed = p.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : "/";
}

// workspace-repair — the cloud daemon's /workspace tree is tmpfs and wiped on
// every recycle, but the project store is durable (DynamoDB). The lazy
// "re-clone on missing path" repair historically restored only the PRIMARY
// clone (`/workspace/<ws>/.git-canonical`, identity via describe-workspace),
// which left SECONDARY projects (added via add_project at
// `/workspace/<ws>/<owner>__<repo>`) un-rehydratable: their tmpfs clone was
// gone but their durable project row still pointed at the vanished dir, so
// open / create-worktree failed "Directory not found".
//
// This pure selector closes that gap: given a missing path, it finds the
// durable git project whose rootPath IS that path and returns what to re-clone
// (canonical repoUrl + the direct-child subdir). It deliberately returns null —
// deferring to the primary repair — for the container root, a nested worktree
// path, or any path with no matching active git project row.

export interface ProjectRepairClone {
  repoUrl: string;
  // Direct child of `/workspace/<ws>/` to clone into (e.g. `<owner>__<repo>` or
  // `.git-canonical`). Passed verbatim as `cloneWorkspaceRepo`'s destSubdir.
  destSubdir: string;
  // The resolved absolute clone directory (`/workspace/<ws>/<destSubdir>`).
  clonePath: string;
}

export function selectProjectRepairClone(input: {
  cwd: string;
  workspaceId: string;
  projects: PersistedProjectRecord[];
}): ProjectRepairClone | null {
  const normalizedCwd = normalizePosixPath(input.cwd);
  const base = `/workspace/${input.workspaceId}/`;
  if (!normalizedCwd.startsWith(base)) {
    return null;
  }
  const destSubdir = normalizedCwd.slice(base.length);
  // Only a direct child subdir is a clone root; a nested path (a paseo worktree
  // below the clone) is restored with its parent clone, not independently here.
  if (destSubdir.length === 0 || destSubdir.includes("/")) {
    return null;
  }
  const project = input.projects.find(
    (candidate) =>
      !candidate.archivedAt &&
      candidate.kind === "git" &&
      Boolean(candidate.repoUrl) &&
      normalizePosixPath(candidate.rootPath) === normalizedCwd,
  );
  if (!project?.repoUrl) {
    return null;
  }
  return {
    repoUrl: deriveCanonicalRepoUrl(project.repoUrl) ?? project.repoUrl,
    destSubdir,
    clonePath: `/workspace/${input.workspaceId}/${destSubdir}`,
  };
}
