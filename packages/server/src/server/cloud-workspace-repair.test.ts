import { describe, expect, it } from "vitest";

import { selectProjectRepairClone } from "./cloud-workspace-repair.js";
import { createPersistedProjectRecord, type PersistedProjectRecord } from "./workspace-registry.js";

const WS = "ws_3ea432ff";
const NOW = "2026-06-26T00:00:00.000Z";

function project(overrides: Partial<Parameters<typeof createPersistedProjectRecord>[0]>) {
  return createPersistedProjectRecord({
    projectId: "remote:github.com/Owner/repo",
    rootPath: `/workspace/${WS}/Owner__repo`,
    kind: "git",
    displayName: "Owner/repo",
    createdAt: NOW,
    updatedAt: NOW,
    workspaceId: WS,
    repoUrl: "https://github.com/Owner/repo",
    ...overrides,
  });
}

describe("selectProjectRepairClone", () => {
  it("restores a secondary <owner>__<repo> project at its rootPath (the sii-google-ads bug)", () => {
    const cwd = `/workspace/${WS}/Nuvo-Software-Pty-Ltd__sii-google-ads`;
    const projects: PersistedProjectRecord[] = [
      project({
        projectId: "remote:github.com/Nuvo-Software-Pty-Ltd/sii-google-ads",
        rootPath: cwd,
        displayName: "Nuvo-Software-Pty-Ltd/sii-google-ads",
        repoUrl: "https://github.com/Nuvo-Software-Pty-Ltd/sii-google-ads",
      }),
    ];

    expect(selectProjectRepairClone({ cwd, workspaceId: WS, projects })).toEqual({
      repoUrl: "https://github.com/Nuvo-Software-Pty-Ltd/sii-google-ads",
      destSubdir: "Nuvo-Software-Pty-Ltd__sii-google-ads",
      clonePath: cwd,
    });
  });

  it("canonicalizes a credential-bearing repoUrl (token + .git stripped)", () => {
    const cwd = `/workspace/${WS}/Owner__repo`;
    const projects = [
      project({
        rootPath: cwd,
        repoUrl: "https://x-access-token:secret@github.com/Owner/repo.git",
      }),
    ];

    expect(selectProjectRepairClone({ cwd, workspaceId: WS, projects })?.repoUrl).toBe(
      "https://github.com/Owner/repo",
    );
  });

  it("defers (null) for the container root so the primary repair runs", () => {
    const cwd = `/workspace/${WS}`;
    expect(selectProjectRepairClone({ cwd, workspaceId: WS, projects: [project({})] })).toBeNull();
  });

  it("defers (null) for a nested worktree path below the clone", () => {
    const cwd = `/workspace/${WS}/Owner__repo/.worktrees/feature`;
    expect(selectProjectRepairClone({ cwd, workspaceId: WS, projects: [project({})] })).toBeNull();
  });

  it("defers (null) when the matching project is archived", () => {
    const cwd = `/workspace/${WS}/Owner__repo`;
    const projects = [project({ rootPath: cwd, archivedAt: NOW })];
    expect(selectProjectRepairClone({ cwd, workspaceId: WS, projects })).toBeNull();
  });

  it("defers (null) for a non_git project (no repo to clone)", () => {
    const cwd = `/workspace/${WS}/Owner__repo`;
    const projects = [project({ rootPath: cwd, kind: "non_git", repoUrl: null })];
    expect(selectProjectRepairClone({ cwd, workspaceId: WS, projects })).toBeNull();
  });

  it("defers (null) when no durable project matches the path", () => {
    const cwd = `/workspace/${WS}/Owner__repo`;
    const projects = [project({ rootPath: `/workspace/${WS}/Other__thing` })];
    expect(selectProjectRepairClone({ cwd, workspaceId: WS, projects })).toBeNull();
  });

  it("defers (null) for a path under a different workspace", () => {
    const cwd = `/workspace/ws_other/Owner__repo`;
    const projects = [project({ rootPath: cwd })];
    expect(selectProjectRepairClone({ cwd, workspaceId: WS, projects })).toBeNull();
  });
});
