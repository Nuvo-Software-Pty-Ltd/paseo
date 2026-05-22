import { describe, expect, it } from "vitest";
import type { CloudWorkspaceState, WorkspaceRecord } from "@/lib/orchestra-cloud-client";
import {
  filterChoosableWorkspaces,
  setupHeaderTitle,
  shouldShowWorkspaceChooser,
} from "./orchestra-setup-helpers";

function workspace(input: { workspaceId: string; state?: CloudWorkspaceState }): WorkspaceRecord {
  return {
    workspaceId: input.workspaceId,
    accountId: "acct_1",
    repoUrl: null,
    displayName: input.workspaceId,
    status: "ready",
    createdAt: "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:00:00.000Z",
    state: input.state ?? "active",
    archivedAt: null,
  };
}

describe("filterChoosableWorkspaces", () => {
  it("drops archived workspaces; keeps active / suspended / billing_locked", () => {
    const result = filterChoosableWorkspaces([
      workspace({ workspaceId: "ws_a", state: "active" }),
      workspace({ workspaceId: "ws_s", state: "suspended" }),
      workspace({ workspaceId: "ws_b", state: "billing_locked" }),
      workspace({ workspaceId: "ws_x", state: "archived" }),
    ]);
    expect(result.map((entry) => entry.workspaceId)).toEqual(["ws_a", "ws_s", "ws_b"]);
  });
});

describe("shouldShowWorkspaceChooser", () => {
  it("renders chooser when on workspace step + auto view + at least one choosable", () => {
    expect(
      shouldShowWorkspaceChooser("workspace", "auto", [workspace({ workspaceId: "ws_a" })]),
    ).toBe(true);
  });

  it("renders form (not chooser) when zero choosable workspaces — D-1 happy path", () => {
    expect(shouldShowWorkspaceChooser("workspace", "auto", [])).toBe(false);
  });

  it("renders form when the user explicitly switched to create view from the chooser", () => {
    expect(
      shouldShowWorkspaceChooser("workspace", "create", [workspace({ workspaceId: "ws_a" })]),
    ).toBe(false);
  });

  it("returns false for any non-workspace step", () => {
    expect(
      shouldShowWorkspaceChooser("credential", "auto", [workspace({ workspaceId: "ws_a" })]),
    ).toBe(false);
  });
});

describe("setupHeaderTitle", () => {
  it("switches the workspace-step title between Choose and Create", () => {
    expect(setupHeaderTitle("workspace", true)).toBe("Choose a workspace");
    expect(setupHeaderTitle("workspace", false)).toBe("Create workspace");
  });

  it("ignores the chooser flag for downstream steps", () => {
    expect(setupHeaderTitle("credential", true)).toBe("Anthropic API key");
    expect(setupHeaderTitle("connecting", false)).toBe("Connecting...");
    expect(setupHeaderTitle("done", false)).toBe("Connected");
  });
});
