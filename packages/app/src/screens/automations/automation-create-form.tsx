import { useCallback, useMemo, useState } from "react";
import { ScrollView, Switch, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import type { WebhookTrigger } from "@getpaseo/protocol/trigger/types";
import { Button } from "@/components/ui/button";
import {
  AutomationTextInput,
  automationInputStyles,
} from "@/components/automations/automation-text-input";
import {
  CadencePicker,
  type CadenceDraft,
  cadenceToDraft,
  defaultCadenceDraft,
  draftToCadence,
} from "@/components/automations/cadence-picker";
import {
  AutomationTargetPicker,
  type TargetDraft,
  defaultTargetDraft,
  draftToScheduleTarget,
  scheduleTargetToDraft,
} from "@/components/automations/automation-target-picker";
import { formatSubmitError } from "./format-submit-error";
import { ExpiresAtPicker } from "@/components/automations/expires-at-picker";
import { WebhookSecretReveal } from "@/components/automations/webhook-secret-reveal";
import { SegmentedTabs, type SegmentedTab } from "@/components/automations/segmented-tabs";
import {
  useCreateSchedule,
  useCreateWebhookTrigger,
  useUpdateSchedule,
  useUpdateWebhookTrigger,
  useWebhookTriggersFeatureFlag,
} from "@/hooks/use-automations";

type FormKind = "schedule" | "webhook";

const KIND_TABS: ReadonlyArray<SegmentedTab<FormKind>> = [
  { id: "schedule", label: "Schedule" },
  { id: "webhook", label: "Webhook" },
];

const MULTILINE_INPUT_STYLE = [automationInputStyles.input, automationInputStyles.multiline];

// EDIT (schedule): build the restricted newAgentConfig the daemon accepts
// (provider/model/modeId/thinkingOptionId/cwd only). Returns undefined for the
// existing-agent mode, which scheduleUpdate cannot re-target (see FIX #3).
function buildScheduleNewAgentConfig(
  targetDraft: TargetDraft,
):
  | { provider: string; model?: string; modeId?: string; thinkingOptionId?: string; cwd?: string }
  | undefined {
  if (targetDraft.mode !== "new-agent") {
    return undefined;
  }
  return {
    provider: targetDraft.provider.trim(),
    ...(targetDraft.model ? { model: targetDraft.model } : {}),
    ...(targetDraft.modeId ? { modeId: targetDraft.modeId } : {}),
    ...(targetDraft.thinkingOptionId ? { thinkingOptionId: targetDraft.thinkingOptionId } : {}),
    ...(targetDraft.cwd.trim() ? { cwd: targetDraft.cwd.trim() } : {}),
  };
}

// Edit context: the form may be opened to edit an existing schedule or webhook.
// In edit mode the kind selector is hidden and per-kind restrictions apply.
export type AutomationEditContext =
  | { kind: "schedule"; record: ScheduleSummary }
  | { kind: "webhook"; record: WebhookTrigger };

interface AutomationCreateFormProps {
  serverId: string;
  // Provided => edit mode. Absent => create mode.
  editContext?: AutomationEditContext;
  onClose: () => void;
}

interface SecretRevealState {
  secret: string;
  ingressUrl: string | null;
}

export function AutomationCreateForm({
  serverId,
  editContext,
  onClose,
}: AutomationCreateFormProps) {
  const webhookSupported = useWebhookTriggersFeatureFlag(serverId);
  const isEdit = Boolean(editContext);

  const [kind, setKind] = useState<FormKind>(editContext?.kind ?? "schedule");

  // Shared fields.
  const [prompt, setPrompt] = useState(() => editContext?.record.prompt ?? "");
  const [name, setName] = useState(() => editContext?.record.name ?? "");
  const [targetDraft, setTargetDraft] = useState<TargetDraft>(() =>
    editContext ? scheduleTargetToDraft(editContext.record.target) : defaultTargetDraft(),
  );

  // Schedule-only fields.
  const [cadenceDraft, setCadenceDraft] = useState<CadenceDraft>(() =>
    editContext?.kind === "schedule"
      ? cadenceToDraft(editContext.record.cadence)
      : defaultCadenceDraft(),
  );
  const [maxRuns, setMaxRuns] = useState(() => {
    const value = editContext?.kind === "schedule" ? editContext.record.maxRuns : null;
    return value != null ? String(value) : "";
  });
  const [expiresAt, setExpiresAt] = useState(() =>
    editContext?.kind === "schedule" ? (editContext.record.expiresAt ?? "") : "",
  );
  const [runOnCreate, setRunOnCreate] = useState(false);

  // Webhook-only fields.
  const [payloadTemplate, setPayloadTemplate] = useState(() =>
    editContext?.kind === "webhook" ? (editContext.record.payloadTemplate ?? "") : "",
  );

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [secretReveal, setSecretReveal] = useState<SecretRevealState | null>(null);

  const createSchedule = useCreateSchedule(serverId);
  const createWebhook = useCreateWebhookTrigger(serverId);
  const updateSchedule = useUpdateSchedule(serverId);
  const updateWebhook = useUpdateWebhookTrigger(serverId);

  const isPending =
    createSchedule.isPending ||
    createWebhook.isPending ||
    updateSchedule.isPending ||
    updateWebhook.isPending;

  const cadenceValidation = useMemo(() => draftToCadence(cadenceDraft), [cadenceDraft]);
  const targetValidation = useMemo(() => draftToScheduleTarget(targetDraft), [targetDraft]);

  const handleMaxRunsChange = useCallback((value: string) => {
    setMaxRuns(value.replace(/[^0-9]/g, ""));
  }, []);

  const submitSchedule = useCallback(async () => {
    if (!prompt.trim()) {
      setSubmitError("Enter a prompt.");
      return;
    }
    if (!cadenceValidation.cadence) {
      setSubmitError(cadenceValidation.error ?? "Invalid cadence.");
      return;
    }
    const parsedMaxRuns = maxRuns.trim() ? Number.parseInt(maxRuns, 10) : null;

    if (isEdit && editContext) {
      // EDIT (schedule): scheduleUpdate only patches name/prompt/cadence/
      // maxRuns/expiresAt and a restricted newAgentConfig (provider/model/
      // modeId/thinkingOptionId/cwd). No target-kind switch — see FIX #3.
      const newAgentConfig = buildScheduleNewAgentConfig(targetDraft);
      try {
        const result = await updateSchedule.mutateAsync({
          id: editContext.record.id,
          name: name.trim() ? name.trim() : null,
          prompt: prompt.trim(),
          cadence: cadenceValidation.cadence,
          maxRuns: parsedMaxRuns,
          expiresAt: expiresAt.trim() ? expiresAt.trim() : null,
          ...(newAgentConfig ? { newAgentConfig } : {}),
        });
        if (result.error) {
          setSubmitError(result.error);
          return;
        }
      } catch (err) {
        // mutateAsync rejects when the daemon RPC throws — surface it instead of
        // letting the rejection vanish into the caller's `void`.
        setSubmitError(formatSubmitError(err, "save"));
        return;
      }
      onClose();
      return;
    }

    if (!targetValidation.target) {
      setSubmitError(targetValidation.error ?? "Invalid target.");
      return;
    }
    try {
      const result = await createSchedule.mutateAsync({
        prompt: prompt.trim(),
        cadence: cadenceValidation.cadence,
        target: targetValidation.target,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(parsedMaxRuns != null ? { maxRuns: parsedMaxRuns } : {}),
        ...(expiresAt.trim() ? { expiresAt: expiresAt.trim() } : {}),
        ...(runOnCreate ? { runOnCreate: true } : {}),
      });
      if (result.error) {
        setSubmitError(result.error);
        return;
      }
    } catch (err) {
      setSubmitError(formatSubmitError(err, "create"));
      return;
    }
    onClose();
  }, [
    cadenceValidation,
    createSchedule,
    editContext,
    expiresAt,
    isEdit,
    maxRuns,
    name,
    onClose,
    prompt,
    runOnCreate,
    targetDraft,
    targetValidation,
    updateSchedule,
  ]);

  const submitWebhook = useCallback(async () => {
    if (!prompt.trim()) {
      setSubmitError("Enter a prompt.");
      return;
    }
    if (!targetValidation.target) {
      setSubmitError(targetValidation.error ?? "Invalid target.");
      return;
    }
    const normalizedTemplate = payloadTemplate.trim() ? payloadTemplate : null;

    if (isEdit && editContext) {
      try {
        const result = await updateWebhook.mutateAsync({
          id: editContext.record.id,
          name: name.trim() ? name.trim() : null,
          prompt: prompt.trim(),
          target: targetValidation.target,
          payloadTemplate: normalizedTemplate,
        });
        if (result.error) {
          setSubmitError(result.error);
          return;
        }
      } catch (err) {
        setSubmitError(formatSubmitError(err, "save"));
        return;
      }
      onClose();
      return;
    }

    try {
      const result = await createWebhook.mutateAsync({
        prompt: prompt.trim(),
        target: targetValidation.target,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(normalizedTemplate !== null ? { payloadTemplate: normalizedTemplate } : {}),
      });
      if (result.error) {
        setSubmitError(result.error);
        return;
      }
      if (result.secret) {
        // One-time secret reveal — keep the form mounted to show it.
        setSecretReveal({ secret: result.secret, ingressUrl: result.ingressUrl });
        return;
      }
    } catch (err) {
      setSubmitError(formatSubmitError(err, "create"));
      return;
    }
    onClose();
  }, [
    createWebhook,
    editContext,
    isEdit,
    name,
    onClose,
    payloadTemplate,
    prompt,
    targetValidation,
    updateWebhook,
  ]);

  const handleSubmit = useCallback(() => {
    setSubmitError(null);
    if (kind === "schedule") {
      void submitSchedule();
    } else {
      void submitWebhook();
    }
  }, [kind, submitSchedule, submitWebhook]);

  if (secretReveal) {
    // Mirror the main form branch so the reveal (secret + URL + "How to call
    // it" + curl + Done) scrolls on a narrow viewport — otherwise Done is
    // unreachable on mobile. See WebhookSecretReveal.
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <WebhookSecretReveal
          secret={secretReveal.secret}
          ingressUrl={secretReveal.ingressUrl}
          onDismiss={onClose}
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>{isEdit ? "Edit automation" : "New automation"}</Text>

      {!isEdit && webhookSupported ? (
        <SegmentedTabs tabs={KIND_TABS} value={kind} onChange={setKind} />
      ) : null}

      <Field label="Name (optional)">
        <AutomationTextInput
          style={automationInputStyles.input}
          value={name}
          onChangeText={setName}
          placeholder="My automation"
          accessibilityLabel="automation-name"
        />
      </Field>

      <Field label="Prompt">
        <AutomationTextInput
          style={MULTILINE_INPUT_STYLE}
          value={prompt}
          onChangeText={setPrompt}
          placeholder="What should the agent do?"
          multiline
          accessibilityLabel="automation-prompt"
        />
      </Field>

      {kind === "schedule" ? (
        <Field label="Cadence">
          <CadencePicker draft={cadenceDraft} onChange={setCadenceDraft} />
        </Field>
      ) : null}

      <Field label="Target">
        <AutomationTargetPicker
          serverId={serverId}
          draft={targetDraft}
          onChange={setTargetDraft}
          editMode={isEdit && kind === "schedule"}
        />
      </Field>

      {kind === "schedule" ? (
        <>
          <Field label="Max runs (optional)">
            <AutomationTextInput
              style={automationInputStyles.input}
              value={maxRuns}
              onChangeText={handleMaxRunsChange}
              keyboardType="number-pad"
              placeholder="Unlimited"
              accessibilityLabel="automation-max-runs"
            />
          </Field>
          <Field label="Expires at (optional)">
            <ExpiresAtPicker value={expiresAt} onChange={setExpiresAt} />
          </Field>
          {!isEdit ? (
            <View style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>Run immediately on create</Text>
              <Switch value={runOnCreate} onValueChange={setRunOnCreate} />
            </View>
          ) : null}
        </>
      ) : (
        <Field label="Payload template (optional)">
          <AutomationTextInput
            style={MULTILINE_INPUT_STYLE}
            value={payloadTemplate}
            onChangeText={setPayloadTemplate}
            placeholder="Use {{payload}} to inject the request body"
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="automation-payload-template"
          />
        </Field>
      )}

      {submitError ? <Text style={styles.errorText}>{submitError}</Text> : null}

      <View style={styles.actions}>
        <Button variant="ghost" onPress={onClose} disabled={isPending}>
          Cancel
        </Button>
        <Button variant="default" onPress={handleSubmit} loading={isPending}>
          {isEdit ? "Save" : "Create"}
        </Button>
      </View>
    </ScrollView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  content: {
    gap: theme.spacing[4],
    padding: theme.spacing[4],
  },
  title: {
    fontSize: theme.fontSize.lg,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  field: {
    gap: theme.spacing[2],
  },
  fieldLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  toggleLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    paddingTop: theme.spacing[2],
  },
}));
