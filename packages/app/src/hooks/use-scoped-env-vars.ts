import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { i18n } from "@/i18n/i18next";

// D-3.5c — client-side access to the scoped env-var RPCs. One typed
// loader/cache keyed by (serverId, scope, scopeId) so both the
// workspace-scoped and project-scoped editors share fetch/invalidate logic.

export type ScopedEnvVarScope = "workspace" | "project";

export interface ScopedEnvVarView {
  key: string;
  value: string;
  secret?: boolean;
  updatedAt: string;
}

type SetScopedEnvVarResult = { ok: true } | { ok: false; code: string | undefined };

// COMPAT(scopedEnvVars): the daemon advertises features.scopedEnvVars when
// it supports the RPCs. An old daemon (no flag) → editors show
// "Update the host to use this." Drop this gate when the floor >= v0.1.74.
export function useScopedEnvVarsSupported(serverId: string | undefined): boolean {
  return useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.scopedEnvVars === true,
  );
}

function envVarsQueryKey(serverId: string, scope: ScopedEnvVarScope, scopeId: string) {
  return ["scoped-env-vars", serverId, scope, scopeId] as const;
}

async function fetchScopedEnvVars(
  client: DaemonClient,
  scope: ScopedEnvVarScope,
  scopeId: string,
): Promise<ScopedEnvVarView[]> {
  const payload = await client.listScopedEnvVars({ scope, scopeId });
  if (!payload.ok) {
    throw new Error(payload.error.message ?? payload.error.code);
  }
  return payload.vars;
}

export interface UseScopedEnvVarsResult {
  vars: ScopedEnvVarView[];
  isLoading: boolean;
  isError: boolean;
  setVar: (input: {
    key: string;
    value: string;
    secret?: boolean;
  }) => Promise<SetScopedEnvVarResult>;
  deleteVar: (key: string) => Promise<void>;
  refetch: () => void;
}

export function useScopedEnvVars(input: {
  serverId: string;
  scope: ScopedEnvVarScope;
  scopeId: string;
  enabled?: boolean;
}): UseScopedEnvVarsResult {
  const { serverId, scope, scopeId, enabled = true } = input;
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const queryKey = envVarsQueryKey(serverId, scope, scopeId);

  const query = useQuery({
    queryKey,
    enabled: enabled && Boolean(client) && Boolean(scopeId),
    queryFn: () => {
      if (!client) {
        throw new Error(i18n.t("common.errors.daemonClientUnavailable"));
      }
      return fetchScopedEnvVars(client, scope, scopeId);
    },
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  const setMutation = useMutation({
    mutationFn: async (vars: { key: string; value: string; secret?: boolean }) => {
      if (!client) {
        throw new Error(i18n.t("common.errors.daemonClientUnavailable"));
      }
      return client.setScopedEnvVar({ scope, scopeId, ...vars });
    },
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: async (key: string) => {
      if (!client) {
        throw new Error(i18n.t("common.errors.daemonClientUnavailable"));
      }
      return client.deleteScopedEnvVar({ scope, scopeId, key });
    },
    onSuccess: invalidate,
  });

  const setVar = useCallback(
    async (vars: {
      key: string;
      value: string;
      secret?: boolean;
    }): Promise<SetScopedEnvVarResult> => {
      const payload = await setMutation.mutateAsync(vars);
      if (payload.ok) {
        return { ok: true };
      }
      return { ok: false, code: payload.error.code };
    },
    [setMutation],
  );

  const deleteVar = useCallback(
    async (key: string): Promise<void> => {
      await deleteMutation.mutateAsync(key);
    },
    [deleteMutation],
  );

  return {
    vars: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    setVar,
    deleteVar,
    refetch: invalidate,
  };
}
