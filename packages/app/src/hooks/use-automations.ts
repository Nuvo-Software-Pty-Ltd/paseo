import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateScheduleOptions,
  CreateTriggerOptions,
  UpdateScheduleOptions,
  UpdateTriggerOptions,
} from "@getpaseo/client/internal/daemon-client";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import type { WebhookTriggerSummary } from "@getpaseo/protocol/trigger/types";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { type Automation, mergeAutomations } from "@/lib/automations/automation-model";
import { i18n } from "@/i18n/i18next";

export function schedulesQueryKey(serverId: string | null) {
  return ["automations", "schedules", serverId] as const;
}

export function webhookTriggersQueryKey(serverId: string | null) {
  return ["automations", "webhooks", serverId] as const;
}

// COMPAT(webhookTriggers): added in v0.1.74. The webhook automation surface is
// gated on a single daemon capability flag. When absent we never list/create
// webhooks; the GUI shows schedules only. Drop the gate when floor >= v0.1.74.
export function useWebhookTriggersFeatureFlag(serverId: string | null): boolean {
  return useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.webhookTriggers === true,
  );
}

interface UseSchedulesResult {
  schedules: ScheduleSummary[];
  error: string | null;
  isLoading: boolean;
  isFetching: boolean;
}

export function useSchedules(serverId: string | null): UseSchedulesResult {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const queryKey = useMemo(() => schedulesQueryKey(serverId), [serverId]);

  const query = useQuery({
    queryKey,
    enabled: Boolean(serverId && client && isConnected),
    staleTime: 30_000,
    queryFn: async () => {
      if (!client) {
        throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
      }
      return client.scheduleList();
    },
  });

  return {
    schedules: query.data?.schedules ?? [],
    error: query.data?.error ?? (query.error instanceof Error ? query.error.message : null),
    isLoading: query.isLoading,
    isFetching: query.isFetching,
  };
}

interface UseWebhookTriggersResult {
  triggers: WebhookTriggerSummary[];
  error: string | null;
  isLoading: boolean;
  isFetching: boolean;
  supported: boolean;
}

export function useWebhookTriggers(serverId: string | null): UseWebhookTriggersResult {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const supported = useWebhookTriggersFeatureFlag(serverId);
  const queryKey = useMemo(() => webhookTriggersQueryKey(serverId), [serverId]);

  const query = useQuery({
    queryKey,
    enabled: Boolean(supported && serverId && client && isConnected),
    staleTime: 30_000,
    queryFn: async () => {
      if (!client) {
        throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
      }
      return client.triggerList();
    },
  });

  return {
    triggers: supported ? (query.data?.triggers ?? []) : [],
    error: supported
      ? (query.data?.error ?? (query.error instanceof Error ? query.error.message : null))
      : null,
    isLoading: supported ? query.isLoading : false,
    isFetching: supported ? query.isFetching : false,
    supported,
  };
}

interface UseAutomationsResult {
  automations: Automation[];
  error: string | null;
  isLoading: boolean;
  isFetching: boolean;
  webhookTriggersSupported: boolean;
}

export function useAutomations(serverId: string | null): UseAutomationsResult {
  const schedulesResult = useSchedules(serverId);
  const webhooksResult = useWebhookTriggers(serverId);

  const automations = useMemo(
    () => mergeAutomations(schedulesResult.schedules, webhooksResult.triggers),
    [schedulesResult.schedules, webhooksResult.triggers],
  );

  return {
    automations,
    error: schedulesResult.error ?? webhooksResult.error,
    isLoading: schedulesResult.isLoading || webhooksResult.isLoading,
    isFetching: schedulesResult.isFetching || webhooksResult.isFetching,
    webhookTriggersSupported: webhooksResult.supported,
  };
}

// --- Mutations -------------------------------------------------------------
//
// Each mutation requires a connected client; on success it invalidates the
// serverId-scoped query key for the kind it touched so the list/detail refetch.

function useRequireClient(serverId: string | null) {
  const client = useHostRuntimeClient(serverId ?? "");
  return client;
}

export function useCreateSchedule(serverId: string | null) {
  const client = useRequireClient(serverId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<CreateScheduleOptions, "requestId">) => {
      if (!client) {
        throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
      }
      return client.scheduleCreate(input);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: schedulesQueryKey(serverId) });
    },
  });
}

export function useCreateWebhookTrigger(serverId: string | null) {
  const client = useRequireClient(serverId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<CreateTriggerOptions, "requestId">) => {
      if (!client) {
        throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
      }
      return client.triggerCreate(input);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: webhookTriggersQueryKey(serverId) });
    },
  });
}

export function useUpdateSchedule(serverId: string | null) {
  const client = useRequireClient(serverId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<UpdateScheduleOptions, "requestId">) => {
      if (!client) {
        throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
      }
      return client.scheduleUpdate(input);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: schedulesQueryKey(serverId) });
    },
  });
}

export function useUpdateWebhookTrigger(serverId: string | null) {
  const client = useRequireClient(serverId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<UpdateTriggerOptions, "requestId">) => {
      if (!client) {
        throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
      }
      return client.triggerUpdate(input);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: webhookTriggersQueryKey(serverId) });
    },
  });
}

export function usePauseSchedule(serverId: string | null) {
  const client = useRequireClient(serverId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!client) {
        throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
      }
      return client.schedulePause({ id });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: schedulesQueryKey(serverId) });
    },
  });
}

export function useResumeSchedule(serverId: string | null) {
  const client = useRequireClient(serverId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!client) {
        throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
      }
      return client.scheduleResume({ id });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: schedulesQueryKey(serverId) });
    },
  });
}

export function useRunScheduleOnce(serverId: string | null) {
  const client = useRequireClient(serverId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!client) {
        throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
      }
      return client.scheduleRunOnce({ id });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: schedulesQueryKey(serverId) });
    },
  });
}

export function useRunTriggerOnce(serverId: string | null) {
  const client = useRequireClient(serverId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; payload?: unknown }) => {
      if (!client) {
        throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
      }
      return client.triggerRunOnce(input);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: webhookTriggersQueryKey(serverId) });
    },
  });
}

export function useRotateWebhookSecret(serverId: string | null) {
  const client = useRequireClient(serverId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!client) {
        throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
      }
      return client.triggerRotateSecret({ id });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: webhookTriggersQueryKey(serverId) });
    },
  });
}

export function useDeleteAutomation(serverId: string | null) {
  const client = useRequireClient(serverId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; kind: Automation["kind"] }) => {
      if (!client) {
        throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
      }
      if (input.kind === "schedule") {
        return client.scheduleDelete({ id: input.id });
      }
      return client.triggerDelete({ id: input.id });
    },
    onSuccess: (_result, input) => {
      const queryKey =
        input.kind === "schedule" ? schedulesQueryKey(serverId) : webhookTriggersQueryKey(serverId);
      void queryClient.invalidateQueries({ queryKey });
    },
  });
}
