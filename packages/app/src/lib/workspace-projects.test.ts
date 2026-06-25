import { describe, expect, it } from "vitest";
import type { ProjectDescriptor, WorkspaceDescriptor } from "@/stores/session-store";
import {
  primaryProject,
  projectDescriptorFromPayload,
  withWorkspaceProjects,
  workspaceDisplayName,
  workspacePrimaryDisplayName,
  workspacePrimaryProjectId,
  workspacePrimaryRootPath,
  workspaceProjectCount,
  workspaceProjects,
} from "./workspace-projects";

function makeProject(
  overrides: Partial<ProjectDescriptor> & { projectId: string },
): ProjectDescriptor {
  return {
    workspaceId: "ws_1",
    displayName: overrides.projectId,
    rootPath: `/repos/${overrides.projectId}`,
    repoUrl: `https://github.com/acme/${overrides.projectId}`,
    kind: "git",
    archivedAt: null,
    ...overrides,
  };
}

function makeWorkspace(projects: ProjectDescriptor[] | undefined): WorkspaceDescriptor {
  return {
    id: "ws_1",
    displayName: "Container One",
    projects,
    projectId: "legacy-project",
    projectDisplayName: "Legacy Project",
    projectRootPath: "/repos/legacy",
    workspaceDirectory: "/repos/legacy",
    projectKind: "git",
    workspaceKind: "worktree",
    name: "Container One",
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

describe("workspace-projects helpers", () => {
  it("models a workspace with 0 projects (repo-less / empty)", () => {
    const ws = makeWorkspace([]);
    expect(workspaceProjects(ws)).toEqual([]);
    expect(workspaceProjectCount(ws)).toBe(0);
    expect(primaryProject(ws)).toBeNull();
    // COMPAT getters fall back to the legacy descriptor fields when empty.
    expect(workspacePrimaryProjectId(ws)).toBe("legacy-project");
    expect(workspacePrimaryRootPath(ws)).toBe("/repos/legacy");
  });

  it("models a workspace with 1 project and derives singular getters from it", () => {
    const project = makeProject({ projectId: "alpha" });
    const ws = makeWorkspace([project]);
    expect(workspaceProjectCount(ws)).toBe(1);
    expect(primaryProject(ws)).toEqual(project);
    expect(workspacePrimaryProjectId(ws)).toBe("alpha");
    expect(workspacePrimaryRootPath(ws)).toBe("/repos/alpha");
    expect(workspacePrimaryDisplayName(ws)).toBe("alpha");
  });

  it("models a workspace with 2 projects; singular getters reflect the FIRST", () => {
    const first = makeProject({ projectId: "alpha" });
    const second = makeProject({ projectId: "beta" });
    const ws = makeWorkspace([first, second]);
    expect(workspaceProjectCount(ws)).toBe(2);
    expect(workspaceProjects(ws)).toHaveLength(2);
    expect(primaryProject(ws)).toEqual(first);
    expect(workspacePrimaryProjectId(ws)).toBe("alpha");
  });

  it("ignores archived projects in the count", () => {
    const ws = makeWorkspace([
      makeProject({ projectId: "alpha" }),
      makeProject({ projectId: "beta", archivedAt: "2026-06-01T00:00:00.000Z" }),
    ]);
    expect(workspaceProjectCount(ws)).toBe(1);
  });

  it("defaults projects[] to [] when the optional field is absent", () => {
    const ws = makeWorkspace(undefined);
    expect(workspaceProjects(ws)).toEqual([]);
    expect(workspaceProjectCount(ws)).toBe(0);
  });

  it("workspaceDisplayName prefers displayName, falls back to name", () => {
    expect(workspaceDisplayName(makeWorkspace([]))).toBe("Container One");
    const noDisplay = { ...makeWorkspace([]), displayName: undefined };
    expect(workspaceDisplayName(noDisplay)).toBe("Container One");
  });

  it("withWorkspaceProjects replaces projects[] and re-syncs the COMPAT singular fields", () => {
    const ws = makeWorkspace([]);
    const next = withWorkspaceProjects(ws, [makeProject({ projectId: "gamma" })]);
    expect(next.projects).toHaveLength(1);
    expect(next.projectId).toBe("gamma");
    expect(next.projectRootPath).toBe("/repos/gamma");
    expect(next.projectDisplayName).toBe("gamma");
    // Original is untouched (no mutation).
    expect(workspaceProjects(ws)).toEqual([]);
  });

  it("projectDescriptorFromPayload maps the daemon row 1:1", () => {
    const descriptor = projectDescriptorFromPayload({
      projectId: "p1",
      workspaceId: "ws_9",
      displayName: "Repo One",
      rootPath: "/workspace/ws_9/repo-one",
      repoUrl: "https://github.com/acme/repo-one",
      kind: "git",
      archivedAt: null,
    });
    expect(descriptor).toEqual({
      projectId: "p1",
      workspaceId: "ws_9",
      displayName: "Repo One",
      rootPath: "/workspace/ws_9/repo-one",
      repoUrl: "https://github.com/acme/repo-one",
      kind: "git",
      archivedAt: null,
    });
  });
});
