import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { resolveWorkspaceRouteState } from "./workspace-route-state";

function createWorkspaceDescriptor(): WorkspaceDescriptor {
  return {
    id: "workspace-1",
    projectId: "project-1",
    projectDisplayName: "Project",
    projectRootPath: "/repo/project",
    workspaceDirectory: "/repo/project",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    status: "running",
    diffStat: null,
    scripts: [],
    archivingAt: null,
    statusEnteredAt: null,
  };
}

describe("resolveWorkspaceRouteState", () => {
  it("returns unreachable when no descriptor is cached and the host is offline", () => {
    expect(
      resolveWorkspaceRouteState({
        hostName: "Laptop",
        connectionStatus: "offline",
        lastError: "transport closed",
        workspace: null,
        hasHydratedWorkspaces: false,
        restoreStatus: null,
      }),
    ).toEqual({
      kind: "unreachable",
      hostName: "Laptop",
      connectionStatus: "offline",
      lastError: "transport closed",
    });
  });

  it("keeps offline routes unreachable after workspace hydration", () => {
    expect(
      resolveWorkspaceRouteState({
        hostName: "Laptop",
        connectionStatus: "offline",
        lastError: "transport closed",
        workspace: null,
        hasHydratedWorkspaces: true,
        restoreStatus: null,
      }),
    ).toEqual({
      kind: "unreachable",
      hostName: "Laptop",
      connectionStatus: "offline",
      lastError: "transport closed",
    });
  });

  it("returns reconnecting when the descriptor is cached and the host is offline", () => {
    expect(
      resolveWorkspaceRouteState({
        hostName: "Laptop",
        connectionStatus: "offline",
        lastError: "transport closed",
        workspace: createWorkspaceDescriptor(),
        hasHydratedWorkspaces: true,
        restoreStatus: null,
      }),
    ).toEqual({
      kind: "reconnecting",
      hostName: "Laptop",
      connectionStatus: "offline",
      lastError: "transport closed",
    });
  });

  it("returns missing after workspace hydration when the host is online", () => {
    expect(
      resolveWorkspaceRouteState({
        hostName: "Laptop",
        connectionStatus: "online",
        lastError: null,
        workspace: null,
        hasHydratedWorkspaces: true,
        restoreStatus: null,
      }),
    ).toEqual({ kind: "missing", hostName: "Laptop", restoreFailed: false });
  });

  it("returns loading before workspace hydration when the host is online", () => {
    expect(
      resolveWorkspaceRouteState({
        hostName: "Laptop",
        connectionStatus: "online",
        lastError: null,
        workspace: null,
        hasHydratedWorkspaces: false,
        restoreStatus: null,
      }),
    ).toEqual({ kind: "loading", hostName: "Laptop" });
  });

  it("returns ready when the host is online and the descriptor exists", () => {
    expect(
      resolveWorkspaceRouteState({
        hostName: "Laptop",
        connectionStatus: "online",
        lastError: null,
        workspace: createWorkspaceDescriptor(),
        hasHydratedWorkspaces: true,
        restoreStatus: null,
      }),
    ).toEqual({ kind: "ready" });
  });

  it("returns restoring while an archived workspace restore is in flight", () => {
    expect(
      resolveWorkspaceRouteState({
        hostName: "Laptop",
        connectionStatus: "online",
        lastError: null,
        workspace: null,
        hasHydratedWorkspaces: true,
        restoreStatus: "restoring",
      }),
    ).toEqual({ kind: "restoring", hostName: "Laptop" });
  });

  it("returns needsHostUpgrade when the daemon lacks the restore capability", () => {
    expect(
      resolveWorkspaceRouteState({
        hostName: "Laptop",
        connectionStatus: "online",
        lastError: null,
        workspace: null,
        hasHydratedWorkspaces: true,
        restoreStatus: "needs-host-upgrade",
      }),
    ).toEqual({ kind: "needsHostUpgrade", hostName: "Laptop" });
  });

  it("falls back to a restore-failed missing state once the restore times out", () => {
    expect(
      resolveWorkspaceRouteState({
        hostName: "Laptop",
        connectionStatus: "online",
        lastError: null,
        workspace: null,
        hasHydratedWorkspaces: true,
        restoreStatus: "failed",
      }),
    ).toEqual({ kind: "missing", hostName: "Laptop", restoreFailed: true });
  });

  it("resolves to ready when the descriptor arrives even while restoring", () => {
    expect(
      resolveWorkspaceRouteState({
        hostName: "Laptop",
        connectionStatus: "online",
        lastError: null,
        workspace: createWorkspaceDescriptor(),
        hasHydratedWorkspaces: true,
        restoreStatus: "restoring",
      }),
    ).toEqual({ kind: "ready" });
  });

  describe("cloud workspace state branches", () => {
    it("returns cold-resume when cloud state is 'suspended' and not yet online", () => {
      expect(
        resolveWorkspaceRouteState({
          hostName: "Cloud",
          connectionStatus: "connecting",
          lastError: null,
          workspace: null,
          hasHydratedWorkspaces: false,
          restoreStatus: null,
          cloudWorkspaceState: "suspended",
        }),
      ).toEqual({ kind: "cold-resume", hostName: "Cloud" });
    });

    it("ends the cold-resume splash when connectionStatus reaches 'online' (suspended still cached)", () => {
      // Defensive: even if the suspended→active state flip hasn't refreshed
      // the local cache yet, the WS upgrade going online dismisses the splash.
      expect(
        resolveWorkspaceRouteState({
          hostName: "Cloud",
          connectionStatus: "online",
          lastError: null,
          workspace: createWorkspaceDescriptor(),
          hasHydratedWorkspaces: true,
          restoreStatus: null,
          cloudWorkspaceState: "suspended",
        }),
      ).toEqual({ kind: "ready" });
    });

    it("ends the cold-resume splash when state flips to 'active' (even mid-connect)", () => {
      expect(
        resolveWorkspaceRouteState({
          hostName: "Cloud",
          connectionStatus: "connecting",
          lastError: null,
          workspace: null,
          hasHydratedWorkspaces: false,
          restoreStatus: null,
          cloudWorkspaceState: "active",
        }),
      ).toEqual({
        kind: "unreachable",
        hostName: "Cloud",
        connectionStatus: "connecting",
        lastError: null,
      });
    });

    it("returns billing-locked when cloud state is 'billing_locked' regardless of connection status", () => {
      expect(
        resolveWorkspaceRouteState({
          hostName: "Cloud",
          connectionStatus: "online",
          lastError: null,
          workspace: createWorkspaceDescriptor(),
          hasHydratedWorkspaces: true,
          restoreStatus: null,
          cloudWorkspaceState: "billing_locked",
        }),
      ).toEqual({ kind: "billing-locked", hostName: "Cloud" });
    });

    it("does not regress on-host happy path (cloudWorkspaceState omitted)", () => {
      expect(
        resolveWorkspaceRouteState({
          hostName: "Laptop",
          connectionStatus: "online",
          lastError: null,
          workspace: createWorkspaceDescriptor(),
          hasHydratedWorkspaces: true,
          restoreStatus: null,
        }),
      ).toEqual({ kind: "ready" });
    });
  });
});
