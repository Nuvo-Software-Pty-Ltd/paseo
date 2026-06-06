import { isCloudHostProfile, type HostProfile } from "@/types/host-connection";

/**
 * Decides whether the welcome screen should auto-redirect into an
 * already-online host. Returns the serverId to redirect to, or null to stay on
 * the welcome screen.
 *
 * Cloud-web onboarding fix: a persisted cloud workspace host auto-connects on
 * boot. If we redirected into it, the "Connect to Orchestra" flow (which pushes
 * /orchestra/setup so the user can pick or create a workspace) would be
 * hijacked — the user would land in their pre-existing workspace and the create
 * path would never call createWorkspace (no POST /api/v1/cloud/workspaces). So
 * on web we suppress the redirect for cloud hosts and let the wizard run.
 * Local/self-host paired hosts keep the original jump-straight-in behavior.
 */
/**
 * Shared predicate: may we auto-route a cold/boot load into this already-online
 * host without user interaction? On web, a cloud workspace host (directTcp +
 * workspaceId) must NOT be auto-entered, otherwise the create-a-new-workspace
 * flow is hijacked (see resolveWelcomeRedirectServerId). Native and non-cloud
 * (relay / local self-host) hosts always keep jump-straight-in behavior.
 *
 * This is the single source of truth used by both the welcome screen
 * (resolveWelcomeRedirectServerId) and the index cold-startup redirect
 * (resolveStartupRedirectRoute in app/host-runtime-bootstrap).
 */
export function isAutoRoutableOnlineHost(input: {
  serverId: string;
  hosts: HostProfile[];
  isWeb: boolean;
}): boolean {
  const { serverId, hosts, isWeb } = input;
  if (!isWeb) return true;
  const onlineHost = hosts.find((h) => h.serverId === serverId);
  return !isCloudHostProfile(onlineHost);
}

export function resolveWelcomeRedirectServerId(input: {
  anyOnlineServerId: string | null;
  hosts: HostProfile[];
  isWeb: boolean;
}): string | null {
  const { anyOnlineServerId, hosts, isWeb } = input;
  if (!anyOnlineServerId) return null;
  if (!isAutoRoutableOnlineHost({ serverId: anyOnlineServerId, hosts, isWeb })) {
    return null;
  }
  return anyOnlineServerId;
}
