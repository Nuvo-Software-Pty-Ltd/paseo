import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Session } from "./session.js";
import type { SessionOutboundMessage } from "../shared/messages.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { createNoopWorkspaceGitService } from "./test-utils/workspace-git-service-stub.js";
import {
  asSessionLogger,
  asAgentManager,
  asAgentStorage,
  asDownloadTokenStore,
  asPushTokenStore,
  asChatService,
  asScheduleService,
  asLoopService,
  asCheckoutDiffManager,
  asDaemonConfigStore,
  asSessionInternals,
} from "./test-utils/session-stubs.js";
import {
  DEFAULT_CONTAINER_WORKSPACE_ID,
  FileBackedProjectRegistry,
  FileBackedWorkspaceContainerRegistry,
  FileBackedWorkspaceRegistry,
  type WorkspaceContainerRegistry,
} from "./workspace-registry.js";

interface ProjectsTestSession {
  handleMessage(message: unknown): Promise<unknown>;
  cleanup(): Promise<void>;
}

// D-3.5a (T-3/T-8) — exercise the explicit project RPCs end-to-end against
// real file-backed registries (no mocks). Covers the self-host / local_dir
// path; the cloud github_repo clone path is integration-tested separately
// (requires AWS Secrets Manager).
describe("Session project RPCs (D-3.5a)", () => {
  let tmpDir: string;
  let projectRegistry: FileBackedProjectRegistry;
  let workspaceRegistry: FileBackedWorkspaceRegistry;
  let containerRegistry: WorkspaceContainerRegistry;
  let emitted: SessionOutboundMessage[];
  let session: ProjectsTestSession;

  function buildSession(): ProjectsTestSession {
    const logger = {
      child: () => logger,
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    return asSessionInternals<ProjectsTestSession>(
      new Session({
        clientId: "test-client",
        appVersion: null,
        onMessage: (message: SessionOutboundMessage) => emitted.push(message),
        logger: asSessionLogger(logger),
        downloadTokenStore: asDownloadTokenStore(),
        pushTokenStore: asPushTokenStore(),
        paseoHome: tmpDir,
        agentManager: asAgentManager({
          subscribe: () => () => {},
          listAgents: () => [],
          getAgent: () => null,
        }),
        agentStorage: asAgentStorage({ list: async () => [], get: async () => null }),
        projectRegistry,
        workspaceRegistry,
        workspaceContainerRegistry: containerRegistry,
        chatService: asChatService(),
        scheduleService: asScheduleService(),
        loopService: asLoopService(),
        checkoutDiffManager: asCheckoutDiffManager({
          subscribe: async () => ({
            initial: { cwd: "/tmp", files: [], error: null },
            unsubscribe: () => {},
          }),
          scheduleRefreshForCwd: () => {},
          getMetrics: () => ({
            checkoutDiffTargetCount: 0,
            checkoutDiffSubscriptionCount: 0,
            checkoutDiffWatcherCount: 0,
            checkoutDiffFallbackRefreshTargetCount: 0,
          }),
          dispose: () => {},
        }),
        workspaceGitService: createNoopWorkspaceGitService(),
        daemonConfigStore: asDaemonConfigStore({
          get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
          onChange: () => () => {},
        }),
        mcpBaseUrl: null,
        stt: null,
        tts: null,
        terminalManager: null,
      }),
    );
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "session-projects-"));
    const registryLogger = createTestLogger();
    projectRegistry = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "projects.json"),
      registryLogger,
    );
    workspaceRegistry = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      registryLogger,
    );
    containerRegistry = new FileBackedWorkspaceContainerRegistry(
      path.join(tmpDir, "projects", "containers.json"),
      registryLogger,
    );
    emitted = [];
    session = buildSession();
  });

  afterEach(async () => {
    // Dispose the Session so its timers/subscriptions/abort controllers are
    // torn down — undisposed Sessions leak handles across test files in a
    // reused vitest worker and destabilize later suites (D-3.5a CI flake).
    await session.cleanup();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function requirePayload<T>(type: SessionOutboundMessage["type"]): T {
    const message = emitted.find((m) => m.type === type);
    if (!message) {
      throw new Error(`expected a ${type} message to be emitted`);
    }
    return (message as { payload: T }).payload;
  }

  test("create_workspace mints a ws_<uuid> container and persists it", async () => {
    await session.handleMessage({
      type: "create_workspace_request",
      displayName: "My Workspace",
      requestId: "r1",
    });
    const payload = requirePayload<{
      requestId: string;
      error: string | null;
      workspace: { workspaceId: string; displayName: string };
    }>("create_workspace_response");
    expect(payload).toMatchObject({ requestId: "r1", error: null });
    expect(payload.workspace.workspaceId).toMatch(/^ws_/);
    expect(payload.workspace.displayName).toBe("My Workspace");
    expect(await containerRegistry.get(payload.workspace.workspaceId)).not.toBeNull();
  });

  test("add_project (local_dir) then list_projects returns it under the workspace", async () => {
    const dir = path.join(tmpDir, "my-local-project");
    await session.handleMessage({
      type: "add_project_request",
      workspaceId: DEFAULT_CONTAINER_WORKSPACE_ID,
      source: { kind: "local_dir", path: dir },
      requestId: "a1",
    });
    const addPayload = requirePayload<{
      requestId: string;
      error: string | null;
      project: { repoUrl: string | null };
    }>("add_project_response");
    expect(addPayload).toMatchObject({ requestId: "a1", error: null });
    // Local non-git dir → null repoUrl (credential-free invariant trivially holds).
    expect(addPayload.project.repoUrl).toBeNull();

    await session.handleMessage({
      type: "list_projects_request",
      workspaceId: DEFAULT_CONTAINER_WORKSPACE_ID,
      requestId: "l1",
    });
    const listPayload = requirePayload<{ projects: unknown[] }>("list_projects_response");
    expect(listPayload.projects).toHaveLength(1);
  });

  // workspace-retention — add_project must also persist a checkout (workspace)
  // record. Without it the project has no workspace row, so it is dropped from
  // both lists and lost on the next cloud recycle (the workspace registry is
  // rebuilt from durable projects at boot). A non-git local dir → "directory".
  test("add_project (local_dir) writes a workspace (checkout) record", async () => {
    const dir = path.join(tmpDir, "added-but-never-opened");
    await session.handleMessage({
      type: "add_project_request",
      workspaceId: DEFAULT_CONTAINER_WORKSPACE_ID,
      source: { kind: "local_dir", path: dir },
      requestId: "a1",
    });
    const addPayload = requirePayload<{ error: string | null; project: { projectId: string } }>(
      "add_project_response",
    );
    expect(addPayload.error).toBeNull();

    const workspaces = await workspaceRegistry.list();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].cwd).toBe(path.resolve(dir));
    expect(workspaces[0].projectId).toBe(addPayload.project.projectId);
    expect(workspaces[0].kind).toBe("directory");
    expect(workspaces[0].archivedAt).toBeNull();
  });

  test("list_projects returns [] for an empty workspace (T-5)", async () => {
    await session.handleMessage({
      type: "list_projects_request",
      workspaceId: "ws_empty",
      requestId: "l0",
    });
    const listPayload = requirePayload<{ projects: unknown[]; error: string | null }>(
      "list_projects_response",
    );
    expect(listPayload.projects).toEqual([]);
    expect(listPayload.error).toBeNull();
  });

  test("remove_project unlinks one project without touching siblings", async () => {
    const dirA = path.join(tmpDir, "proj-a");
    const dirB = path.join(tmpDir, "proj-b");
    await session.handleMessage({
      type: "add_project_request",
      workspaceId: DEFAULT_CONTAINER_WORKSPACE_ID,
      source: { kind: "local_dir", path: dirA },
      requestId: "a1",
    });
    await session.handleMessage({
      type: "add_project_request",
      workspaceId: DEFAULT_CONTAINER_WORKSPACE_ID,
      source: { kind: "local_dir", path: dirB },
      requestId: "a2",
    });
    const projectsBefore = await projectRegistry.list();
    expect(projectsBefore).toHaveLength(2);
    const projectIdA = projectsBefore.find((p) => p.rootPath === dirA)?.projectId as string;

    await session.handleMessage({
      type: "remove_project_request",
      workspaceId: DEFAULT_CONTAINER_WORKSPACE_ID,
      projectId: projectIdA,
      requestId: "rm1",
    });
    const removePayload = requirePayload<{ removed: boolean; error: string | null }>(
      "remove_project_response",
    );
    expect(removePayload).toMatchObject({ removed: true, error: null });

    const remaining = await projectRegistry.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].rootPath).toBe(dirB);
  });

  test("github_repo on self-host is rejected with a clear message (OQ-1)", async () => {
    await session.handleMessage({
      type: "add_project_request",
      workspaceId: DEFAULT_CONTAINER_WORKSPACE_ID,
      source: { kind: "github_repo", repoUrl: "https://github.com/acme/repo" },
      requestId: "g1",
    });
    const addPayload = requirePayload<{ project: unknown | null; error: string | null }>(
      "add_project_response",
    );
    expect(addPayload.project).toBeNull();
    expect(addPayload.error).toContain("cloud mode");
  });
});
