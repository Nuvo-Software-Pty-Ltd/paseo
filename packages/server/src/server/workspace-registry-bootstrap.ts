import path from "node:path";

import type { Logger } from "pino";

import type { StoredAgentRecord } from "./agent/agent-storage.js";
import type { AgentStore } from "./agent/agent-storage.js";
import {
  classifyDirectoryForProjectMembership,
  deriveCanonicalRepoUrl,
  deriveProjectGroupingKey,
  deriveProjectGroupingName,
  normalizeWorkspaceId,
} from "./workspace-registry-model.js";
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

// D-3.5a (finding #2) — cold-boot clobber guard. At a cold cloud respawn the
// clone at `/workspace/<ws>` is absent, so `getCheckout` reports isGit:false →
// the derived projectKey degrades to the cwd and repoUrl to null. If we have a
// metadata seed for this container's canonical clone, re-parent these degraded
// checkouts onto the seeded migrated project instead of minting spurious
// cwd-keyed project rows.
function resolveCheckoutProjectIdentity(
  membership: ReturnType<typeof classifyDirectoryForProjectMembership>,
  workspaceCwd: string,
  seed: MigrationSeedContext,
): CheckoutProjectIdentity {
  const isDegradedCheckout = membership.projectKey === membership.cwd && !membership.repoUrl;
  const shouldReparent =
    Boolean(seed.seedProjectKey && seed.seedRepoUrl) &&
    seed.isCloudContainer &&
    isDegradedCheckout &&
    isWithinCloudContainer(workspaceCwd, seed.containerWorkspaceId);
  if (shouldReparent && seed.seedProjectKey && seed.seedRepoUrl) {
    return {
      projectKey: seed.seedProjectKey,
      projectName: deriveProjectGroupingName(seed.seedProjectKey),
      projectRootPath: cloudCanonicalClonePath(seed.containerWorkspaceId),
      projectKind: "git",
      repoUrl: seed.seedRepoUrl,
    };
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
    await backfillMissingProjectContainment({
      projectRegistry: options.projectRegistry,
      containerWorkspaceId,
      logger: options.logger,
    });
    return;
  }

  // D-3.5a (finding #4 / OQ-5) — the migrated first project's identity is
  // seeded from `<ws>#metadata.repoUrl`, NOT from the (possibly-absent at
  // cold boot) local clone. Canonicalize so a tokenized seed never leaks.
  const seedRepoUrl = deriveCanonicalRepoUrl(options.migrationRepoUrlSeed ?? null);
  const seedProjectKey = seedRepoUrl
    ? deriveProjectGroupingKey({
        cwd: cloudCanonicalClonePath(containerWorkspaceId),
        remoteUrl: seedRepoUrl,
        mainRepoRoot: null,
      })
    : null;

  const records = await options.agentStorage.list();
  const activeRecords = records.filter((record) => !record.archivedAt);
  const recordsByWorkspaceId = new Map<
    string,
    {
      membership: ReturnType<typeof classifyDirectoryForProjectMembership>;
      records: StoredAgentRecord[];
    }
  >();
  const placements = await Promise.all(
    activeRecords.map(async (record) => {
      const normalizedCwd = normalizeWorkspaceId(record.cwd);
      const checkout = await options.workspaceGitService.getCheckout(normalizedCwd);
      const membership = classifyDirectoryForProjectMembership({
        cwd: normalizedCwd,
        checkout,
      });
      return { record, membership, workspaceId: membership.workspaceId };
    }),
  );
  for (const { record, membership, workspaceId } of placements) {
    const existing = recordsByWorkspaceId.get(workspaceId) ?? { membership, records: [] };
    existing.records.push(record);
    recordsByWorkspaceId.set(workspaceId, existing);
  }

  const seedContext: MigrationSeedContext = {
    seedProjectKey,
    seedRepoUrl,
    isCloudContainer,
    containerWorkspaceId,
  };
  const projectAccumulators = new Map<string, ProjectAccumulator>();
  const workspaceUpsertInputs: {
    workspaceId: string;
    membership: ReturnType<typeof classifyDirectoryForProjectMembership>;
    projectKey: string;
    workspaceCwd: string;
    createdAt: string;
    updatedAt: string;
  }[] = [];

  for (const [workspaceId, entry] of recordsByWorkspaceId.entries()) {
    const { membership, records: workspaceRecords } = entry;
    const workspaceCwd = membership.checkout.cwd;
    let workspaceCreatedAt: string | null = null;
    let workspaceUpdatedAt: string | null = null;
    for (const record of workspaceRecords) {
      workspaceCreatedAt = minIsoDate(workspaceCreatedAt, resolveAgentCreatedAt(record));
      workspaceUpdatedAt = maxIsoDate(workspaceUpdatedAt, resolveAgentUpdatedAt(record));
    }

    const createdAt = workspaceCreatedAt ?? now;
    const updatedAt = workspaceUpdatedAt ?? createdAt;

    const identity = resolveCheckoutProjectIdentity(membership, workspaceCwd, seedContext);
    accumulateProject(projectAccumulators, identity, createdAt, updatedAt);

    workspaceUpsertInputs.push({
      workspaceId,
      membership,
      projectKey: identity.projectKey,
      workspaceCwd,
      createdAt,
      updatedAt,
    });
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

  // Upsert checkout (workspace) records — unchanged shape (DECISION D-1).
  await Promise.all(
    workspaceUpsertInputs.map(
      ({ workspaceId, membership, projectKey, workspaceCwd, createdAt, updatedAt }) =>
        options.workspaceRegistry.upsert(
          createPersistedWorkspaceRecord({
            workspaceId,
            projectId: projectKey,
            cwd: workspaceCwd,
            kind: membership.workspaceKind,
            displayName: membership.workspaceDisplayName,
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

  options.logger.info(
    {
      projectsFile: path.join(options.paseoHome, "projects", "projects.json"),
      workspacesFile: path.join(options.paseoHome, "projects", "workspaces.json"),
      containerWorkspaceId,
      migratedFromSeed: Boolean(seedProjectKey),
      materializedProjects: projectAccumulators.size,
      materializedWorkspaces: recordsByWorkspaceId.size,
    },
    "Workspace registries bootstrapped from existing agent storage",
  );
}
