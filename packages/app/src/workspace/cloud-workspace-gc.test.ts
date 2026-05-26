import { afterEach, describe, expect, it } from "vitest";

import type { DaemonClient } from "@server/client/daemon-client";

import { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";
import {
  cloudWorkspaceMountPrefix,
  purgeLocalStateForArchivedWorkspace,
  selectAgentIdsForCloudWorkspace,
  selectWorkspaceKeysForCloudWorkspace,
} from "./cloud-workspace-gc";

const SERVER_ID = "cloud-server-1";

function workspace(
  input: Partial<WorkspaceDescriptor> & Pick<WorkspaceDescriptor, "id" | "workspaceDirectory">,
): WorkspaceDescriptor {
  return {
    id: input.id,
    projectId: input.projectId ?? "project-1",
    projectDisplayName: input.projectDisplayName ?? "Project",
    projectRootPath: input.projectRootPath ?? input.workspaceDirectory,
    workspaceDirectory: input.workspaceDirectory,
    projectKind: input.projectKind ?? "git",
    workspaceKind: input.workspaceKind ?? "checkout",
    name: input.name ?? "main",
    status: input.status ?? "running",
    archivingAt: input.archivingAt ?? null,
    diffStat: input.diffStat ?? null,
    scripts: input.scripts ?? [],
  };
}

function agent(input: Partial<Agent> & Pick<Agent, "id" | "cwd">): Agent {
  return {
    serverId: SERVER_ID,
    id: input.id,
    provider: "claude_code",
    status: "running",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastUserMessageAt: null,
    lastActivityAt: new Date(),
    capabilities: {} as Agent["capabilities"],
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    cwd: input.cwd,
    model: null,
    parentAgentId: null,
    labels: {},
  };
}

function seedSession(): void {
  useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
}

afterEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
});

describe("cloudWorkspaceMountPrefix", () => {
  it("matches the canonical mount the daemon container exposes", () => {
    expect(cloudWorkspaceMountPrefix("ws_abc")).toBe("/workspace/ws_abc/");
  });
});

describe("selectWorkspaceKeysForCloudWorkspace", () => {
  it("picks workspaces under the cloud workspace's mount, leaves others alone", () => {
    const workspaces = new Map<string, WorkspaceDescriptor>([
      ["w1", workspace({ id: "w1", workspaceDirectory: "/workspace/ws_aaa/.git-canonical" })],
      ["w2", workspace({ id: "w2", workspaceDirectory: "/workspace/ws_bbb/.git-canonical" })],
      ["w3", workspace({ id: "w3", workspaceDirectory: "/workspace/ws_aaa/feature-branch" })],
    ]);
    const keys = selectWorkspaceKeysForCloudWorkspace(workspaces, "ws_aaa");
    expect(keys.sort()).toEqual(["w1", "w3"]);
  });
});

describe("selectAgentIdsForCloudWorkspace", () => {
  it("picks agents whose cwd is rooted in the workspace mount", () => {
    const agents = new Map<string, Agent>([
      ["a1", agent({ id: "a1", cwd: "/workspace/ws_aaa/.git-canonical" })],
      ["a2", agent({ id: "a2", cwd: "/workspace/ws_bbb/.git-canonical" })],
      ["a3", agent({ id: "a3", cwd: "/workspace/ws_aaa/feature/src" })],
    ]);
    const ids = selectAgentIdsForCloudWorkspace(agents, "ws_aaa");
    expect(ids.sort()).toEqual(["a1", "a3"]);
  });
});

describe("purgeLocalStateForArchivedWorkspace", () => {
  it("removes only the archived workspace's descriptors and agents, leaves siblings intact", () => {
    seedSession();
    const store = useSessionStore.getState();
    store.setWorkspaces(SERVER_ID, (prev) => {
      const next = new Map(prev);
      next.set(
        "ws_aaa-main",
        workspace({ id: "ws_aaa-main", workspaceDirectory: "/workspace/ws_aaa/.git-canonical" }),
      );
      next.set(
        "ws_bbb-main",
        workspace({ id: "ws_bbb-main", workspaceDirectory: "/workspace/ws_bbb/.git-canonical" }),
      );
      return next;
    });
    store.setAgents(SERVER_ID, (prev) => {
      const next = new Map(prev);
      next.set("agent-aaa", agent({ id: "agent-aaa", cwd: "/workspace/ws_aaa/.git-canonical" }));
      next.set("agent-bbb", agent({ id: "agent-bbb", cwd: "/workspace/ws_bbb/.git-canonical" }));
      return next;
    });

    purgeLocalStateForArchivedWorkspace({ serverId: SERVER_ID, cloudWorkspaceId: "ws_aaa" });

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect([...session.workspaces.keys()]).toEqual(["ws_bbb-main"]);
    expect([...session.agents.keys()]).toEqual(["agent-bbb"]);
  });

  it("is idempotent: a second call is a no-op", () => {
    seedSession();
    const store = useSessionStore.getState();
    store.setWorkspaces(SERVER_ID, (prev) => {
      const next = new Map(prev);
      next.set(
        "ws_aaa-main",
        workspace({ id: "ws_aaa-main", workspaceDirectory: "/workspace/ws_aaa/.git-canonical" }),
      );
      return next;
    });

    purgeLocalStateForArchivedWorkspace({ serverId: SERVER_ID, cloudWorkspaceId: "ws_aaa" });
    const sessionAfterFirst = useSessionStore.getState().sessions[SERVER_ID];
    expect([...sessionAfterFirst.workspaces.keys()]).toEqual([]);

    purgeLocalStateForArchivedWorkspace({ serverId: SERVER_ID, cloudWorkspaceId: "ws_aaa" });
    const sessionAfterSecond = useSessionStore.getState().sessions[SERVER_ID];
    expect(sessionAfterSecond).toBe(sessionAfterFirst);
  });

  it("ignores empty inputs (no thrown error)", () => {
    seedSession();
    purgeLocalStateForArchivedWorkspace({ serverId: "", cloudWorkspaceId: "ws_aaa" });
    purgeLocalStateForArchivedWorkspace({ serverId: SERVER_ID, cloudWorkspaceId: "" });
  });

  it("handles the D-1.5 two-worktree drift shape: two descriptors under one daemon, archive one", () => {
    // Reproduces LEARNINGS.md 2026-05-22 § "Surprising": the agora workspace
    // was deleted + recreated with a new ws_id; the old entry lingered next
    // to the new one. With multiple cloud workspaces on the same daemon this
    // is the failure mode.
    seedSession();
    const store = useSessionStore.getState();
    store.setWorkspaces(SERVER_ID, (prev) => {
      const next = new Map(prev);
      // "old" workspace lingering under the to-be-archived cloud workspace
      next.set(
        "ws_aaa-stale",
        workspace({
          id: "ws_aaa-stale",
          workspaceDirectory: "/workspace/ws_aaa/.git-canonical",
          name: "main (stale)",
        }),
      );
      // fresh workspace on the same daemon, different cloud workspace
      next.set(
        "ws_bbb-main",
        workspace({
          id: "ws_bbb-main",
          workspaceDirectory: "/workspace/ws_bbb/.git-canonical",
          name: "main",
        }),
      );
      return next;
    });

    purgeLocalStateForArchivedWorkspace({ serverId: SERVER_ID, cloudWorkspaceId: "ws_aaa" });

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect([...session.workspaces.keys()]).toEqual(["ws_bbb-main"]);
  });
});
