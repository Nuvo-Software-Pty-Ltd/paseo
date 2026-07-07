import { existsSync } from "node:fs";
import type { Logger } from "pino";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  deriveCanonicalRepoUrl,
  deriveRepoUrlFromRemoteProjectKey,
} from "./workspace-registry-model.js";
import type { PersistedProjectRecord, ProjectRegistry } from "./workspace-registry.js";
import { isPaseoCloudMode } from "./paseo-env.js";
import { cloneWorkspaceRepo, fetchWorkspaceRepoUrl } from "./cloud-clone.js";

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
      normalizePosixPath(candidate.rootPath) === normalizedCwd,
  );
  if (!project) {
    return null;
  }
  // Prefer the persisted repoUrl; fall back to reconstructing it from the
  // immutable `remote:` project key. A fire can rewrite the durable record and
  // null the persisted repoUrl, but the project key (sort key) survives — so the
  // repair stays functional across that clobber. Null when neither yields a URL
  // (a path-keyed git project with no repoUrl) → defer to the primary repair.
  const repoUrl =
    (project.repoUrl ? (deriveCanonicalRepoUrl(project.repoUrl) ?? project.repoUrl) : null) ??
    deriveRepoUrlFromRemoteProjectKey(project.projectId);
  if (!repoUrl) {
    return null;
  }
  return {
    repoUrl,
    destSubdir,
    clonePath: `/workspace/${input.workspaceId}/${destSubdir}`,
  };
}

// COMPAT(workspaceRepairOnMissing): the cloud container-local /workspace/<id>
// tree is tmpfs and wiped on every ECS roll, while the project store is durable
// (DynamoDB). This repair re-clones a missing path from the user's GitHub repo
// via the cloud auth-service's describe-workspace lookup. Extracted verbatim
// from Session.ensureCloudWorkspacePathExists so BOTH the interactive open /
// create-worktree handlers AND the scheduled/webhook automation spawn path can
// self-heal a missing source repo before branching a worktree off it. Delete
// once /workspace is durable storage.
//
// Idempotent — a no-op off-cloud, on a non-/workspace path, when the path
// already exists, or when nothing durable maps to it (empty workspace / no repo
// identity). The `git clone` runs ONLY when the path is genuinely missing, so it
// never clobbers an existing tree. `onProgress` is the optional UI-progress sink
// (the interactive callers wire it to a workspace_setup_progress emit; the
// automation path omits it — there is no interactive client to notify).
export async function ensureCloudWorkspaceRepoCloned(input: {
  cwd: string;
  projectRegistry: Pick<ProjectRegistry, "list">;
  logger: Logger;
  onProgress?: (event: {
    workspaceId: string;
    phase: "running" | "completed" | "failed";
    clonePath: string;
    error?: string;
  }) => void;
}): Promise<void> {
  const { cwd, projectRegistry, logger, onProgress } = input;
  if (!isPaseoCloudMode()) {
    return;
  }
  const match = /^\/workspace\/(ws_[A-Za-z0-9_-]+)(\/|$)/.exec(cwd);
  if (!match) {
    return;
  }
  if (existsSync(cwd)) {
    return;
  }
  const workspaceId = match[1]!;
  const authServiceBaseUrl = process.env.ORCHESTRA_AUTH_INTERNAL_URL;
  const hmacKey = process.env.ORCHESTRA_INTERNAL_HMAC_KEY;
  if (!authServiceBaseUrl || !hmacKey) {
    throw new Error(
      "Cloud workspace repair requires ORCHESTRA_AUTH_INTERNAL_URL and " +
        "ORCHESTRA_INTERNAL_HMAC_KEY to be set",
    );
  }

  // Resolve WHAT to re-clone for the missing path. Prefer the durable project
  // record whose rootPath IS this cwd — this rehydrates ANY project: the primary
  // `.git-canonical` clone OR a secondary `<owner>__<repo>` subdir added via
  // add_project. Falls back to the legacy primary repair (describe-workspace →
  // `.git-canonical`) when the cwd is the container root or carries no matching
  // durable project row.
  const target = await resolveCloudRepairTarget({
    cwd,
    workspaceId,
    authServiceBaseUrl,
    hmacKey,
    projectRegistry,
    logger,
  });
  // An empty workspace (created with no repo), or a path with no recoverable repo
  // identity, has nothing to clone. Clean no-op.
  if (!target) {
    return;
  }

  onProgress?.({ workspaceId, phase: "running", clonePath: target.clonePath });
  try {
    await cloneWorkspaceRepo({
      accountId: target.accountId,
      workspaceId,
      repoUrl: target.repoUrl,
      smClient: new SecretsManagerClient({}),
      logger,
      destSubdir: target.destSubdir,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onProgress?.({ workspaceId, phase: "failed", clonePath: target.clonePath, error: message });
    throw error instanceof Error ? error : new Error(message);
  }
  onProgress?.({ workspaceId, phase: "completed", clonePath: target.clonePath });
}

// Pick the repo + clone destination to restore a missing /workspace path. A
// secondary project (added via add_project) lives at
// `/workspace/<ws>/<owner>__<repo>`; its identity (repoUrl) survives in the
// durable project store but its clone does not, and the legacy primary-only
// repair (describe-workspace → `.git-canonical`) cannot restore it. Prefer the
// durable git project whose rootPath IS this cwd and re-clone it into that exact
// subdir; otherwise fall back to the primary repair. Null when nothing to clone.
async function resolveCloudRepairTarget(input: {
  cwd: string;
  workspaceId: string;
  authServiceBaseUrl: string;
  hmacKey: string;
  projectRegistry: Pick<ProjectRegistry, "list">;
  logger: Logger;
}): Promise<{
  accountId: string;
  repoUrl: string;
  destSubdir: string | undefined;
  clonePath: string;
} | null> {
  const { cwd, workspaceId, authServiceBaseUrl, hmacKey, projectRegistry, logger } = input;

  // Prefer the durable git project whose rootPath IS this cwd — rehydrates a
  // primary OR secondary `<owner>__<repo>` clone (see selectProjectRepairClone).
  const projectClone = selectProjectRepairClone({
    cwd,
    workspaceId,
    projects: await projectRegistry.list(),
  });
  if (projectClone) {
    // The GitHub account id is workspace-level (shared across all the workspace's
    // repos), so describe-workspace works even for a secondary repo.
    const { accountId } = await fetchWorkspaceRepoUrl({
      authServiceBaseUrl,
      hmacKey,
      workspaceId,
      logger,
    });
    return {
      accountId,
      repoUrl: projectClone.repoUrl,
      destSubdir: projectClone.destSubdir,
      clonePath: projectClone.clonePath,
    };
  }

  // Legacy primary repair — the migrated first project's identity comes from the
  // auth-service describe-workspace lookup and clones to `.git-canonical`.
  const { accountId, repoUrl } = await fetchWorkspaceRepoUrl({
    authServiceBaseUrl,
    hmacKey,
    workspaceId,
    logger,
  });
  if (!repoUrl) {
    return null;
  }
  return {
    accountId,
    repoUrl,
    destSubdir: undefined,
    clonePath: `/workspace/${workspaceId}/.git-canonical`,
  };
}
