import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import {
  DEFAULT_CONTAINER_WORKSPACE_ID,
  FileBackedProjectRegistry,
  FileBackedWorkspaceContainerRegistry,
  FileBackedWorkspaceRegistry,
  InMemoryWorkspaceContainerRegistry,
  InMemoryWorkspaceRegistry,
} from "./workspace-registry.js";
import { bootstrapWorkspaceRegistries } from "./workspace-registry-bootstrap.js";

const NON_GIT_PROJECT = path.resolve("/tmp/non-git-project");
const ARCHIVED_PROJECT = path.resolve("/tmp/archived-project");

// Top-level (callback-depth 1) lookup helpers — keep array-method callbacks out
// of the deeply-nested cloud-migration describe/test bodies (oxlint
// max-nested-callbacks = 3).
function findWorkspaceByCwd<T extends { cwd: string }>(
  workspaces: T[],
  cwd: string,
): T | undefined {
  return workspaces.find((workspace) => workspace.cwd === cwd);
}

function hasProjectId<T extends { projectId: string }>(projects: T[], projectId: string): boolean {
  return projects.some((project) => project.projectId === projectId);
}

function agentRecord(overrides: { id: string; cwd: string; archivedAt?: string | null }) {
  return {
    id: overrides.id,
    provider: "codex" as const,
    cwd: overrides.cwd,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-02T00:00:00.000Z",
    lastActivityAt: "2026-03-02T00:00:00.000Z",
    lastUserMessageAt: null,
    title: null,
    labels: {},
    lastStatus: "idle" as const,
    lastModeId: null,
    config: null,
    runtimeInfo: { provider: "codex", sessionId: null },
    persistence: null,
    archivedAt: overrides.archivedAt ?? null,
  };
}

describe("bootstrapWorkspaceRegistries", () => {
  let tmpDir: string;
  let paseoHome: string;
  let agentStorage: AgentStorage;
  let projectRegistry: FileBackedProjectRegistry;
  let workspaceRegistry: FileBackedWorkspaceRegistry;
  let workspaceContainerRegistry: FileBackedWorkspaceContainerRegistry;
  let workspaceGitService: WorkspaceGitService;
  const logger = createTestLogger();

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "workspace-bootstrap-"));
    paseoHome = path.join(tmpDir, ".paseo");
    agentStorage = new AgentStorage(path.join(paseoHome, "agents"), logger);
    projectRegistry = new FileBackedProjectRegistry(
      path.join(paseoHome, "projects", "projects.json"),
      logger,
    );
    workspaceRegistry = new FileBackedWorkspaceRegistry(
      path.join(paseoHome, "projects", "workspaces.json"),
      logger,
    );
    workspaceContainerRegistry = new FileBackedWorkspaceContainerRegistry(
      path.join(paseoHome, "projects", "containers.json"),
      logger,
    );
    workspaceGitService = createNoopWorkspaceGitService();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("materializes workspace registries from non-archived agent records", async () => {
    await agentStorage.initialize();
    await agentStorage.upsert(agentRecord({ id: "agent-1", cwd: NON_GIT_PROJECT }));
    await agentStorage.upsert(
      agentRecord({
        id: "agent-2",
        cwd: NON_GIT_PROJECT,
      }),
    );
    await agentStorage.upsert(
      agentRecord({ id: "agent-archived", cwd: ARCHIVED_PROJECT, archivedAt: "2026-03-02" }),
    );

    await bootstrapWorkspaceRegistries({
      paseoHome,
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      workspaceContainerRegistry,
      workspaceGitService,
      logger,
    });

    const workspaces = await workspaceRegistry.list();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.workspaceId).toBe(NON_GIT_PROJECT);

    const projects = await projectRegistry.list();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.projectId).toBe(NON_GIT_PROJECT);
    // D-3.5a (T-2) — every reconstructed project is attached to the default
    // container; a local non-git project has a null repoUrl.
    expect(projects[0]?.workspaceId).toBe(DEFAULT_CONTAINER_WORKSPACE_ID);
    expect(projects[0]?.repoUrl ?? null).toBeNull();
  });

  test("D-3.5a: seeds exactly one default container on-host (DECISION D-2)", async () => {
    await agentStorage.initialize();
    await agentStorage.upsert(agentRecord({ id: "agent-1", cwd: NON_GIT_PROJECT }));

    await bootstrapWorkspaceRegistries({
      paseoHome,
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      workspaceContainerRegistry,
      workspaceGitService,
      logger,
    });

    const containers = await workspaceContainerRegistry.list();
    expect(containers).toHaveLength(1);
    expect(containers[0]?.workspaceId).toBe(DEFAULT_CONTAINER_WORKSPACE_ID);
  });

  test("D-3.5a: a container can exist with zero projects (no-repo guarantee)", async () => {
    // No agent records at all → fresh boot still seeds the empty container.
    await agentStorage.initialize();

    await bootstrapWorkspaceRegistries({
      paseoHome,
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      workspaceContainerRegistry,
      workspaceGitService,
      logger,
    });

    expect(await workspaceContainerRegistry.get(DEFAULT_CONTAINER_WORKSPACE_ID)).not.toBeNull();
    expect(await projectRegistry.list()).toEqual([]);
  });

  test("does not rematerialize when registry files already exist, but backfills containment (finding #3)", async () => {
    await projectRegistry.initialize();
    await workspaceRegistry.initialize();
    // An existing pre-D-3.5a project row — no workspaceId.
    await projectRegistry.upsert({
      projectId: "/tmp/existing",
      rootPath: "/tmp/existing",
      kind: "non_git",
      displayName: "existing",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      archivedAt: null,
    });
    await workspaceRegistry.upsert({
      workspaceId: "/tmp/existing",
      projectId: "/tmp/existing",
      cwd: "/tmp/existing",
      kind: "directory",
      displayName: "existing",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      archivedAt: null,
    });

    await agentStorage.initialize();
    await agentStorage.upsert(agentRecord({ id: "agent-1", cwd: "/tmp/another-project" }));

    await bootstrapWorkspaceRegistries({
      paseoHome,
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      workspaceContainerRegistry,
      workspaceGitService,
      logger,
    });

    // No re-derivation from agent storage (the /tmp/another-project agent is ignored).
    expect(await projectRegistry.list()).toHaveLength(1);
    expect(await workspaceRegistry.list()).toHaveLength(1);
    // VERIFY-3.5a finding #3: the existing project is lazily backfilled onto
    // the default container even though the rebuild short-circuited.
    const existing = await projectRegistry.get("/tmp/existing");
    expect(existing?.workspaceId).toBe(DEFAULT_CONTAINER_WORKSPACE_ID);
    expect(await workspaceContainerRegistry.get(DEFAULT_CONTAINER_WORKSPACE_ID)).not.toBeNull();
  });

  // Cloud `/workspace/<ws>/...` containers are POSIX/Linux-only (ECS; gated by
  // isPaseoCloudMode). On a Windows runner `normalizeWorkspaceId` → path.resolve
  // rewrites these POSIX seeds to `C:\workspace\...`, so the cloud-container
  // detection (intentionally POSIX) no longer matches — a platform combination
  // that cannot occur in production. Skip on win32; ubuntu covers the real path.
  describe.skipIf(process.platform === "win32")(
    "cloud migration (the 3 live repo-bound workspaces)",
    () => {
      const CONTAINER = "ws_74d480de";
      const CLONE = `/workspace/${CONTAINER}/.git-canonical`;

      test("cold boot (clone absent) seeds the migrated project from the metadata repoUrl, credential-free", async () => {
        // Cold respawn: no clone on disk → getCheckout reports non-git.
        const cloudWorkspaceRegistry = new InMemoryWorkspaceRegistry();
        const cloudContainerRegistry = new InMemoryWorkspaceContainerRegistry();
        await agentStorage.initialize();
        await agentStorage.upsert(agentRecord({ id: "agent-1", cwd: CLONE }));

        await bootstrapWorkspaceRegistries({
          paseoHome,
          agentStorage,
          projectRegistry,
          workspaceRegistry: cloudWorkspaceRegistry,
          workspaceContainerRegistry: cloudContainerRegistry,
          workspaceGitService, // noop → non-git checkout (clone absent)
          logger,
          containerWorkspaceId: CONTAINER,
          // Tokenized seed (as `<ws>#metadata.repoUrl` could be) must be sanitized.
          migrationRepoUrlSeed: "https://x-access-token:ghs_LEAK@github.com/acme/app.git",
        });

        const projects = await projectRegistry.list();
        expect(projects).toHaveLength(1);
        const migrated = projects[0];
        expect(migrated?.projectId).toBe("remote:github.com/acme/app");
        expect(migrated?.workspaceId).toBe(CONTAINER);
        expect(migrated?.repoUrl).toBe("https://github.com/acme/app");
        expect(migrated?.repoUrl).not.toContain("ghs_LEAK");
        expect(migrated?.rootPath).toBe(CLONE);
      });

      test("idempotent + never clobbers a good project row with a degraded one (finding #2)", async () => {
        const cloudWorkspaceRegistry = new InMemoryWorkspaceRegistry();
        const cloudContainerRegistry = new InMemoryWorkspaceContainerRegistry();
        // A prior boot already wrote a GOOD migrated project row.
        await projectRegistry.initialize();
        await projectRegistry.upsert({
          projectId: "remote:github.com/acme/app",
          rootPath: CLONE,
          kind: "git",
          displayName: "acme/app",
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:00:00.000Z",
          archivedAt: null,
          workspaceId: CONTAINER,
          repoUrl: "https://github.com/acme/app",
        });

        await agentStorage.initialize();
        await agentStorage.upsert(agentRecord({ id: "agent-1", cwd: CLONE }));

        // Cold boot again (clone absent → degraded checkout) with the seed.
        await bootstrapWorkspaceRegistries({
          paseoHome,
          agentStorage,
          projectRegistry,
          workspaceRegistry: cloudWorkspaceRegistry,
          workspaceContainerRegistry: cloudContainerRegistry,
          workspaceGitService,
          logger,
          containerWorkspaceId: CONTAINER,
          migrationRepoUrlSeed: "https://github.com/acme/app",
        });

        const projects = await projectRegistry.list();
        // No spurious cwd-keyed project; the good row survives unchanged.
        expect(projects).toHaveLength(1);
        const migrated = await projectRegistry.get("remote:github.com/acme/app");
        expect(migrated?.repoUrl).toBe("https://github.com/acme/app");
        expect(migrated?.rootPath).toBe(CLONE);
        expect(migrated?.workspaceId).toBe(CONTAINER);
      });

      test("warm boot (clone present, live remote) derives the project from git facts", async () => {
        const cloudWorkspaceRegistry = new InMemoryWorkspaceRegistry();
        const cloudContainerRegistry = new InMemoryWorkspaceContainerRegistry();
        // getCheckout reports a real git checkout with a tokenized remote.
        const gitService = createNoopWorkspaceGitService({
          getCheckout: async (cwd: string) => ({
            cwd,
            isGit: true,
            currentBranch: "main",
            remoteUrl: "https://x-access-token:ghs_TOKEN@github.com/acme/app.git",
            worktreeRoot: cwd,
            isPaseoOwnedWorktree: false,
            mainRepoRoot: cwd,
          }),
        });
        await agentStorage.initialize();
        await agentStorage.upsert(agentRecord({ id: "agent-1", cwd: CLONE }));

        await bootstrapWorkspaceRegistries({
          paseoHome,
          agentStorage,
          projectRegistry,
          workspaceRegistry: cloudWorkspaceRegistry,
          workspaceContainerRegistry: cloudContainerRegistry,
          workspaceGitService: gitService,
          logger,
          containerWorkspaceId: CONTAINER,
          migrationRepoUrlSeed: "https://github.com/acme/app",
        });

        const migrated = await projectRegistry.get("remote:github.com/acme/app");
        expect(migrated?.workspaceId).toBe(CONTAINER);
        // Even with a live remote, the persisted repoUrl is credential-free.
        expect(migrated?.repoUrl).toBe("https://github.com/acme/app");
        expect(migrated?.repoUrl).not.toContain("ghs_TOKEN");
      });

      // workspace-retention — the production bug: at a cold respawn the workspace
      // registry (tmpfs / in-memory) is empty and the clone is absent, but the
      // project store is durable. An ADDITIONAL repo lives at the deterministic
      // subdir `/workspace/<ws>/<owner>__<repo>`. Recover its identity from the
      // path, reuse the durable project id, materialize a workspace record at the
      // correct cwd, and ensure an agent at that cwd resolves a placement.
      const ADDITIONAL_REPO = "remote:github.com/Nuvo-Software-Pty-Ltd/agora";
      const ADDITIONAL_CWD = `/workspace/${CONTAINER}/Nuvo-Software-Pty-Ltd__agora`;

      test("cold boot reconstructs a workspace for a durable additional repo (agora) and keeps an agent's placement", async () => {
        const cloudWorkspaceRegistry = new InMemoryWorkspaceRegistry();
        const cloudContainerRegistry = new InMemoryWorkspaceContainerRegistry();
        // Durable, non-archived, remote-keyed git project for the 2nd repo —
        // exactly what add_project persisted before the recycle wiped the clone.
        await projectRegistry.initialize();
        await projectRegistry.upsert({
          projectId: ADDITIONAL_REPO,
          rootPath: ADDITIONAL_CWD,
          kind: "git",
          displayName: "Nuvo-Software-Pty-Ltd/agora",
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-06-20T00:00:00.000Z",
          archivedAt: null,
          workspaceId: CONTAINER,
          repoUrl: "https://github.com/Nuvo-Software-Pty-Ltd/agora",
        });
        await agentStorage.initialize();
        // An agent whose cwd is the (now absent) additional clone.
        await agentStorage.upsert(agentRecord({ id: "agent-agora", cwd: ADDITIONAL_CWD }));

        await bootstrapWorkspaceRegistries({
          paseoHome,
          agentStorage,
          projectRegistry,
          workspaceRegistry: cloudWorkspaceRegistry,
          workspaceContainerRegistry: cloudContainerRegistry,
          workspaceGitService, // noop → degraded (clone absent)
          logger,
          containerWorkspaceId: CONTAINER,
          // No primary seed in this scenario — recovery is from the subdir slug.
          migrationRepoUrlSeed: null,
        });

        // (a) remote-keyed git project — NOT a path-keyed non_git duplicate.
        const projects = await projectRegistry.list();
        expect(projects).toHaveLength(1);
        expect(projects[0]?.projectId).toBe(ADDITIONAL_REPO);
        expect(projects[0]?.kind).toBe("git");
        expect(hasProjectId(projects, ADDITIONAL_CWD)).toBe(false);

        // (b) a workspace (checkout) record at the correct cwd, keyed remote.
        const workspaces = await cloudWorkspaceRegistry.list();
        const agoraWorkspace = findWorkspaceByCwd(workspaces, ADDITIONAL_CWD);
        expect(agoraWorkspace).toBeDefined();
        expect(agoraWorkspace?.projectId).toBe(ADDITIONAL_REPO);
        expect(agoraWorkspace?.kind).toBe("local_checkout");

        // (c) an agent at that cwd resolves a placement (the workspace exists),
        // i.e. it would NOT be dropped from the conversation list. The presence
        // of the cwd-matched workspace record above is exactly what the
        // placement lookup keys on.
        expect(agoraWorkspace?.workspaceId).toBe(ADDITIONAL_CWD);
      });

      test("cold boot reconstructs a workspace for a durable project with NO agent record", async () => {
        const cloudWorkspaceRegistry = new InMemoryWorkspaceRegistry();
        const cloudContainerRegistry = new InMemoryWorkspaceContainerRegistry();
        await projectRegistry.initialize();
        await projectRegistry.upsert({
          projectId: ADDITIONAL_REPO,
          rootPath: ADDITIONAL_CWD,
          kind: "git",
          displayName: "Nuvo-Software-Pty-Ltd/agora",
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-06-20T00:00:00.000Z",
          archivedAt: null,
          workspaceId: CONTAINER,
          repoUrl: "https://github.com/Nuvo-Software-Pty-Ltd/agora",
        });
        // No agent records at all.
        await agentStorage.initialize();

        await bootstrapWorkspaceRegistries({
          paseoHome,
          agentStorage,
          projectRegistry,
          workspaceRegistry: cloudWorkspaceRegistry,
          workspaceContainerRegistry: cloudContainerRegistry,
          workspaceGitService,
          logger,
          containerWorkspaceId: CONTAINER,
          migrationRepoUrlSeed: null,
        });

        const workspaces = await cloudWorkspaceRegistry.list();
        expect(workspaces).toHaveLength(1);
        expect(workspaces[0]?.cwd).toBe(ADDITIONAL_CWD);
        expect(workspaces[0]?.projectId).toBe(ADDITIONAL_REPO);
        // The durable project is untouched (still exactly one).
        expect(await projectRegistry.list()).toHaveLength(1);
      });

      test("cold boot does NOT resurrect an archived project", async () => {
        const cloudWorkspaceRegistry = new InMemoryWorkspaceRegistry();
        const cloudContainerRegistry = new InMemoryWorkspaceContainerRegistry();
        await projectRegistry.initialize();
        await projectRegistry.upsert({
          projectId: ADDITIONAL_REPO,
          rootPath: ADDITIONAL_CWD,
          kind: "git",
          displayName: "Nuvo-Software-Pty-Ltd/agora",
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-06-20T00:00:00.000Z",
          archivedAt: "2026-06-21T00:00:00.000Z",
          workspaceId: CONTAINER,
          repoUrl: "https://github.com/Nuvo-Software-Pty-Ltd/agora",
        });
        await agentStorage.initialize();

        await bootstrapWorkspaceRegistries({
          paseoHome,
          agentStorage,
          projectRegistry,
          workspaceRegistry: cloudWorkspaceRegistry,
          workspaceContainerRegistry: cloudContainerRegistry,
          workspaceGitService,
          logger,
          containerWorkspaceId: CONTAINER,
          migrationRepoUrlSeed: null,
        });

        // No workspace materialized for an archived project.
        expect(await cloudWorkspaceRegistry.list()).toHaveLength(0);
      });

      test("warm boot for an additional repo is idempotent (no path-keyed dupe)", async () => {
        const cloudWorkspaceRegistry = new InMemoryWorkspaceRegistry();
        const cloudContainerRegistry = new InMemoryWorkspaceContainerRegistry();
        await projectRegistry.initialize();
        await projectRegistry.upsert({
          projectId: ADDITIONAL_REPO,
          rootPath: ADDITIONAL_CWD,
          kind: "git",
          displayName: "Nuvo-Software-Pty-Ltd/agora",
          createdAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-06-20T00:00:00.000Z",
          archivedAt: null,
          workspaceId: CONTAINER,
          repoUrl: "https://github.com/Nuvo-Software-Pty-Ltd/agora",
        });
        // Clone IS present → live git facts for the additional repo.
        const gitService = createNoopWorkspaceGitService({
          getCheckout: async (cwd: string) => ({
            cwd,
            isGit: true,
            currentBranch: "main",
            remoteUrl: "https://x-access-token:ghs_T@github.com/Nuvo-Software-Pty-Ltd/agora.git",
            worktreeRoot: cwd,
            isPaseoOwnedWorktree: false,
            mainRepoRoot: cwd,
          }),
        });
        await agentStorage.initialize();
        await agentStorage.upsert(agentRecord({ id: "agent-agora", cwd: ADDITIONAL_CWD }));

        await bootstrapWorkspaceRegistries({
          paseoHome,
          agentStorage,
          projectRegistry,
          workspaceRegistry: cloudWorkspaceRegistry,
          workspaceContainerRegistry: cloudContainerRegistry,
          workspaceGitService: gitService,
          logger,
          containerWorkspaceId: CONTAINER,
          migrationRepoUrlSeed: null,
        });

        // Exactly the same single remote-keyed project + one workspace, no dupe.
        const projects = await projectRegistry.list();
        expect(projects).toHaveLength(1);
        expect(projects[0]?.projectId).toBe(ADDITIONAL_REPO);
        const workspaces = await cloudWorkspaceRegistry.list();
        expect(workspaces).toHaveLength(1);
        expect(workspaces[0]?.cwd).toBe(ADDITIONAL_CWD);
        expect(workspaces[0]?.projectId).toBe(ADDITIONAL_REPO);
      });
    },
  );
});
