import { describe, expect, test, vi } from "vitest";

import {
  classifyDirectoryForProjectMembership,
  deriveCanonicalRepoUrl,
  deriveProjectGroupingName,
  deriveProjectRootPath,
  deriveWorkspaceKind,
  deriveWorkspaceId,
  detectStaleWorkspaces,
  normalizeWorkspaceId,
} from "./workspace-registry-model.js";
import { createPersistedWorkspaceRecord } from "./workspace-registry.js";

function createWorkspaceRecord(workspaceId: string) {
  return createPersistedWorkspaceRecord({
    workspaceId,
    projectId: workspaceId,
    cwd: workspaceId,
    kind: "directory",
    displayName: workspaceId.split("/").at(-1) ?? workspaceId,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  });
}

describe("deriveProjectGroupingName", () => {
  test("returns owner/repo for a github remote project key", () => {
    expect(deriveProjectGroupingName("remote:github.com/acme/app")).toBe("acme/app");
  });

  test("returns owner/repo for a gitlab remote project key", () => {
    expect(deriveProjectGroupingName("remote:gitlab.com/acme/app")).toBe("acme/app");
  });

  test("returns last two segments for a self-hosted remote project key", () => {
    expect(deriveProjectGroupingName("remote:git.acme.internal/platform/api")).toBe("platform/api");
  });

  test("returns last two segments for a deeply-nested remote project key", () => {
    expect(deriveProjectGroupingName("remote:gitlab.com/group/sub/app")).toBe("sub/app");
  });

  test("returns the lone path segment when only one segment follows the host", () => {
    expect(deriveProjectGroupingName("remote:github.com/solo")).toBe("solo");
  });

  test("returns the trailing path segment for a non-remote project key", () => {
    expect(deriveProjectGroupingName("/repo/local")).toBe("local");
  });

  test("returns the project key itself when no segments are present", () => {
    expect(deriveProjectGroupingName("")).toBe("");
  });
});

describe("detectStaleWorkspaces", () => {
  test("returns workspace ids whose directories no longer exist", async () => {
    const checkDirectoryExists = vi.fn(async (cwd: string) => cwd !== "/tmp/missing");

    const staleWorkspaceIds = await detectStaleWorkspaces({
      activeWorkspaces: [
        createWorkspaceRecord("/tmp/existing"),
        createWorkspaceRecord("/tmp/missing"),
      ],
      checkDirectoryExists,
    });

    expect(Array.from(staleWorkspaceIds)).toEqual(["/tmp/missing"]);
    expect(checkDirectoryExists.mock.calls).toEqual([["/tmp/existing"], ["/tmp/missing"]]);
  });

  test("keeps workspaces whose directories exist even when all agents are archived", async () => {
    const staleWorkspaceIds = await detectStaleWorkspaces({
      activeWorkspaces: [createWorkspaceRecord("/tmp/repo"), createWorkspaceRecord("/tmp/other")],
      checkDirectoryExists: async () => true,
    });

    expect(Array.from(staleWorkspaceIds)).toEqual([]);
  });

  test("keeps workspaces with no agents when directory exists", async () => {
    const staleWorkspaceIds = await detectStaleWorkspaces({
      activeWorkspaces: [
        createWorkspaceRecord("/tmp/active"),
        createWorkspaceRecord("/tmp/no-agents"),
      ],
      checkDirectoryExists: async () => true,
    });

    expect(Array.from(staleWorkspaceIds)).toEqual([]);
  });
});

describe("deriveWorkspaceId", () => {
  test("uses git worktree root when available", () => {
    expect(
      deriveWorkspaceId("/tmp/repo/packages/app", {
        cwd: "/tmp/repo/packages/app",
        isGit: true,
        currentBranch: "main",
        remoteUrl: "https://github.com/acme/repo.git",
        worktreeRoot: "/tmp/repo",
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      }),
    ).toBe("/tmp/repo");
  });

  test("falls back to normalized cwd when git worktree root contains multiple lines", () => {
    const cwd = String.raw`E:\project\node-ai`;

    expect(
      deriveWorkspaceId(cwd, {
        cwd,
        isGit: true,
        currentBranch: "main",
        remoteUrl: null,
        worktreeRoot: `--path-format=absolute\n${cwd}`,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      }),
    ).toBe(normalizeWorkspaceId(cwd));
  });

  test("falls back to normalized cwd for non-git directories", () => {
    const cwd = "/tmp/repo/../repo/scratch";

    expect(
      deriveWorkspaceId(cwd, {
        cwd,
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      }),
    ).toBe(normalizeWorkspaceId("/tmp/repo/scratch"));
  });
});

describe("git worktree grouping", () => {
  test("classifies plain git worktrees for project membership from git facts", () => {
    const membership = classifyDirectoryForProjectMembership({
      cwd: "/tmp/repo-feature",
      checkout: {
        cwd: "/tmp/repo-feature",
        isGit: true,
        currentBranch: "feature/plain",
        remoteUrl: "https://github.com/acme/repo.git",
        worktreeRoot: "/tmp/repo-feature",
        isPaseoOwnedWorktree: false,
        mainRepoRoot: "/tmp/repo",
      },
    });

    expect(membership).toMatchObject({
      cwd: normalizeWorkspaceId("/tmp/repo-feature"),
      workspaceId: "/tmp/repo-feature",
      workspaceKind: "worktree",
      workspaceDisplayName: "feature/plain",
      projectKey: "remote:github.com/acme/repo",
      projectName: "acme/repo",
      projectRootPath: "/tmp/repo",
      projectKind: "git",
      repoUrl: "https://github.com/acme/repo",
    });
  });

  test("uses mainRepoRoot as the project root for plain git worktrees", () => {
    expect(
      deriveProjectRootPath({
        cwd: "/tmp/repo-feature",
        checkout: {
          cwd: "/tmp/repo-feature",
          isGit: true,
          currentBranch: "feature/plain",
          remoteUrl: "https://github.com/acme/repo.git",
          worktreeRoot: "/tmp/repo-feature",
          isPaseoOwnedWorktree: false,
          mainRepoRoot: "/tmp/repo",
        },
      }),
    ).toBe("/tmp/repo");
  });

  test("classifies plain git worktrees as workspaces of kind worktree", () => {
    expect(
      deriveWorkspaceKind({
        cwd: "/tmp/repo-feature",
        isGit: true,
        currentBranch: "feature/plain",
        remoteUrl: "https://github.com/acme/repo.git",
        worktreeRoot: "/tmp/repo-feature",
        isPaseoOwnedWorktree: false,
        mainRepoRoot: "/tmp/repo",
      }),
    ).toBe("worktree");
  });
});

// D-3.5a (VERIFY-3.5a finding #1, HIGH) — repoUrl must NEVER carry a
// credential. The cloud clone stores a tokenized remote
// (`https://x-access-token:<TOKEN>@github.com/...`); canonicalization
// strips it before the value can be persisted or shipped over the wire.
describe("deriveCanonicalRepoUrl (credential-free repo provenance)", () => {
  test("strips an embedded access token from a tokenized https remote", () => {
    const tokenized = "https://x-access-token:ghs_SUPERSECRETTOKEN@github.com/acme/repo.git";
    const canonical = deriveCanonicalRepoUrl(tokenized);
    expect(canonical).toBe("https://github.com/acme/repo");
    expect(canonical).not.toContain("x-access-token");
    expect(canonical).not.toContain("ghs_SUPERSECRETTOKEN");
    expect(canonical).not.toContain("@");
  });

  test("strips basic-auth user:password credentials from any https remote", () => {
    const canonical = deriveCanonicalRepoUrl("https://user:p%40ss@gitlab.com/group/app.git");
    expect(canonical).toBe("https://gitlab.com/group/app");
    expect(canonical).not.toContain("user");
    expect(canonical).not.toContain("p%40ss");
  });

  test("canonicalizes a clean github https remote (drops .git suffix)", () => {
    expect(deriveCanonicalRepoUrl("https://github.com/acme/repo.git")).toBe(
      "https://github.com/acme/repo",
    );
  });

  test("canonicalizes an scp-style git remote", () => {
    expect(deriveCanonicalRepoUrl("git@github.com:acme/repo.git")).toBe(
      "https://github.com/acme/repo",
    );
  });

  test("returns null for a non-remote / null input", () => {
    expect(deriveCanonicalRepoUrl(null)).toBeNull();
    expect(deriveCanonicalRepoUrl("")).toBeNull();
    expect(deriveCanonicalRepoUrl("not-a-url")).toBeNull();
  });

  test("a tokenized remote routed through classifyDirectoryForProjectMembership yields a credential-free repoUrl", () => {
    const membership = classifyDirectoryForProjectMembership({
      cwd: "/workspace/ws_demo/.git-canonical",
      checkout: {
        cwd: "/workspace/ws_demo/.git-canonical",
        isGit: true,
        currentBranch: "main",
        remoteUrl: "https://x-access-token:ghs_LEAKME@github.com/acme/private-repo.git",
        worktreeRoot: "/workspace/ws_demo/.git-canonical",
        isPaseoOwnedWorktree: false,
        mainRepoRoot: "/workspace/ws_demo/.git-canonical",
      },
    });
    expect(membership.repoUrl).toBe("https://github.com/acme/private-repo");
    expect(membership.repoUrl).not.toContain("ghs_LEAKME");
  });
});
