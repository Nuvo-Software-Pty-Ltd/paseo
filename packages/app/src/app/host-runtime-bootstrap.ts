import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import type { DaemonStartResult } from "@/runtime/daemon-start-service";
import type { Href } from "expo-router";
import type { HostProfile } from "@/types/host-connection";
import { buildHostRootRoute } from "@/utils/host-routes";
import { isAutoRoutableOnlineHost } from "@/components/welcome-redirect";

export interface HostRuntimeBootstrapStore {
  boot: () => void;
}

export interface HostRuntimeBootstrapDaemonStartService {
  start: () => Promise<DaemonStartResult>;
}

type HostRuntimeBootstrapStartGate = boolean | (() => boolean | Promise<boolean>);

export interface StartHostRuntimeBootstrapInput {
  store: HostRuntimeBootstrapStore;
  daemonStartService: HostRuntimeBootstrapDaemonStartService;
  shouldStartDaemon: HostRuntimeBootstrapStartGate;
  onGateError?: (message: string) => void;
}

export function startHostRuntimeBootstrap(input: StartHostRuntimeBootstrapInput): void {
  input.store.boot();
  startDaemonIfGateAllows({
    daemonStartService: input.daemonStartService,
    shouldStartDaemon: input.shouldStartDaemon,
    onGateError: input.onGateError,
  });
}

export function startDaemonIfGateAllows(input: {
  daemonStartService: HostRuntimeBootstrapDaemonStartService;
  shouldStartDaemon: HostRuntimeBootstrapStartGate;
  onGateError?: (message: string) => void;
}): void {
  const gate = input.shouldStartDaemon;
  if (typeof gate === "boolean") {
    if (gate) {
      void input.daemonStartService.start();
    }
    return;
  }

  void Promise.resolve()
    .then(() => gate())
    .then((shouldStartDaemon) => {
      if (shouldStartDaemon) {
        void input.daemonStartService.start();
      }
      return null;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      input.onGateError?.(`Failed to evaluate desktop daemon settings: ${message}`);
    });
}

export const WELCOME_ROUTE: Href = "/welcome";

export interface ResolveStartupRedirectInput {
  pathname: string;
  anyOnlineHostServerId: string | null;
  workspaceSelection: ActiveWorkspaceSelection | null;
  isWorkspaceSelectionLoaded: boolean;
  hasGivenUpWaitingForHost: boolean;
  // Host registry + platform, used to decide whether an online host may be
  // auto-entered on cold load. Optional for back-compat with callers/tests that
  // don't gate (treated as "always auto-routable").
  hosts?: HostProfile[];
  isWeb?: boolean;
}

/**
 * Whether the online host (if any) may be auto-entered on a cold load. On web a
 * cloud workspace host must not be auto-entered, otherwise the cold SPA reload
 * bounces the user into their existing workspace and the create-a-new-workspace
 * wizard (POST /api/v1/cloud/workspaces) is never reachable. Shares the
 * predicate with the welcome screen via isAutoRoutableOnlineHost.
 */
function canAutoRouteOnlineHost(input: ResolveStartupRedirectInput): boolean {
  if (!input.anyOnlineHostServerId) return false;
  return isAutoRoutableOnlineHost({
    serverId: input.anyOnlineHostServerId,
    hosts: input.hosts ?? [],
    isWeb: input.isWeb ?? false,
  });
}

function isIndexPathname(pathname: string) {
  return pathname === "/" || pathname === "";
}

export function resolveStartupWorkspaceSelection(
  input: ResolveStartupRedirectInput,
): ActiveWorkspaceSelection | null {
  if (!isIndexPathname(input.pathname)) {
    return null;
  }
  if (!input.isWorkspaceSelectionLoaded) {
    return null;
  }
  if (
    !input.anyOnlineHostServerId ||
    !input.workspaceSelection ||
    input.workspaceSelection.serverId !== input.anyOnlineHostServerId
  ) {
    return null;
  }
  // Don't auto-enter a non-auto-routable host (cloud host on web): doing so
  // would bypass the create-a-new-workspace wizard on cold load.
  if (!canAutoRouteOnlineHost(input)) {
    return null;
  }
  return input.workspaceSelection;
}

export function resolveStartupRedirectRoute(input: ResolveStartupRedirectInput): Href | null {
  if (!isIndexPathname(input.pathname)) {
    return null;
  }
  if (!input.isWorkspaceSelectionLoaded) {
    return null;
  }

  if (input.anyOnlineHostServerId) {
    // Cloud host on web: don't auto-enter it on cold load. Send the user to the
    // welcome screen so the "Connect to Orchestra" → /orchestra/setup create
    // wizard stays reachable instead of bouncing into the existing workspace.
    if (!canAutoRouteOnlineHost(input)) {
      return WELCOME_ROUTE;
    }
    if (resolveStartupWorkspaceSelection(input)) {
      return null;
    }
    return buildHostRootRoute(input.anyOnlineHostServerId);
  }

  if (input.hasGivenUpWaitingForHost) {
    return WELCOME_ROUTE;
  }

  return null;
}
