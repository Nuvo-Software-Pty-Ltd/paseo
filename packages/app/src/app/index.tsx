import React from "react";
import { Redirect, usePathname } from "expo-router";
import { StartupSplashScreen } from "@/screens/startup-splash-screen";
import { useEarliestOnlineHostServerId, useHostRuntimeBootstrapState } from "@/app/_layout";
import {
  resolveStartupRedirectRoute,
  resolveStartupWorkspaceSelection,
} from "@/app/host-runtime-bootstrap";
import {
  navigateToWorkspace,
  useActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { shouldUseDesktopDaemon } from "@/desktop/daemon/desktop-daemon";
import { useHosts } from "@/runtime/host-runtime";
import { isWeb } from "@/constants/platform";

const isDesktop = shouldUseDesktopDaemon();

export default function Index() {
  const pathname = usePathname();
  const bootstrapState = useHostRuntimeBootstrapState();
  const anyOnlineHostServerId = useEarliestOnlineHostServerId();
  const workspaceSelection = useActiveWorkspaceSelection();
  const hosts = useHosts();

  const redirectRoute = resolveStartupRedirectRoute({
    pathname,
    anyOnlineHostServerId,
    workspaceSelection,
    isWorkspaceSelectionLoaded: true,
    hasGivenUpWaitingForHost: bootstrapState.hasGivenUpWaitingForHost,
    hosts,
    isWeb,
  });
  const startupWorkspaceSelection = resolveStartupWorkspaceSelection({
    pathname,
    anyOnlineHostServerId,
    workspaceSelection,
    isWorkspaceSelectionLoaded: true,
    hasGivenUpWaitingForHost: bootstrapState.hasGivenUpWaitingForHost,
    hosts,
    isWeb,
  });

  React.useEffect(() => {
    if (!startupWorkspaceSelection) {
      return;
    }
    navigateToWorkspace(startupWorkspaceSelection.serverId, startupWorkspaceSelection.workspaceId, {
      currentPathname: pathname,
    });
  }, [pathname, startupWorkspaceSelection]);

  if (startupWorkspaceSelection) {
    return <StartupSplashScreen bootstrapState={isDesktop ? bootstrapState : undefined} />;
  }

  if (redirectRoute) {
    return <Redirect href={redirectRoute} />;
  }

  return <StartupSplashScreen bootstrapState={isDesktop ? bootstrapState : undefined} />;
}
