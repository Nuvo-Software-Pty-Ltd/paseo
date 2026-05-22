import { describe, expect, it } from "vitest";
import type { CloudWorkspaceState, WorkspaceRecord } from "@/lib/orchestra-cloud-client";
import { partitionCloudWorkspaces } from "./cloud-workspace-sections";

function workspace(input: {
  workspaceId: string;
  state?: CloudWorkspaceState;
  archivedAt?: string | null;
}): WorkspaceRecord {
  return {
    workspaceId: input.workspaceId,
    accountId: "acct_1",
    repoUrl: null,
    displayName: input.workspaceId,
    status: "ready",
    createdAt: "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:00:00.000Z",
    state: input.state ?? "active",
    archivedAt: input.archivedAt ?? null,
  };
}

describe("partitionCloudWorkspaces", () => {
  it("puts only archived workspaces in the archived bucket", () => {
    const { activeCloudWorkspaces, archivedCloudWorkspaces } = partitionCloudWorkspaces([
      workspace({ workspaceId: "ws_a", state: "active" }),
      workspace({ workspaceId: "ws_s", state: "suspended" }),
      workspace({ workspaceId: "ws_b", state: "billing_locked" }),
      workspace({
        workspaceId: "ws_x",
        state: "archived",
        archivedAt: "2026-05-20T00:00:00.000Z",
      }),
    ]);

    expect(activeCloudWorkspaces.map((w) => w.workspaceId)).toEqual(["ws_a", "ws_s", "ws_b"]);
    expect(archivedCloudWorkspaces.map((w) => w.workspaceId)).toEqual(["ws_x"]);
  });

  it("preserves input order within each section", () => {
    const { activeCloudWorkspaces, archivedCloudWorkspaces } = partitionCloudWorkspaces([
      workspace({ workspaceId: "ws_first" }),
      workspace({ workspaceId: "ws_arch1", state: "archived" }),
      workspace({ workspaceId: "ws_second" }),
      workspace({ workspaceId: "ws_arch2", state: "archived" }),
    ]);
    expect(activeCloudWorkspaces.map((w) => w.workspaceId)).toEqual(["ws_first", "ws_second"]);
    expect(archivedCloudWorkspaces.map((w) => w.workspaceId)).toEqual(["ws_arch1", "ws_arch2"]);
  });

  it("returns two empty arrays for an empty input", () => {
    const result = partitionCloudWorkspaces([]);
    expect(result.activeCloudWorkspaces).toEqual([]);
    expect(result.archivedCloudWorkspaces).toEqual([]);
  });
});
