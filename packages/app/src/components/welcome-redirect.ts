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
export function resolveWelcomeRedirectServerId(input: {
  anyOnlineServerId: string | null;
  hosts: HostProfile[];
  isWeb: boolean;
}): string | null {
  const { anyOnlineServerId, hosts, isWeb } = input;
  if (!anyOnlineServerId) return null;
  if (isWeb) {
    const onlineHost = hosts.find((h) => h.serverId === anyOnlineServerId);
    if (isCloudHostProfile(onlineHost)) return null;
  }
  return anyOnlineServerId;
}
