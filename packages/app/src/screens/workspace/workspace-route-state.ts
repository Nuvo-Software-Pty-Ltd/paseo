import type { CloudWorkspaceState } from "@/lib/orchestra-cloud-client";
import type { HostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import type { WorkspaceDescriptor } from "@/stores/session-store";

export type WorkspaceRouteState =
  | { kind: "ready" }
  | {
      kind: "reconnecting";
      hostName: string;
      connectionStatus: Exclude<HostRuntimeConnectionStatus, "online">;
      lastError: string | null;
    }
  | {
      kind: "unreachable";
      hostName: string;
      connectionStatus: Exclude<HostRuntimeConnectionStatus, "online">;
      lastError: string | null;
    }
  | { kind: "loading"; hostName: string }
  | { kind: "restoring"; hostName: string }
  | { kind: "needsHostUpgrade"; hostName: string }
  | { kind: "missing"; hostName: string; restoreFailed: boolean }
  | { kind: "cold-resume"; hostName: string }
  | { kind: "billing-locked"; hostName: string };

export interface ResolveWorkspaceRouteStateInput {
  hostName: string;
  connectionStatus: HostRuntimeConnectionStatus;
  lastError: string | null;
  workspace: WorkspaceDescriptor | null;
  hasHydratedWorkspaces: boolean;
  restoreStatus: "restoring" | "failed" | "needs-host-upgrade" | null;
  // Optional cloud-workspace state from useCloudWorkspaces. Only present for
  // cloud-host routes; absent / "active" for on-host. When set:
  //   "billing_locked" short-circuits the gate to the upgrade prompt before
  //     any daemon connection is attempted.
  //   "suspended" surfaces the cold-resume splash while the WS is upgrading.
  cloudWorkspaceState?: CloudWorkspaceState | null;
}

export function resolveWorkspaceRouteState(
  input: ResolveWorkspaceRouteStateInput,
): WorkspaceRouteState {
  // Billing-locked short-circuits everything else: do not attempt a daemon
  // connection. The picker still shows the workspace row; this is the
  // "you can see it but can't open it" state.
  if (input.cloudWorkspaceState === "billing_locked") {
    return { kind: "billing-locked", hostName: input.hostName };
  }

  // Cold-resume: the user clicked a suspended workspace; the lifecycle
  // worker is bringing the container back. Splash holds until either the
  // state flips to active OR the WS upgrade succeeds (whichever fires
  // first). The OR is load-bearing — see R3 in the plan.
  // Two independent exit signals end the splash — whichever fires first:
  //   * cloudWorkspaceState flips off "suspended" (lifecycle worker wrote
  //     "active" after RunTask), OR
  //   * connectionStatus reaches "online" (WS upgrade succeeded).
  // The OR is load-bearing — see R3 in the plan. Holding the splash above
  // the workspace shell prevents the empty-frame flicker on sub-second
  // resumes (plan acceptance criterion).
  if (input.cloudWorkspaceState === "suspended" && input.connectionStatus !== "online") {
    return { kind: "cold-resume", hostName: input.hostName };
  }

  if (input.workspace) {
    if (input.connectionStatus === "online") {
      return { kind: "ready" };
    }

    return {
      kind: "reconnecting",
      hostName: input.hostName,
      connectionStatus: input.connectionStatus,
      lastError: input.lastError,
    };
  }

  if (input.connectionStatus === "online") {
    if (input.restoreStatus === "restoring") {
      return { kind: "restoring", hostName: input.hostName };
    }

    if (input.restoreStatus === "needs-host-upgrade") {
      return { kind: "needsHostUpgrade", hostName: input.hostName };
    }

    if (input.hasHydratedWorkspaces) {
      return {
        kind: "missing",
        hostName: input.hostName,
        restoreFailed: input.restoreStatus === "failed",
      };
    }

    return { kind: "loading", hostName: input.hostName };
  }

  return {
    kind: "unreachable",
    hostName: input.hostName,
    connectionStatus: input.connectionStatus,
    lastError: input.lastError,
  };
}
