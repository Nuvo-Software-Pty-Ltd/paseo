import { useCallback, useMemo, useState } from "react";
import { Alert, Modal, ScrollView, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AutomationKind } from "@/lib/automations/automation-model";
import {
  type AutomationDetailRecord,
  resolveAutomationDetail,
} from "@/lib/automations/automation-detail-model";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ScheduleRunRow } from "@/components/schedule-failed-run-row";
import { isLastRunFailure } from "@/components/schedule-failed-run-row-model";
import { WebhookSecretReveal } from "@/components/automations/webhook-secret-reveal";
import { WebhookConfigInstructions } from "@/components/automations/webhook-config-instructions";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  schedulesQueryKey,
  useDeleteAutomation,
  usePauseSchedule,
  useResumeSchedule,
  useRotateWebhookSecret,
  useRunScheduleOnce,
  useRunTriggerOnce,
  useUpdateWebhookTrigger,
  useWebhookTriggersFeatureFlag,
  webhookTriggersQueryKey,
} from "@/hooks/use-automations";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { i18n } from "@/i18n/i18next";
import { AutomationCreateForm, type AutomationEditContext } from "./automation-create-form";

const ThemedSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

function automationDetailQueryKey(serverId: string, automationId: string) {
  return ["automations", "detail", serverId, automationId] as const;
}

function detailStatusLabel(detail: AutomationDetailRecord): string {
  if (detail.kind === "schedule") {
    return detail.record.status;
  }
  return detail.record.enabled ? "active" : "disabled";
}

export function AutomationDetailScreen({
  serverId,
  automationId,
  kind,
}: {
  serverId: string;
  automationId: string;
  kind?: AutomationKind;
}) {
  const isFocused = useIsFocused();
  if (!isFocused) {
    return <View style={styles.container} />;
  }
  return (
    <AutomationDetailScreenContent serverId={serverId} automationId={automationId} kind={kind} />
  );
}

function AutomationDetailScreenContent({
  serverId,
  automationId,
  kind,
}: {
  serverId: string;
  automationId: string;
  kind?: AutomationKind;
}) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const queryClient = useQueryClient();
  const webhookSupported = useWebhookTriggersFeatureFlag(serverId);

  const [isEditOpen, setIsEditOpen] = useState(false);
  const [ingressUrlCopied, setIngressUrlCopied] = useState(false);
  const [rotatedSecret, setRotatedSecret] = useState<{
    secret: string;
    ingressUrl: string | null;
  } | null>(null);

  // The kind (carried from the list row) tells us which store to inspect. For
  // kind-less deep links the resolver probes schedule first, falling through to
  // webhook only on a genuine not-found — see `resolveAutomationDetail`.
  const query = useQuery({
    queryKey: automationDetailQueryKey(serverId, automationId),
    enabled: Boolean(serverId && client && isConnected),
    queryFn: async (): Promise<AutomationDetailRecord> => {
      if (!client) {
        throw new Error(i18n.t("workspace.terminal.hostDisconnected"));
      }
      return resolveAutomationDetail({ client, automationId, kind, webhookSupported });
    },
  });

  const invalidateDetail = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: automationDetailQueryKey(serverId, automationId),
    });
    void queryClient.invalidateQueries({ queryKey: schedulesQueryKey(serverId) });
    void queryClient.invalidateQueries({ queryKey: webhookTriggersQueryKey(serverId) });
  }, [automationId, queryClient, serverId]);

  const pauseSchedule = usePauseSchedule(serverId);
  const resumeSchedule = useResumeSchedule(serverId);
  const runScheduleOnce = useRunScheduleOnce(serverId);
  const runTriggerOnce = useRunTriggerOnce(serverId);
  const rotateSecret = useRotateWebhookSecret(serverId);
  const updateWebhook = useUpdateWebhookTrigger(serverId);
  const deleteAutomation = useDeleteAutomation(serverId);

  const detail = query.data;

  const handlePressAgent = useCallback(
    (agentId: string) => {
      router.push(buildHostAgentDetailRoute(serverId, agentId));
    },
    [serverId],
  );

  const handleBack = useCallback(() => {
    router.back();
  }, []);

  const handlePauseResume = useCallback(async () => {
    if (detail?.kind !== "schedule") return;
    if (detail.record.status === "paused") {
      await resumeSchedule.mutateAsync(automationId);
    } else {
      await pauseSchedule.mutateAsync(automationId);
    }
    invalidateDetail();
  }, [automationId, detail, invalidateDetail, pauseSchedule, resumeSchedule]);

  const handleToggleEnabled = useCallback(async () => {
    if (detail?.kind !== "webhook") return;
    await updateWebhook.mutateAsync({ id: automationId, enabled: !detail.record.enabled });
    invalidateDetail();
  }, [automationId, detail, invalidateDetail, updateWebhook]);

  const handleRunOnce = useCallback(async () => {
    if (!detail) return;
    if (detail.kind === "schedule") {
      await runScheduleOnce.mutateAsync(automationId);
    } else {
      await runTriggerOnce.mutateAsync({ id: automationId });
    }
    invalidateDetail();
  }, [automationId, detail, invalidateDetail, runScheduleOnce, runTriggerOnce]);

  const handleRotate = useCallback(async () => {
    const result = await rotateSecret.mutateAsync(automationId);
    if (result.secret) {
      setRotatedSecret({ secret: result.secret, ingressUrl: result.ingressUrl });
    }
    invalidateDetail();
  }, [automationId, invalidateDetail, rotateSecret]);

  const handleDelete = useCallback(() => {
    if (!detail) return;
    Alert.alert("Delete automation", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void deleteAutomation
            .mutateAsync({ id: automationId, kind: detail.kind })
            .then(() => router.back());
        },
      },
    ]);
  }, [automationId, deleteAutomation, detail]);

  const handleEditClose = useCallback(() => {
    setIsEditOpen(false);
    invalidateDetail();
  }, [invalidateDetail]);

  const handleOpenEdit = useCallback(() => setIsEditOpen(true), []);
  const handleCloseEditModal = useCallback(() => setIsEditOpen(false), []);
  const handleDismissRotated = useCallback(() => setRotatedSecret(null), []);

  const handleCopyIngressUrl = useCallback(() => {
    if (detail?.kind !== "webhook" || !detail.record.ingressUrl) return;
    void Clipboard.setStringAsync(detail.record.ingressUrl);
    setIngressUrlCopied(true);
  }, [detail]);

  const editContext = useMemo<AutomationEditContext | null>(() => {
    if (!detail) return null;
    if (detail.kind === "schedule") {
      return { kind: "schedule", record: detail.record };
    }
    return { kind: "webhook", record: detail.record };
  }, [detail]);

  const sortedRuns = useMemo(() => {
    if (!detail) return [];
    return [...detail.runs].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }, [detail]);

  const lastRunFailed = useMemo(() => isLastRunFailure(detail?.runs ?? []), [detail]);

  if (query.isLoading) {
    return (
      <View style={styles.container}>
        <MenuHeader title="Automation" />
        <View style={styles.centered}>
          <ThemedSpinner size="large" />
        </View>
      </View>
    );
  }

  if (query.error || !detail) {
    return (
      <View style={styles.container}>
        <MenuHeader title="Automation" />
        <View style={styles.centered}>
          <Text style={styles.errorText}>
            {query.error instanceof Error ? query.error.message : "Automation not found"}
          </Text>
          <Button variant="default" onPress={handleBack}>
            Back
          </Button>
        </View>
      </View>
    );
  }

  if (rotatedSecret) {
    return (
      <View style={styles.container}>
        <MenuHeader title="Automation" />
        {/* Scrollable so the rotated-secret reveal reaches Done on mobile. */}
        <ScrollView contentContainerStyle={styles.body}>
          <WebhookSecretReveal
            secret={rotatedSecret.secret}
            ingressUrl={rotatedSecret.ingressUrl}
            onDismiss={handleDismissRotated}
          />
        </ScrollView>
      </View>
    );
  }

  const statusLabel = detailStatusLabel(detail);

  return (
    <View style={styles.container}>
      <MenuHeader title="Automation" />
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.headerBlock}>
          <Text style={styles.name}>{detail.record.name ?? "Untitled automation"}</Text>
          <Text style={styles.statusText}>
            {detail.kind === "schedule" ? "⏰ Schedule" : "🔗 Webhook"} · {statusLabel}
            {lastRunFailed ? " · last run failed" : ""}
          </Text>
          <Text style={styles.prompt}>{detail.record.prompt}</Text>
        </View>

        {detail.kind === "webhook" ? (
          <View style={styles.webhookBlock}>
            <Text style={styles.sectionLabel}>Signing secret</Text>
            <Text style={styles.fingerprint}>
              {detail.record.secretFingerprint
                ? `••••••${detail.record.secretFingerprint}`
                : "No secret set"}
            </Text>
            {detail.record.ingressUrl ? (
              <>
                <Text style={styles.sectionLabel}>Ingress URL</Text>
                <Text style={styles.ingressUrl} selectable>
                  {detail.record.ingressUrl}
                </Text>
                <Button size="sm" variant="secondary" onPress={handleCopyIngressUrl}>
                  {ingressUrlCopied ? "Copied" : "Copy URL"}
                </Button>
                <WebhookConfigInstructions ingressUrl={detail.record.ingressUrl} />
              </>
            ) : null}
            <Button
              size="sm"
              variant="secondary"
              onPress={handleRotate}
              loading={rotateSecret.isPending}
            >
              Rotate secret
            </Button>
          </View>
        ) : null}

        <View style={styles.actions}>
          {detail.kind === "schedule" ? (
            <Button size="sm" variant="secondary" onPress={handlePauseResume}>
              {detail.record.status === "paused" ? "Resume" : "Pause"}
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onPress={handleToggleEnabled}>
              {detail.record.enabled ? "Disable" : "Enable"}
            </Button>
          )}
          <Button size="sm" variant="secondary" onPress={handleRunOnce}>
            Run once
          </Button>
          <Button size="sm" variant="secondary" onPress={handleOpenEdit}>
            Edit
          </Button>
          <Button size="sm" variant="destructive" onPress={handleDelete}>
            Delete
          </Button>
        </View>

        <View style={styles.runsBlock}>
          <Text style={styles.sectionLabel}>Run history</Text>
          {sortedRuns.length === 0 ? (
            <Text style={styles.emptyRuns}>No runs yet</Text>
          ) : (
            sortedRuns.map((run) => (
              <ScheduleRunRow key={run.id} run={run} onPressAgent={handlePressAgent} />
            ))
          )}
        </View>
      </ScrollView>

      <Modal
        visible={isEditOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={handleCloseEditModal}
      >
        {editContext ? (
          <AutomationCreateForm
            serverId={serverId}
            editContext={editContext}
            onClose={handleEditClose}
          />
        ) : null}
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[4],
    padding: theme.spacing[6],
  },
  body: {
    gap: theme.spacing[4],
    padding: theme.spacing[4],
  },
  headerBlock: {
    gap: theme.spacing[2],
  },
  name: {
    fontSize: theme.fontSize.lg,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  statusText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  prompt: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  webhookBlock: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  sectionLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
  },
  fingerprint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  ingressUrl: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  runsBlock: {
    gap: theme.spacing[2],
  },
  emptyRuns: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
  },
}));
