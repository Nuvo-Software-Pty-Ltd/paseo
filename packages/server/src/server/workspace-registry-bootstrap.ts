import path from "node:path";

import type { Logger } from "pino";

import type { StoredAgentRecord } from "./agent/agent-storage.js";
import type { AgentStorage, AgentStore } from "./agent/agent-storage.js";
import {
  classifyDirectoryForProjectMembership,
  deriveCanonicalRepoUrl,
  deriveProjectGroupingKey,
  deriveProjectGroupingName,
  generateWorkspaceId,
  normalizeWorkspaceId,
} from "./workspace-registry-model.js";
import { parseGitHubRepoUrl } from "./cloud-clone.js";
import { backfillWorkspaceIdForLegacyAgents } from "./migrations/backfill-workspace-id.migration.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  createWorkspaceContainerRecord,
  DEFAULT_CONTAINER_WORKSPACE_ID,
  type PersistedProjectRecord,
  type ProjectRegistry,
  type WorkspaceContainerRegistry,
  type WorkspaceRegistry,
} from "./workspace-registry.js";
import type { PersistedWorkspaceKind } from "./workspace-registry-model.js";

function minIsoDate(left: string | null, right: string | null): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function maxIsoDate(left: string | null, right: string | null): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function resolveAgentCreatedAt(record: StoredAgentRecord): string {
  return record.createdAt || record.updatedAt || new Date(0).toISOString();
}

function resolveAgentUpdatedAt(record: StoredAgentRecord): string {
  return record.lastActivityAt || record.updatedAt || record.createdAt || new Date(0).toISOString();
}

// D-3.5a — the stable clone dir for the migrated first project of a cloud
// container (kept unchanged so migration triggers no re-clone). Mirrors
// `cloud-clone.ts` destPath.
function cloudCanonicalClonePath(containerWorkspaceId: string): string {
  return `/workspace/${containerWorkspaceId}/.git-canonical`;
}

function isWithinCloudContainer(cwd: string, containerWorkspaceId: string): boolean {
  const base = `/workspace/${containerWorkspaceId}`;
  return cwd === base || cwd.startsWith(`${base}/`);
}

// Map a project's persisted `kind` ("git" / "non_git") to the demoted checkout
// (workspace) `kind`. A reconstructed cloud checkout is always a top-level
// `local_checkout` (the clone root) or a plain `directory` — never a worktree,
// which only exists once a clone is present and `git worktree add` has run.
function workspaceKindForProjectKind(projectKind: "git" | "non_git"): PersistedWorkspaceKind {
  return projectKind === "git" ? "local_checkout" : "directory";
}

// D-3.5a (workspace-retention) — reverse a deterministic cloud clone directory
// back to its canonical GitHub remote, WITHOUT a clone on disk. Cloud clone
// paths are minted by `cloud-clone.ts` and are reversible:
//   • primary repo  → `/workspace/<ws>/.git-canonical`  (identity carried by
//     the `<ws>#metadata.repoUrl` seed, already canonical/credential-free).
//   • additional    → `/workspace/<ws>/<owner>__<repo>` (slug from
//     `deriveProjectCloneSlug`: `<sanitizedOwner>__<sanitizedRepo>`).
//
// Reverse-slug is LOSSY: `deriveProjectCloneSlug` replaces any char outside
// `[A-Za-z0-9._-]` with `-`, so an owner/repo that originally contained such a
// char (or a literal `__`) cannot be recovered exactly. We split on the FIRST
// `__` (GitHub org/user names never contain `_`, so the first `__` is always
// the owner/repo boundary), then validate via `parseGitHubRepoUrl`. On any
// ambiguity we return null so the caller falls back to today's behavior rather
// than minting a wrong identity. Returns a canonical `https://github.com/...`.
function reverseCloudClonePathToRepoUrl(options: {
  cwd: string;
  containerWorkspaceId: string;
  seedRepoUrl: string | null;
}): string | null {
  const base = `/workspace/${options.containerWorkspaceId}`;
  if (options.cwd === cloudCanonicalClonePath(options.containerWorkspaceId)) {
    // Primary clone — identity is the (already canonical) metadata seed.
    return options.seedRepoUrl;
  }
  if (!options.cwd.startsWith(`${base}/`)) {
    return null;
  }
  const remainder = options.cwd.slice(base.length + 1);
  // Only a direct child subdir is a clone root (`<owner>__<repo>`); a nested
  // path (a checkout below the clone, or a paseo worktree) is not reversible
  // here — its identity comes from the durable project store instead.
  if (remainder.includes("/")) {
    return null;
  }
  const separator = remainder.indexOf("__");
  if (separator <= 0 || separator + 2 >= remainder.length) {
    return null;
  }
  const owner = remainder.slice(0, separator);
  const repo = remainder.slice(separator + 2);
  if (!owner || !repo || repo.includes("__")) {
    return null;
  }
  const candidate = `https://github.com/${owner}/${repo}`;
  // Validate the round-trip shape; parseGitHubRepoUrl rejects anything that is
  // not a well-formed github.com `<owner>/<repo>` URL.
  return parseGitHubRepoUrl(candidate) ? candidate : null;
}

// Recover a stable, remote-keyed identity for a degraded cloud checkout. Prefer
// reusing the EXACT durable project (authoritative `projectId`/`repoUrl`) whose
// canonical repoUrl matches the one reversed from the clone path, so cold and
// warm boots converge on a single identity (no path-keyed `non_git` dupes).
function recoverCloudCheckoutIdentity(options: {
  cwd: string;
  seed: MigrationSeedContext;
  durableProjectsByRepoUrl: Map<string, PersistedProjectRecord>;
}): CheckoutProjectIdentity | null {
  const recoveredRepoUrl = reverseCloudClonePathToRepoUrl({
    cwd: options.cwd,
    containerWorkspaceId: options.seed.containerWorkspaceId,
    seedRepoUrl: options.seed.seedRepoUrl,
  });
  if (!recoveredRepoUrl) {
    return null;
  }
  const durable = options.durableProjectsByRepoUrl.get(recoveredRepoUrl);
  if (durable) {
    return {
      projectKey: durable.projectId,
      projectName: durable.displayName,
      projectRootPath: durable.rootPath,
      projectKind: "git",
      repoUrl: durable.repoUrl ?? recoveredRepoUrl,
    };
  }
  const projectKey = deriveProjectGroupingKey({
    cwd: options.cwd,
    remoteUrl: recoveredRepoUrl,
    mainRepoRoot: null,
  });
  return {
    projectKey,
    projectName: deriveProjectGroupingName(projectKey),
    projectRootPath: options.cwd,
    projectKind: "git",
    repoUrl: recoveredRepoUrl,
  };
}

// D-3.5a (DECISION D-2 + finding #3) — ensure the container record exists.
// Idempotent: never overwrites an existing (possibly user-renamed) record.
async function seedContainerIfMissing(options: {
  workspaceContainerRegistry: WorkspaceContainerRegistry;
  containerWorkspaceId: string;
  displayName: string;
  timestamp: string;
}): Promise<void> {
  const existing = await options.workspaceContainerRegistry.get(options.containerWorkspaceId);
  if (existing) {
    return;
  }
  await options.workspaceContainerRegistry.upsert(
    createWorkspaceContainerRecord({
      workspaceId: options.containerWorkspaceId,
      displayName: options.displayName,
      createdAt: options.timestamp,
      updatedAt: options.timestamp,
    }),
  );
}

// D-3.5a (VERIFY-3.5a finding #3) — existing self-host installs short-circuit
// the rebuild (both registry files already exist), so the default-container
// seed + workspaceId backfill never runs for them. Lazily backfill: any
// project that predates the 1:N model (missing `workspaceId`) is attached to
// the default container at read/boot time. Idempotent — a project that
// already carries `workspaceId` is left untouched.
async function backfillMissingProjectContainment(options: {
  projectRegistry: ProjectRegistry;
  containerWorkspaceId: string;
  logger: Logger;
}): Promise<number> {
  const projects = await options.projectRegistry.list();
  let backfilled = 0;
  for (const project of projects) {
    if (project.workspaceId) {
      continue;
    }
    await options.projectRegistry.upsert({
      ...project,
      workspaceId: options.containerWorkspaceId,
      // Never invent a repoUrl during backfill — leave null/undefined as-is.
      updatedAt: project.updatedAt,
    });
    backfilled += 1;
  }
  if (backfilled > 0) {
    options.logger.info(
      { containerWorkspaceId: options.containerWorkspaceId, backfilled },
      "D-3.5a: backfilled missing project containment to default container",
    );
  }
  return backfilled;
}

// Project provenance accumulator, keyed by the project's identity. Holds the
// credential-free repoUrl, root path, kind, and time range so a project that
// spans multiple checkouts merges cleanly.
interface ProjectAccumulator {
  projectKey: string;
  projectName: string;
  projectRootPath: string;
  projectKind: "git" | "non_git";
  repoUrl: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface MigrationSeedContext {
  seedProjectKey: string | null;
  seedRepoUrl: string | null;
  isCloudContainer: boolean;
  containerWorkspaceId: string;
}

interface CheckoutProjectIdentity {
  projectKey: string;
  projectName: string;
  projectRootPath: string;
  projectKind: "git" | "non_git";
  repoUrl: string | null;
}

// Index non-archived durable projects by their canonical repoUrl so a recovered
// clone path can reuse the EXACT existing project identity (id + repoUrl). First
// writer wins on a duplicate repoUrl (the historical dup rows the retention fix
// stops creating); a recovered checkout then re-parents onto that single id.
function indexDurableProjectsByRepoUrl(
  durableProjects: PersistedProjectRecord[],
): Map<string, PersistedProjectRecord> {
  const byRepoUrl = new Map<string, PersistedProjectRecord>();
  for (const project of durableProjects) {
    if (project.archivedAt || !project.repoUrl) {
      continue;
    }
    if (!byRepoUrl.has(project.repoUrl)) {
      byRepoUrl.set(project.repoUrl, project);
    }
  }
  return byRepoUrl;
}

// The flattened shape passed to `createPersistedWorkspaceRecord` for each
// reconstructed checkout. Shared so the durable-project reconstruction can
// append to the same list the agent-derivation loop builds.
interface WorkspaceReconstructionInput {
  workspaceId: string;
  projectKey: string;
  workspaceCwd: string;
  workspaceKind: PersistedWorkspaceKind;
  workspaceDisplayName: string;
  createdAt: string;
  updatedAt: string;
}

// workspace-retention — append a checkout (workspace) record for every durable
// NON-ARCHIVED project that no agent record already anchored, plus the seed
// project's canonical clone (first migration, no durable row yet). This is the
// core fix: the workspace registry is ephemeral (tmpfs / in-memory) and wiped on
// every cloud recycle, but the project store is durable. Without a workspace
// record a project is invisible to BOTH the project list and the conversation
// list. Generalizes the single-project seed guard to ALL durable non-archived
// projects. Archived projects are intentionally NOT resurrected. Mutates
// `materializedWorkspaceCwds` and `workspaceUpsertInputs` in place; idempotent
// (a cwd already materialized by the agent loop is skipped). On-host this is a
// no-op in practice: the already-materialized short-circuit returns before any
// of this runs, so it only fires on a fresh derive (durable store normally empty
// too).
function appendDurableProjectWorkspaces(options: {
  durableProjects: PersistedProjectRecord[];
  seedProjectKey: string | null;
  seedRepoUrl: string | null;
  containerWorkspaceId: string;
  now: string;
  materializedWorkspaceCwds: Map<string, string>;
  workspaceUpsertInputs: WorkspaceReconstructionInput[];
}): void {
  for (const project of options.durableProjects) {
    if (project.archivedAt) {
      continue;
    }
    const checkoutCwd = normalizeWorkspaceId(project.rootPath);
    if (options.materializedWorkspaceCwds.has(checkoutCwd)) {
      continue;
    }
    options.materializedWorkspaceCwds.set(checkoutCwd, project.projectId);
    options.workspaceUpsertInputs.push({
      workspaceId: checkoutCwd,
      projectKey: project.projectId,
      workspaceCwd: checkoutCwd,
      workspaceKind: workspaceKindForProjectKind(project.kind),
      workspaceDisplayName: project.displayName,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });
  }

  if (!options.seedProjectKey || !options.seedRepoUrl) {
    return;
  }
  const seedCwd = normalizeWorkspaceId(cloudCanonicalClonePath(options.containerWorkspaceId));
  if (options.materializedWorkspaceCwds.has(seedCwd)) {
    return;
  }
  options.materializedWorkspaceCwds.set(seedCwd, options.seedProjectKey);
  options.workspaceUpsertInputs.push({
    workspaceId: seedCwd,
    projectKey: options.seedProjectKey,
    workspaceCwd: seedCwd,
    workspaceKind: "local_checkout",
    workspaceDisplayName: deriveProjectGroupingName(options.seedProjectKey),
    createdAt: options.now,
    updatedAt: options.now,
  });
}

// Build the checkout (workspace) reconstruction input for one workspace's worth
// of agent records: fold the records' time range, resolve a stable project
// identity (recovering remote identity from the cloud clone path when the
// checkout is degraded), accumulate the project, and pick the checkout kind.
// When identity was recovered to a `git` project but the live checkout is
// degraded (clone absent → membership says `directory`), the checkout is the
// clone root, so it is a `local_checkout` — matching the warm-boot derivation.
function buildWorkspaceInputFromAgentRecords(options: {
  workspaceId: string;
  entry: {
    membership: ReturnType<typeof classifyDirectoryForProjectMembership>;
    records: StoredAgentRecord[];
  };
  seedContext: MigrationSeedContext;
  durableProjectsByRepoUrl: Map<string, PersistedProjectRecord>;
  projectAccumulators: Map<string, ProjectAccumulator>;
  now: string;
}): WorkspaceReconstructionInput {
  const { membership, records: workspaceRecords } = options.entry;
  const workspaceCwd = membership.checkout.cwd;
  let workspaceCreatedAt: string | null = null;
  let workspaceUpdatedAt: string | null = null;
  for (const record of workspaceRecords) {
    workspaceCreatedAt = minIsoDate(workspaceCreatedAt, resolveAgentCreatedAt(record));
    workspaceUpdatedAt = maxIsoDate(workspaceUpdatedAt, resolveAgentUpdatedAt(record));
  }

  const createdAt = workspaceCreatedAt ?? options.now;
  const updatedAt = workspaceUpdatedAt ?? createdAt;

  const identity = resolveCheckoutProjectIdentity(
    membership,
    workspaceCwd,
    options.seedContext,
    options.durableProjectsByRepoUrl,
  );
  accumulateProject(options.projectAccumulators, identity, createdAt, updatedAt);

  const workspaceKind: PersistedWorkspaceKind =
    identity.projectKind === "git" && membership.workspaceKind === "directory"
      ? "local_checkout"
      : membership.workspaceKind;

  return {
    workspaceId: options.workspaceId,
    projectKey: identity.projectKey,
    workspaceCwd,
    workspaceKind,
    workspaceDisplayName: membership.workspaceDisplayName,
    createdAt,
    updatedAt,
  };
}

// D-3.5a (finding #2) + workspace-retention — cold-boot clobber guard. At a
// cold cloud respawn the clone at `/workspace/<ws>` is absent, so `getCheckout`
// reports isGit:false → the derived projectKey degrades to the cwd and repoUrl
// to null. When the checkout is degraded AND we're in a cloud container, the
// repo identity is still recoverable from the DETERMINISTIC clone path (primary
// → metadata seed; `<owner>__<repo>` subdir → GitHub URL), preferring the exact
// durable project. This keeps cold and warm boots converging on a single
// remote-keyed `git` identity instead of minting spurious cwd-keyed `non_git`
// rows that accrue as duplicates across recycles.
function resolveCheckoutProjectIdentity(
  membership: ReturnType<typeof classifyDirectoryForProjectMembership>,
  workspaceCwd: string,
  seed: MigrationSeedContext,
  durableProjectsByRepoUrl: Map<string, PersistedProjectRecord>,
): CheckoutProjectIdentity {
  const isDegradedCheckout = membership.projectKey === membership.cwd && !membership.repoUrl;
  const inCloudContainer =
    seed.isCloudContainer && isWithinCloudContainer(workspaceCwd, seed.containerWorkspaceId);

  if (isDegradedCheckout && inCloudContainer) {
    const recovered = recoverCloudCheckoutIdentity({
      cwd: membership.cwd,
      seed,
      durableProjectsByRepoUrl,
    });
    if (recovered) {
      return recovered;
    }
    // Reverse-slug could not recover identity (lossy slug, unexpected layout).
    // Fall back to the legacy primary-clone seed reparent when applicable, else
    // keep today's degraded behavior for this entry (no crash, no wrong row).
    if (seed.seedProjectKey && seed.seedRepoUrl) {
      return {
        projectKey: seed.seedProjectKey,
        projectName: deriveProjectGroupingName(seed.seedProjectKey),
        projectRootPath: cloudCanonicalClonePath(seed.containerWorkspaceId),
        projectKind: "git",
        repoUrl: seed.seedRepoUrl,
      };
    }
  }
  return {
    projectKey: membership.projectKey,
    projectName: membership.projectName,
    projectRootPath: membership.projectRootPath,
    projectKind: membership.projectKind,
    repoUrl: membership.repoUrl,
  };
}

function accumulateProject(
  accumulators: Map<string, ProjectAccumulator>,
  identity: CheckoutProjectIdentity,
  createdAt: string,
  updatedAt: string,
): void {
  const accumulator = accumulators.get(identity.projectKey) ?? {
    projectKey: identity.projectKey,
    projectName: identity.projectName,
    projectRootPath: identity.projectRootPath,
    projectKind: identity.projectKind,
    repoUrl: null,
    createdAt: null,
    updatedAt: null,
  };
  accumulator.createdAt = minIsoDate(accumulator.createdAt, createdAt);
  accumulator.updatedAt = maxIsoDate(accumulator.updatedAt, updatedAt);
  // Never downgrade a known repoUrl to null; a live remote is the strongest
  // provenance so it wins for root path / kind too.
  accumulator.repoUrl = accumulator.repoUrl ?? identity.repoUrl;
  if (identity.repoUrl) {
    accumulator.repoUrl = identity.repoUrl;
    accumulator.projectRootPath = identity.projectRootPath;
    accumulator.projectKind = identity.projectKind;
  }
  accumulators.set(identity.projectKey, accumulator);
}

// Guarded merge — a degraded rebuild never clobbers a good existing project row
// (finding #2). Every project carries the containment FK (T-2) + credential-free
// repoUrl (T-1).
function mergeTimestamps(
  existing: PersistedProjectRecord | null,
  accumulator: ProjectAccumulator,
  fallbackTimestamp: string,
): { createdAt: string; updatedAt: string } {
  const existingCreatedAt = existing ? existing.createdAt : null;
  const existingUpdatedAt = existing ? existing.updatedAt : null;
  return {
    createdAt: minIsoDate(existingCreatedAt, accumulator.createdAt) ?? fallbackTimestamp,
    updatedAt: maxIsoDate(existingUpdatedAt, accumulator.updatedAt) ?? fallbackTimestamp,
  };
}

function mergeProjectRecord(
  accumulator: ProjectAccumulator,
  existing: PersistedProjectRecord | null,
  containerWorkspaceId: string,
  fallbackTimestamp: string,
): PersistedProjectRecord {
  // A live remote is authoritative for rootPath/kind; otherwise keep what we
  // already had (a degraded rebuild must not downgrade a good row).
  const authoritative = accumulator.repoUrl
    ? { rootPath: accumulator.projectRootPath, kind: accumulator.projectKind }
    : {
        rootPath: existing?.rootPath ?? accumulator.projectRootPath,
        kind: existing?.kind ?? accumulator.projectKind,
      };
  const timestamps = mergeTimestamps(existing, accumulator, fallbackTimestamp);
  return createPersistedProjectRecord({
    projectId: accumulator.projectKey,
    rootPath: authoritative.rootPath,
    kind: authoritative.kind,
    displayName: existing?.displayName ?? accumulator.projectName,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
    archivedAt: existing?.archivedAt ?? null,
    workspaceId: existing?.workspaceId ?? containerWorkspaceId,
    repoUrl: accumulator.repoUrl ?? existing?.repoUrl ?? null,
  });
}

// MERGE FLAG (AgentStore vs AgentStorage type gap): upstream's
// `backfillWorkspaceIdForLegacyAgents` declares `agentStorage: AgentStorage`
// (the concrete class), but this fork's stores are typed against the `AgentStore`
// interface so the DynamoDB-backed `DynamoAgentStore` (which `implements
// AgentStore`) can be injected in cloud mode. The migration only calls
// `agentStorage.list()`, which `AgentStore` provides, so the gap is purely
// nominal. This shim bridges it with a single, scoped assertion.
// PROPER FIX (out of scope — outside the 3 merge files): widen the migration's
// param to `agentStorage: AgentStore` in
// `migrations/backfill-workspace-id.migration.ts`, then delete this shim and
// call `backfillWorkspaceIdForLegacyAgents` directly.
async function runWorkspaceIdBackfill(options: {
  agentStorage: AgentStore;
  workspaceRegistry: WorkspaceRegistry;
  logger: Logger;
}): Promise<void> {
  await backfillWorkspaceIdForLegacyAgents({
    agentStorage: options.agentStorage as unknown as AgentStorage,
    workspaceRegistry: options.workspaceRegistry,
    logger: options.logger,
  });
}

export async function bootstrapWorkspaceRegistries(options: {
  paseoHome: string;
  agentStorage: AgentStore;
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  workspaceContainerRegistry: WorkspaceContainerRegistry;
  workspaceGitService: WorkspaceGitService;
  logger: Logger;
  // D-3.5a — the container all reconstructed projects attach to. Cloud:
  // the ambient PASEO_WORKSPACE_ID. On-host: omitted → DEFAULT container.
  containerWorkspaceId?: string;
  // D-3.5a (VERIFY-3.5a finding #4 / OQ-5) — credential-bearing or clean
  // `<ws>#metadata.repoUrl` seed for the migrated first project. Used ONLY
  // when the local clone is absent at boot (cold respawn) so the migrated
  // project's identity/repoUrl does not degrade. Canonicalized before use,
  // so a tokenized seed never leaks. Omitted on-host.
  //
  // COMPAT(workspace-repo-migration): added in v0.1.73, remove after all 3
  // live cloud workspaces (ws_74d480de, ws_7258b0f1, ws_b6e79fef) are
  // confirmed migrated (target 2026-09). The seed bridges the legacy
  // `<ws>#metadata.repoUrl` → the first Project's repoUrl during the model
  // change; once every workspace carries a real project row it is unused.
  migrationRepoUrlSeed?: string | null;
}): Promise<void> {
  const [projectsExists, workspacesExists] = await Promise.all([
    options.projectRegistry.existsOnDisk(),
    options.workspaceRegistry.existsOnDisk(),
  ]);

  await Promise.all([
    options.projectRegistry.initialize(),
    options.workspaceRegistry.initialize(),
    options.workspaceContainerRegistry.initialize(),
  ]);

  const containerWorkspaceId = options.containerWorkspaceId ?? DEFAULT_CONTAINER_WORKSPACE_ID;
  const isCloudContainer = containerWorkspaceId !== DEFAULT_CONTAINER_WORKSPACE_ID;
  const now = new Date().toISOString();

  await seedContainerIfMissing({
    workspaceContainerRegistry: options.workspaceContainerRegistry,
    containerWorkspaceId,
    displayName: isCloudContainer ? containerWorkspaceId : "Local",
    timestamp: now,
  });

  // Upgrader / already-materialized path (on-host: both files present). The
  // derived cache is current except it may predate the 1:N model — backfill
  // containment and return without re-deriving from agent storage.
  if (projectsExists && workspacesExists) {
    // Run BOTH backfills on the already-materialized path: HEAD's
    // project→container containment FK backfill AND upstream's
    // agent.workspaceId backfill. They fix different relics and both must run.
    await backfillMissingProjectContainment({
      projectRegistry: options.projectRegistry,
      containerWorkspaceId,
      logger: options.logger,
    });
    await runWorkspaceIdBackfill(options);
    return;
  }

  // Upstream: reuse stable workspace IDs across reboots, keyed by resolved cwd.
  // Needed by BOTH reconstruction branches below to mint workspace IDs.
  const existingWorkspaceIdsByCwd = new Map(
    (await options.workspaceRegistry.list()).map((workspace) => [
      path.resolve(workspace.cwd),
      workspace.workspaceId,
    ]),
  );

  // D-3.5a (finding #4 / OQ-5) — the migrated first project's identity is
  // seeded from `<ws>#metadata.repoUrl`, NOT from the (possibly-absent at
  // cold boot) local clone. Canonicalize so a tokenized seed never leaks.
  // Only consumed by the cloud reconstruction branch.
  const seedRepoUrl = deriveCanonicalRepoUrl(options.migrationRepoUrlSeed ?? null);
  const seedProjectKey = seedRepoUrl
    ? deriveProjectGroupingKey({
        cwd: cloudCanonicalClonePath(containerWorkspaceId),
        remoteUrl: seedRepoUrl,
        mainRepoRoot: null,
      })
    : null;

  // Snapshot the durable project store once. In cloud mode this is the
  // authoritative, recycle-surviving source of project identity (remote-keyed
  // `projectId`/`repoUrl`); the workspace registry is the ephemeral derived
  // cache that must be reconstructed from it.
  const durableProjects = await options.projectRegistry.list();
  const durableProjectsByRepoUrl = indexDurableProjectsByRepoUrl(durableProjects);

  const records = await options.agentStorage.list();
  const activeRecords = records.filter((record) => !record.archivedAt);
  const recordsByDirectoryKey = new Map<
    string,
    {
      membership: ReturnType<typeof classifyDirectoryForProjectMembership>;
      records: StoredAgentRecord[];
    }
  >();
  const placements = await Promise.all(
    activeRecords.map(async (record) => {
      const normalizedCwd = path.resolve(record.cwd);
      const checkout = await options.workspaceGitService.getCheckout(normalizedCwd);
      const membership = classifyDirectoryForProjectMembership({
        cwd: normalizedCwd,
        checkout,
      });
      return { record, membership, directoryKey: membership.workspaceDirectoryKey };
    }),
  );
  for (const { record, membership, directoryKey } of placements) {
    const existing = recordsByDirectoryKey.get(directoryKey) ?? { membership, records: [] };
    existing.records.push(record);
    recordsByDirectoryKey.set(directoryKey, existing);
  }

  // ==========================================================================
  // MERGE FLAG (workspace-registry-bootstrap): HEAD and upstream wrote DIVERGENT
  // reconstruction algorithms for this function. They could not be cleanly
  // unified because they produce incompatible `workspaceUpsertInputs` shapes
  // and use different write strategies (HEAD: deferred guarded project upsert
  // from `projectAccumulators`; upstream: fused workspace+project upsert from
  // `projectRanges`). Per the merge plan, BOTH paths are kept, selected by
  // whether the daemon is in a cloud container (or carries a migration seed).
  //
  // - CLOUD branch  = HEAD's durable-project reconstruction (load-bearing for
  //   cloud workspace/project persistence across daemon recycle). Rewritten to
  //   iterate `recordsByDirectoryKey` (the old `recordsByWorkspaceId` /
  //   `membership.workspaceId` no longer exist in the current model) and to mint
  //   stable workspace IDs via `existingWorkspaceIdsByCwd ?? generateWorkspaceId`.
  // - ON-HOST branch = upstream's `projectRanges` fold + fused upsert, with
  //   HEAD's container-FK (`workspaceId: containerWorkspaceId`) layered onto the
  //   project record so the on-host container-model tests still pass.
  //
  // FLAG FOR REVIEW: this is the load-bearing divergence the merge prompt called
  // out. Verify the cloud branch's workspace-id minting matches prior cloud
  // behavior (HEAD used the old map key directly) and that both reconstruction
  // tests (cloud-migration + on-host) pass.
  // ==========================================================================
  const isCloudReconstruction = isCloudContainer || options.migrationRepoUrlSeed != null;

  let materializedProjectCount = 0;
  let materializedWorkspaceCount = 0;

  if (isCloudReconstruction) {
    const seedContext: MigrationSeedContext = {
      seedProjectKey,
      seedRepoUrl,
      isCloudContainer,
      containerWorkspaceId,
    };
    const projectAccumulators = new Map<string, ProjectAccumulator>();
    const workspaceUpsertInputs: WorkspaceReconstructionInput[] = [];
    // cwd → projectKey of every checkout we materialize from agent records, so
    // the durable-project reconstruction below never double-writes a workspace
    // that an agent already anchored (idempotency).
    const materializedWorkspaceCwds = new Map<string, string>();

    for (const entry of recordsByDirectoryKey.values()) {
      // Mint a stable workspace id: reuse the existing one for this cwd if the
      // ephemeral registry still has it, else generate a fresh one. (The map
      // key is now a directoryKey, not a workspaceId, so it cannot be the id.)
      const workspaceId =
        existingWorkspaceIdsByCwd.get(path.resolve(entry.membership.checkout.cwd)) ??
        generateWorkspaceId();
      const input = buildWorkspaceInputFromAgentRecords({
        workspaceId,
        entry,
        seedContext,
        durableProjectsByRepoUrl,
        projectAccumulators,
        now,
      });
      workspaceUpsertInputs.push(input);
      materializedWorkspaceCwds.set(normalizeWorkspaceId(input.workspaceCwd), input.projectKey);
    }

    // Ensure a seeded migrated project exists even when NO agent record
    // re-parented onto it (e.g. brand-new migration, agents elsewhere).
    if (seedProjectKey && seedRepoUrl && !projectAccumulators.has(seedProjectKey)) {
      projectAccumulators.set(seedProjectKey, {
        projectKey: seedProjectKey,
        projectName: deriveProjectGroupingName(seedProjectKey),
        projectRootPath: cloudCanonicalClonePath(containerWorkspaceId),
        projectKind: "git",
        repoUrl: seedRepoUrl,
        createdAt: now,
        updatedAt: now,
      });
    }

    // workspace-retention — reconstruct checkout records from the durable project
    // store (the core fix). See `appendDurableProjectWorkspaces`.
    appendDurableProjectWorkspaces({
      durableProjects,
      seedProjectKey,
      seedRepoUrl,
      containerWorkspaceId,
      now,
      materializedWorkspaceCwds,
      workspaceUpsertInputs,
    });

    // Upsert checkout (workspace) records — unchanged shape (DECISION D-1).
    await Promise.all(
      workspaceUpsertInputs.map(
        ({
          workspaceId,
          projectKey,
          workspaceCwd,
          workspaceKind,
          workspaceDisplayName,
          createdAt,
          updatedAt,
        }) =>
          options.workspaceRegistry.upsert(
            createPersistedWorkspaceRecord({
              workspaceId,
              projectId: projectKey,
              cwd: workspaceCwd,
              kind: workspaceKind,
              displayName: workspaceDisplayName,
              createdAt,
              updatedAt,
            }),
          ),
      ),
    );

    // Upsert project records — guarded merge (see mergeProjectRecord).
    await Promise.all(
      Array.from(projectAccumulators.values()).map(async (accumulator) => {
        const existing = await options.projectRegistry.get(accumulator.projectKey);
        await options.projectRegistry.upsert(
          mergeProjectRecord(accumulator, existing, containerWorkspaceId, now),
        );
      }),
    );

    materializedProjectCount = projectAccumulators.size;
    materializedWorkspaceCount = workspaceUpsertInputs.length;
  } else {
    // ON-HOST: upstream's reconstruction (projectRanges fold + fused
    // workspace+project upsert). The project record additionally carries HEAD's
    // container FK (workspaceId: containerWorkspaceId) + a null repoUrl so the
    // D-3.5a on-host container model is preserved.
    const projectRanges = new Map<
      string,
      { createdAt: string | null; updatedAt: string | null }
    >();
    const upstreamWorkspaceUpsertInputs: {
      workspaceId: string;
      membership: ReturnType<typeof classifyDirectoryForProjectMembership>;
      workspaceCwd: string;
      createdAt: string;
      updatedAt: string;
    }[] = [];

    for (const entry of recordsByDirectoryKey.values()) {
      const { membership, records: workspaceRecords } = entry;
      const workspaceCwd = membership.checkout.cwd;
      let workspaceCreatedAt: string | null = null;
      let workspaceUpdatedAt: string | null = null;
      for (const record of workspaceRecords) {
        workspaceCreatedAt = minIsoDate(workspaceCreatedAt, resolveAgentCreatedAt(record));
        workspaceUpdatedAt = maxIsoDate(workspaceUpdatedAt, resolveAgentUpdatedAt(record));
      }

      const createdAt = workspaceCreatedAt ?? new Date().toISOString();
      const updatedAt = workspaceUpdatedAt ?? createdAt;

      const existingProjectRange = projectRanges.get(membership.projectKey) ?? {
        createdAt: null,
        updatedAt: null,
      };
      existingProjectRange.createdAt = minIsoDate(existingProjectRange.createdAt, createdAt);
      existingProjectRange.updatedAt = maxIsoDate(existingProjectRange.updatedAt, updatedAt);
      projectRanges.set(membership.projectKey, existingProjectRange);

      upstreamWorkspaceUpsertInputs.push({
        workspaceId: existingWorkspaceIdsByCwd.get(workspaceCwd) ?? generateWorkspaceId(),
        membership,
        workspaceCwd,
        createdAt,
        updatedAt,
      });
    }

    await Promise.all(
      upstreamWorkspaceUpsertInputs.flatMap(
        ({ workspaceId, membership, workspaceCwd, createdAt, updatedAt }) => {
          const projectRange = projectRanges.get(membership.projectKey) ?? {
            createdAt: null,
            updatedAt: null,
          };
          return [
            options.workspaceRegistry.upsert(
              createPersistedWorkspaceRecord({
                workspaceId,
                projectId: membership.projectKey,
                cwd: workspaceCwd,
                kind: membership.workspaceKind,
                displayName: membership.workspaceDisplayName,
                createdAt,
                updatedAt,
              }),
            ),
            options.projectRegistry.upsert(
              createPersistedProjectRecord({
                projectId: membership.projectKey,
                rootPath: membership.projectRootPath,
                kind: membership.projectKind,
                displayName: membership.projectName,
                createdAt: projectRange.createdAt ?? createdAt,
                updatedAt: projectRange.updatedAt ?? updatedAt,
                // D-3.5a containment FK — every reconstructed on-host project
                // attaches to the (default) container; non-git projects have
                // no repoUrl.
                workspaceId: containerWorkspaceId,
                repoUrl: null,
              }),
            ),
          ];
        },
      ),
    );

    materializedProjectCount = projectRanges.size;
    materializedWorkspaceCount = recordsByDirectoryKey.size;
  }

  // Backfill agent.workspaceId in BOTH branches (upstream migration; independent
  // of which reconstruction ran).
  await runWorkspaceIdBackfill(options);

  options.logger.info(
    {
      projectsFile: path.join(options.paseoHome, "projects", "projects.json"),
      workspacesFile: path.join(options.paseoHome, "projects", "workspaces.json"),
      containerWorkspaceId,
      migratedFromSeed: Boolean(seedProjectKey),
      reconstruction: isCloudReconstruction ? "cloud-durable" : "on-host",
      materializedProjects: materializedProjectCount,
      materializedWorkspaces: materializedWorkspaceCount,
      reconstructedFromDurableProjects: isCloudReconstruction
        ? durableProjects.filter((p) => !p.archivedAt).length
        : 0,
    },
    "Workspace registries bootstrapped from existing agent storage",
  );
}
