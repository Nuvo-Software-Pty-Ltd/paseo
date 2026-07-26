import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";

import {
  ensureCloudWorkspaceRepoCloned,
  isCloudRepairableMissingWorkspace,
  selectProjectRepairClone,
} from "./cloud-workspace-repair.js";
import { deriveRepoUrlFromRemoteProjectKey } from "./workspace-registry-model.js";
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

  it("derives the URL from the remote: projectId when repoUrl was nulled (the clobber regression)", () => {
    // A fire can rewrite the durable project record and drop repoUrl → null. The
    // projectId (the immutable DDB sort key) is the durable source of truth, so
    // the repair must still resolve a clone URL from it.
    const cwd = `/workspace/${WS}/Nuvo-Software-Pty-Ltd__indexing-shopify-app`;
    const projects = [
      project({
        projectId: "remote:github.com/Nuvo-Software-Pty-Ltd/indexing-shopify-app",
        rootPath: cwd,
        displayName: "Nuvo-Software-Pty-Ltd/indexing-shopify-app",
        repoUrl: null,
      }),
    ];

    expect(selectProjectRepairClone({ cwd, workspaceId: WS, projects })).toEqual({
      repoUrl: "https://github.com/Nuvo-Software-Pty-Ltd/indexing-shopify-app",
      destSubdir: "Nuvo-Software-Pty-Ltd__indexing-shopify-app",
      clonePath: cwd,
    });
  });

  it("defers (null) for a repoUrl-less git project with a non-remote (path) key", () => {
    // No repoUrl AND no remote: key → no URL to derive → defer to the primary repair.
    const cwd = `/workspace/${WS}/Owner__repo`;
    const projects = [project({ rootPath: cwd, projectId: cwd, repoUrl: null })];
    expect(selectProjectRepairClone({ cwd, workspaceId: WS, projects })).toBeNull();
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

describe("isCloudRepairableMissingWorkspace", () => {
  // The predicate is cloud-gated, and PASEO_CLOUD_MODE is unset in the test env.
  // Set it per-test so the off-cloud case below is a genuine control.
  function inCloudMode<T>(fn: () => T): T {
    const previous = process.env.PASEO_CLOUD_MODE;
    process.env.PASEO_CLOUD_MODE = "1";
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env.PASEO_CLOUD_MODE;
      else process.env.PASEO_CLOUD_MODE = previous;
    }
  }

  it("defers a secondary repo the lazy repair can re-clone (the vanished-sidebar bug)", () => {
    const cwd = `/workspace/${WS}/Nuvo-Software-Pty-Ltd__agora`;
    const projects = [
      project({
        projectId: "remote:github.com/Nuvo-Software-Pty-Ltd/agora",
        rootPath: cwd,
        displayName: "Nuvo-Software-Pty-Ltd/agora",
        repoUrl: "https://github.com/Nuvo-Software-Pty-Ltd/agora",
      }),
    ];

    expect(inCloudMode(() => isCloudRepairableMissingWorkspace({ cwd, projects }))).toBe(true);
  });

  it("defers a project row whose repoUrl was nulled but keeps its remote: key", () => {
    const cwd = `/workspace/${WS}/Owner__repo`;
    const projects = [project({ rootPath: cwd, repoUrl: null })];

    expect(inCloudMode(() => isCloudRepairableMissingWorkspace({ cwd, projects }))).toBe(true);
  });

  it("defers this container's primary .git-canonical clone, which carries no project row", () => {
    // Its identity lives in the auth-service describe-workspace lookup, so the
    // legacy repair restores it even with no matching durable project.
    expect(
      inCloudMode(() =>
        isCloudRepairableMissingWorkspace({
          cwd: `/workspace/${WS}/.git-canonical`,
          projects: [],
        }),
      ),
    ).toBe(true);
  });

  it("also defers another workspace's leftover .git-canonical (matches the repair's own scoping)", () => {
    // Pins the deliberate choice documented on the predicate: the ws id comes
    // from the path, exactly as ensureCloudWorkspaceRepoCloned derives it, so
    // the deferral set and the repair set cannot drift. The cost is that a relic
    // row lingers in the list until opened; the benefit is one definition of
    // "restorable".
    expect(
      inCloudMode(() =>
        isCloudRepairableMissingWorkspace({
          cwd: "/workspace/ws_b6e79fef/.git-canonical",
          projects: [],
        }),
      ),
    ).toBe(true);
  });

  it("archives stale routine worktrees under the daemon home", () => {
    // The 38 `/var/lib/paseo/worktrees/...` records from scheduled runs: genuinely
    // gone with the tmpfs, and re-cloning a parent would not bring them back.
    expect(
      inCloudMode(() =>
        isCloudRepairableMissingWorkspace({
          cwd: "/var/lib/paseo/worktrees/3qsp2k16/routine-34b3a34b-201d359b",
          projects: [],
        }),
      ),
    ).toBe(false);
  });

  it("archives a nested paseo worktree below a repairable clone", () => {
    const root = `/workspace/${WS}/Owner__repo`;
    const projects = [project({ rootPath: root })];

    expect(
      inCloudMode(() =>
        isCloudRepairableMissingWorkspace({ cwd: `${root}/.paseo/worktrees/foo`, projects }),
      ),
    ).toBe(false);
  });

  it("archives once the durable project row is archived (the deferral is self-bounding)", () => {
    const cwd = `/workspace/${WS}/Owner__repo`;
    const projects = [project({ rootPath: cwd, archivedAt: NOW })];

    expect(inCloudMode(() => isCloudRepairableMissingWorkspace({ cwd, projects }))).toBe(false);
  });

  it("returns false off-cloud, so a deleted desktop directory still archives", () => {
    const cwd = `/workspace/${WS}/Owner__repo`;
    const projects = [project({ rootPath: cwd })];

    expect(isCloudRepairableMissingWorkspace({ cwd, projects })).toBe(false);
  });
});

describe("ensureCloudWorkspaceRepoCloned", () => {
  it("no-ops off-cloud (never touches the project registry, never throws)", async () => {
    // PASEO_CLOUD_MODE is unset in the test env → isPaseoCloudMode() is false, so
    // the repair returns immediately without listing projects or cloning. This is
    // what makes the automation path safe to call unconditionally on-host.
    const list = vi.fn(async () => [] as PersistedProjectRecord[]);
    await expect(
      ensureCloudWorkspaceRepoCloned({
        cwd: `/workspace/${WS}/Owner__repo`,
        projectRegistry: { list },
        logger: { info() {}, warn() {}, error() {} } as unknown as Logger,
      }),
    ).resolves.toBeUndefined();
    expect(list).not.toHaveBeenCalled();
  });
});

describe("deriveRepoUrlFromRemoteProjectKey", () => {
  it("reconstructs the canonical https URL from a remote: project key", () => {
    expect(deriveRepoUrlFromRemoteProjectKey("remote:github.com/Owner/repo")).toBe(
      "https://github.com/Owner/repo",
    );
  });

  it("returns null for a filesystem-path project key (tier-3 fallback rows)", () => {
    expect(deriveRepoUrlFromRemoteProjectKey("/workspace/ws_x/Owner__repo")).toBeNull();
  });

  it("returns null for a remote: key with no path segment", () => {
    expect(deriveRepoUrlFromRemoteProjectKey("remote:github.com")).toBeNull();
  });
});
