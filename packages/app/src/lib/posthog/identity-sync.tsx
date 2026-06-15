// Ties PostHog events to the signed-in Orchestra account. Reads the cloud
// workspaces already cached by react-query (CLOUD_WORKSPACES_QUERY_KEY) rather
// than firing its own authed request, so a signed-out user never triggers a
// listWorkspaces() 401 / session-expired bounce. accountId is present on every
// WorkspaceRecord. Resets identity when the session expires / signs out.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { CLOUD_WORKSPACES_QUERY_KEY } from "@/hooks/use-cloud-workspaces";
import { onOrchestraSessionExpired, type WorkspaceRecord } from "@/lib/orchestra-cloud-client";
import { analytics } from "./analytics";

export function AnalyticsIdentitySync() {
  const queryClient = useQueryClient();
  const identifiedRef = useRef<string | null>(null);

  useEffect(() => {
    function sync() {
      const list = queryClient.getQueryData<WorkspaceRecord[]>(CLOUD_WORKSPACES_QUERY_KEY);
      const accountId = list?.find((workspace) => workspace.accountId)?.accountId;
      if (accountId && identifiedRef.current !== accountId) {
        identifiedRef.current = accountId;
        analytics.identify(accountId, { workspace_count: list?.length ?? 0 });
        analytics.register({ account_id: accountId });
      }
    }

    sync();
    const unsubscribeCache = queryClient.getQueryCache().subscribe(sync);
    const unsubscribeExpired = onOrchestraSessionExpired(() => {
      identifiedRef.current = null;
      analytics.reset();
    });

    return () => {
      unsubscribeCache();
      unsubscribeExpired();
    };
  }, [queryClient]);

  return null;
}
