import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";
import { isCloudRepairableMissingWorkspace } from "./cloud-workspace-repair.js";
import {
  FileBackedProjectRegistry,
  InMemoryWorkspaceContainerRegistry,
  InMemoryWorkspaceRegistry,
} from "./workspace-registry.js";
import { bootstrapWorkspaceRegistries } from "./workspace-registry-bootstrap.js";
import { WorkspaceReconciliationService } from "./workspace-reconciliation-service.js";

// workspace-retention — regression cover for the composed cloud boot sequence in
// bootstrap.ts, which nothing tested before: bootstrapWorkspaceRegistries()
// rehydrates workspace records from the durable project store, and ~13ms later
// WorkspaceReconciliationService.runOnce() sweeps them. In cloud, /workspace is
// tmpfs and empty that early, so the sweep archived 42 of 43 workspaces on every
// recycle and the user's sidebar came back empty ("Workspace not found" on every
// deep link). Each half was individually tested and individually correct; only
// their composition was broken, which is exactly why this file exists.
//
// None of the directories below are ever created on disk — that absence IS the
// scenario under test.

const CONTAINER = "ws_3ea432ff";
const AGORA = `/workspace/${CONTAINER}/Nuvo-Software-Pty-Ltd__agora`;
const SHOPIFY = `/workspace/${CONTAINER}/Nuvo-Software-Pty-Ltd__indexing-shopify-app`;
const STALE_WORKTREE = "/var/lib/paseo/worktrees/3qsp2k16/routine-34b3a34b-201d359b";

function agentRecord(overrides: { id: string; cwd: string }) {
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
    archivedAt: null,
  };
}

function durableRepo(input: { projectId: string; rootPath: string; displayName: string }) {
  return {
    projectId: input.projectId,
    rootPath: input.rootPath,
    kind: "git" as const,
    displayName: input.displayName,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    archivedAt: null,
    workspaceId: CONTAINER,
    repoUrl: `https://github.com/${input.displayName}`,
  };
}

function archivedWorkspaceCwds(result: { changesApplied: Array<Record<string, unknown>> }) {
  return result.changesApplied
    .filter((change) => change.kind === "workspace_archived")
    .map((change) => change.directory);
}

// Linux-only, like the daemon this reproduces. `bootstrapWorkspaceRegistries`
// normalizes checkout paths through `node:path.resolve`, which on a Windows CI
// runner rewrites `/workspace/<ws>/...` to a drive-letter/backslash path — so the
// materialized records would no longer match the POSIX literals asserted below.
// That is the same rewrite cloud-workspace-repair.ts avoids by hand-rolling its
// path normalization; the code under test never executes off the Linux daemon.
describe.skipIf(process.platform === "win32")("cloud boot: bootstrap then reconcile", () => {
  let tmpDir: string;
  let paseoHome: string;
  let agentStorage: AgentStorage;
  let projectRegistry: FileBackedProjectRegistry;
  let workspaceRegistry: InMemoryWorkspaceRegistry;
  let previousCloudMode: string | undefined;
  const logger = createTestLogger();

  beforeEach(async () => {
    previousCloudMode = process.env.PASEO_CLOUD_MODE;
    process.env.PASEO_CLOUD_MODE = "1";

    tmpDir = mkdtempSync(path.join(os.tmpdir(), "workspace-reconcile-boot-"));
    paseoHome = path.join(tmpDir, ".paseo");
    agentStorage = new AgentStorage(path.join(paseoHome, "agents"), logger);
    // In cloud the project store is DynamoDB-backed; a file-backed registry is
    // the same ProjectRegistry contract and keeps this test hermetic.
    projectRegistry = new FileBackedProjectRegistry(
      path.join(paseoHome, "projects", "projects.json"),
      logger,
    );
    // Cloud uses the in-memory registry — workspace records are re-derived from
    // durable projects on every boot, which is why a bad sweep repeats forever.
    workspaceRegistry = new InMemoryWorkspaceRegistry();

    await projectRegistry.initialize();
    await projectRegistry.upsert(
      durableRepo({
        projectId: "remote:github.com/Nuvo-Software-Pty-Ltd/agora",
        rootPath: AGORA,
        displayName: "Nuvo-Software-Pty-Ltd/agora",
      }),
    );
    await projectRegistry.upsert(
      durableRepo({
        projectId: "remote:github.com/Nuvo-Software-Pty-Ltd/indexing-shopify-app",
        rootPath: SHOPIFY,
        displayName: "Nuvo-Software-Pty-Ltd/indexing-shopify-app",
      }),
    );
    await agentStorage.initialize();
    // A leftover scheduled-routine worktree under the daemon home. Its tmpfs
    // state is genuinely unrecoverable, so it SHOULD still be archived — the fix
    // must not turn the sweep off wholesale.
    await agentStorage.upsert(agentRecord({ id: "agent-routine", cwd: STALE_WORKTREE }));

    await bootstrapWorkspaceRegistries({
      paseoHome,
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      workspaceContainerRegistry: new InMemoryWorkspaceContainerRegistry(),
      workspaceGitService: createNoopWorkspaceGitService(),
      logger,
      containerWorkspaceId: CONTAINER,
      migrationRepoUrlSeed: null,
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (previousCloudMode === undefined) delete process.env.PASEO_CLOUD_MODE;
    else process.env.PASEO_CLOUD_MODE = previousCloudMode;
  });

  function reconciliationService() {
    return new WorkspaceReconciliationService({
      projectRegistry,
      workspaceRegistry,
      logger,
      shouldDeferMissingWorkspaceArchive: isCloudRepairableMissingWorkspace,
    });
  }

  test("keeps repo workspaces that the lazy repair can re-clone, with nothing on disk", async () => {
    const result = await reconciliationService().runOnce();

    expect(archivedWorkspaceCwds(result)).not.toContain(AGORA);
    expect(archivedWorkspaceCwds(result)).not.toContain(SHOPIFY);

    const active = (await workspaceRegistry.list()).filter((workspace) => !workspace.archivedAt);
    expect(active.map((workspace) => workspace.cwd)).toEqual(
      expect.arrayContaining([AGORA, SHOPIFY]),
    );
  });

  test("still archives an unrecoverable stale routine worktree in the same pass", async () => {
    const result = await reconciliationService().runOnce();

    expect(archivedWorkspaceCwds(result)).toContain(STALE_WORKTREE);
  });

  test("is idempotent — the session's first fetch_workspaces pass archives nothing further", async () => {
    // The second construction site (Session.reconcileActiveWorkspaceRecords)
    // builds a fresh service per call and also tears down each archived
    // workspace. Fixing only bootstrap would let this pass re-empty the sidebar.
    await reconciliationService().runOnce();

    const second = await reconciliationService().runOnce();

    expect(archivedWorkspaceCwds(second)).toEqual([]);
  });

  test("archives the repos once their durable project rows are archived", async () => {
    // The deferral is recomputed from the live durable list every pass, so it
    // needs no TTL or counter to terminate.
    for (const project of await projectRegistry.list()) {
      await projectRegistry.archive(project.projectId, "2026-07-26T09:00:00.000Z");
    }

    const result = await reconciliationService().runOnce();

    expect(archivedWorkspaceCwds(result)).toEqual(expect.arrayContaining([AGORA, SHOPIFY]));
  });
});
