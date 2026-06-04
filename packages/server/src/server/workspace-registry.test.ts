import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";

import { beforeEach, afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  createWorkspaceContainerRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceContainerRegistry,
  FileBackedWorkspaceRegistry,
  InMemoryWorkspaceContainerRegistry,
  InMemoryWorkspaceRegistry,
} from "./workspace-registry.js";

describe("workspace registries", () => {
  let tmpDir: string;
  let projectRegistry: FileBackedProjectRegistry;
  let workspaceRegistry: FileBackedWorkspaceRegistry;
  const logger = createTestLogger();

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "workspace-registry-"));
    projectRegistry = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "projects.json"),
      logger,
    );
    workspaceRegistry = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates, updates, archives, deletes, and lists project records", async () => {
    await projectRegistry.initialize();
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      }),
    );
    await projectRegistry.archive("remote:github.com/acme/repo", "2026-03-03T00:00:00.000Z");

    const archived = await projectRegistry.get("remote:github.com/acme/repo");
    expect(archived?.archivedAt).toBe("2026-03-03T00:00:00.000Z");
    expect(await projectRegistry.list()).toHaveLength(1);

    await projectRegistry.remove("remote:github.com/acme/repo");
    expect(await projectRegistry.get("remote:github.com/acme/repo")).toBeNull();
    expect(await projectRegistry.list()).toEqual([]);
  });

  test("D-3.5a: persists and round-trips project workspaceId + repoUrl", async () => {
    await projectRegistry.initialize();
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
        workspaceId: "ws_local",
        repoUrl: "https://github.com/acme/repo",
      }),
    );
    const fetched = await projectRegistry.get("remote:github.com/acme/repo");
    expect(fetched).toMatchObject({
      workspaceId: "ws_local",
      repoUrl: "https://github.com/acme/repo",
    });
  });

  test("D-3.5a: an old projects.json file (no workspaceId/repoUrl) still parses", async () => {
    const projectsDir = path.join(tmpDir, "legacy");
    mkdirSync(projectsDir, { recursive: true });
    const filePath = path.join(projectsDir, "projects.json");
    // Shape produced by a pre-D-3.5a daemon.
    writeFileSync(
      filePath,
      JSON.stringify([
        {
          projectId: "remote:github.com/acme/old",
          rootPath: "/tmp/old",
          kind: "git",
          displayName: "acme/old",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          archivedAt: null,
        },
      ]),
    );
    const legacyRegistry = new FileBackedProjectRegistry(filePath, logger);
    await legacyRegistry.initialize();
    const records = await legacyRegistry.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ projectId: "remote:github.com/acme/old" });
    expect(records[0].workspaceId).toBeUndefined();
    expect(records[0].repoUrl).toBeUndefined();
  });

  test("D-3.5a: container registry persists a zero-project container and round-trips", async () => {
    const containerRegistry = new FileBackedWorkspaceContainerRegistry(
      path.join(tmpDir, "projects", "containers.json"),
      logger,
    );
    await containerRegistry.initialize();
    await containerRegistry.upsert(
      createWorkspaceContainerRecord({
        workspaceId: "ws_abc123",
        displayName: "My Workspace",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      }),
    );
    const fetched = await containerRegistry.get("ws_abc123");
    expect(fetched).toMatchObject({ workspaceId: "ws_abc123", displayName: "My Workspace" });
    // A reload from disk sees the same container (durability).
    const reloaded = new FileBackedWorkspaceContainerRegistry(
      path.join(tmpDir, "projects", "containers.json"),
      logger,
    );
    await reloaded.initialize();
    expect(await reloaded.get("ws_abc123")).toMatchObject({ displayName: "My Workspace" });
  });

  test("creates, updates, archives, deletes, and lists workspace records", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "/tmp/repo",
        projectId: "remote:github.com/acme/repo",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "/tmp/repo",
        projectId: "remote:github.com/acme/repo",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "feature/workspace",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      }),
    );
    await workspaceRegistry.archive("/tmp/repo", "2026-03-03T00:00:00.000Z");

    const archived = await workspaceRegistry.get("/tmp/repo");
    expect(archived?.displayName).toBe("feature/workspace");
    expect(archived?.archivedAt).toBe("2026-03-03T00:00:00.000Z");

    await workspaceRegistry.remove("/tmp/repo");
    expect(await workspaceRegistry.get("/tmp/repo")).toBeNull();
    expect(await workspaceRegistry.list()).toEqual([]);
  });
});

describe("InMemoryWorkspaceRegistry (cloud-mode variant)", () => {
  let registry: InMemoryWorkspaceRegistry;

  beforeEach(() => {
    registry = new InMemoryWorkspaceRegistry();
  });

  test("existsOnDisk always returns false", async () => {
    expect(await registry.existsOnDisk()).toBe(false);
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws_1",
        projectId: "proj_1",
        cwd: "/work",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(await registry.existsOnDisk()).toBe(false);
  });

  test("upsert → get round-trips a workspace record", async () => {
    await registry.initialize();
    const record = createPersistedWorkspaceRecord({
      workspaceId: "ws_abc",
      projectId: "proj_xyz",
      cwd: "/work/repo",
      kind: "local_checkout",
      displayName: "main",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    await registry.upsert(record);
    expect(await registry.get("ws_abc")).toEqual(record);
  });

  test("list returns all upserted records", async () => {
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws_1",
        projectId: "proj_1",
        cwd: "/a",
        kind: "local_checkout",
        displayName: "a",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws_2",
        projectId: "proj_1",
        cwd: "/b",
        kind: "worktree",
        displayName: "b",
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    expect(await registry.list()).toHaveLength(2);
  });

  test("archive sets archivedAt and updatedAt", async () => {
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws_arch",
        projectId: "proj_1",
        cwd: "/work",
        kind: "directory",
        displayName: "work",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await registry.archive("ws_arch", "2026-02-01T00:00:00.000Z");
    const archived = await registry.get("ws_arch");
    expect(archived?.archivedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(archived?.updatedAt).toBe("2026-02-01T00:00:00.000Z");
  });

  test("archive is a no-op for unknown workspace", async () => {
    await registry.archive("ws_nonexistent", "2026-02-01T00:00:00.000Z");
    expect(await registry.get("ws_nonexistent")).toBeNull();
  });

  test("remove deletes the record", async () => {
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws_rm",
        projectId: "proj_1",
        cwd: "/work",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await registry.remove("ws_rm");
    expect(await registry.get("ws_rm")).toBeNull();
    expect(await registry.list()).toEqual([]);
  });

  test("get returns null for unknown workspace", async () => {
    expect(await registry.get("ws_unknown")).toBeNull();
  });
});

describe("InMemoryWorkspaceContainerRegistry (cloud-mode variant)", () => {
  test("existsOnDisk always returns false and round-trips a container", async () => {
    const registry = new InMemoryWorkspaceContainerRegistry();
    expect(await registry.existsOnDisk()).toBe(false);
    await registry.upsert(
      createWorkspaceContainerRecord({
        workspaceId: "ws_cloud",
        displayName: "cloud container",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      }),
    );
    expect(await registry.existsOnDisk()).toBe(false);
    expect(await registry.get("ws_cloud")).toMatchObject({ displayName: "cloud container" });
  });
});
