import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AutomationTarget } from "@server/client/daemon-client";
import type { ScheduleTarget } from "@server/server/schedule/types";
import type { ComboboxOption } from "@/components/ui/combobox";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useAgentHistory } from "@/hooks/use-agent-history";
import { AutomationSelect } from "./automation-select";
import { AutomationTextInput, automationInputStyles } from "./automation-text-input";
import { SegmentedTabs, type SegmentedTab } from "./segmented-tabs";

const MODE_TABS: ReadonlyArray<SegmentedTab<TargetDraft["mode"]>> = [
  { id: "new-agent", label: "New agent" },
  { id: "agent", label: "Existing agent" },
];

// Editor state for the spawn target. We keep both the new-agent fields and the
// chosen existing-agent id around so toggling between modes does not lose input.
export interface TargetDraft {
  mode: "new-agent" | "agent";
  provider: string;
  model: string | null;
  modeId: string | null;
  cwd: string;
  agentId: string | null;
}

export function defaultTargetDraft(): TargetDraft {
  return { mode: "new-agent", provider: "", model: null, modeId: null, cwd: "", agentId: null };
}

export function scheduleTargetToDraft(target: ScheduleTarget): TargetDraft {
  if (target.type === "agent") {
    return { ...defaultTargetDraft(), mode: "agent", agentId: target.agentId };
  }
  const { config } = target;
  return {
    mode: "new-agent",
    provider: config.provider,
    model: config.model ?? null,
    modeId: config.modeId ?? null,
    cwd: config.cwd,
    agentId: null,
  };
}

export interface TargetValidation {
  target: AutomationTarget | null;
  error: string | null;
}

// Convert the draft to a create-shaped target (the wire shape that
// schedule/trigger create + update accept). Only the fields the daemon accepts
// are emitted (provider/model/modeId/cwd for new-agent). Returns a human error
// when required input is missing.
export function draftToScheduleTarget(draft: TargetDraft): TargetValidation {
  if (draft.mode === "agent") {
    if (!draft.agentId) {
      return { target: null, error: "Select an existing agent." };
    }
    return { target: { type: "agent", agentId: draft.agentId }, error: null };
  }
  if (!draft.provider.trim()) {
    return { target: null, error: "Select a provider." };
  }
  if (!draft.cwd.trim()) {
    return { target: null, error: "Enter a working directory." };
  }
  return {
    target: {
      type: "new-agent",
      config: {
        provider: draft.provider.trim(),
        cwd: draft.cwd.trim(),
        ...(draft.model ? { model: draft.model } : {}),
        ...(draft.modeId ? { modeId: draft.modeId } : {}),
      },
    },
    error: null,
  };
}

interface AutomationTargetPickerProps {
  serverId: string;
  draft: TargetDraft;
  onChange: (draft: TargetDraft) => void;
  // Schedule EDIT mode: the daemon's scheduleUpdate.newAgentConfig only patches
  // provider/model/modeId/cwd and there is NO target-kind switch. So hide the
  // new-agent/existing-agent toggle and the existing-agent path entirely.
  editMode?: boolean;
}

export function AutomationTargetPicker({
  serverId,
  draft,
  onChange,
  editMode = false,
}: AutomationTargetPickerProps) {
  const { entries } = useProvidersSnapshot(serverId);
  const { agents } = useAgentHistory({ serverId });

  const providerOptions = useMemo<ComboboxOption[]>(
    () =>
      (entries ?? [])
        .filter((entry) => entry.enabled)
        .map((entry) => ({ id: entry.provider, label: entry.label ?? entry.provider })),
    [entries],
  );

  const modelOptions = useMemo<ComboboxOption[]>(() => {
    const entry = (entries ?? []).find((candidate) => candidate.provider === draft.provider);
    return (entry?.models ?? []).map((model) => ({ id: model.id, label: model.label }));
  }, [entries, draft.provider]);

  const modeOptions = useMemo<ComboboxOption[]>(() => {
    const entry = (entries ?? []).find((candidate) => candidate.provider === draft.provider);
    return (entry?.modes ?? []).map((mode) => ({ id: mode.id, label: mode.label }));
  }, [entries, draft.provider]);

  const agentOptions = useMemo<ComboboxOption[]>(
    () =>
      agents.map((agent) => ({
        id: agent.id,
        label: agent.title ?? agent.id,
        description: agent.cwd,
      })),
    [agents],
  );

  const setMode = useCallback(
    (mode: TargetDraft["mode"]) => onChange({ ...draft, mode }),
    [draft, onChange],
  );
  const setProvider = useCallback(
    (provider: string) => onChange({ ...draft, provider, model: null, modeId: null }),
    [draft, onChange],
  );
  const setModel = useCallback((model: string) => onChange({ ...draft, model }), [draft, onChange]);
  const setModeId = useCallback(
    (modeId: string) => onChange({ ...draft, modeId }),
    [draft, onChange],
  );
  const setCwd = useCallback((cwd: string) => onChange({ ...draft, cwd }), [draft, onChange]);
  const setAgentId = useCallback(
    (agentId: string) => onChange({ ...draft, agentId }),
    [draft, onChange],
  );

  const validation = useMemo(() => draftToScheduleTarget(draft), [draft]);
  const showAgentMode = !editMode;

  return (
    <View style={styles.container}>
      {showAgentMode ? (
        <SegmentedTabs tabs={MODE_TABS} value={draft.mode} onChange={setMode} />
      ) : null}

      {draft.mode === "agent" && showAgentMode ? (
        <AutomationSelect
          label="Agent"
          value={draft.agentId ?? ""}
          options={agentOptions}
          placeholder="Select an agent…"
          title="Select agent"
          onSelect={setAgentId}
        />
      ) : (
        <View style={styles.newAgentFields}>
          <AutomationSelect
            label="Provider"
            value={draft.provider}
            options={providerOptions}
            placeholder="Select a provider…"
            title="Select provider"
            onSelect={setProvider}
          />
          {modelOptions.length > 0 ? (
            <AutomationSelect
              label="Model"
              value={draft.model ?? ""}
              options={modelOptions}
              placeholder="Default model"
              title="Select model"
              onSelect={setModel}
            />
          ) : null}
          {modeOptions.length > 0 ? (
            <AutomationSelect
              label="Mode"
              value={draft.modeId ?? ""}
              options={modeOptions}
              placeholder="Default mode"
              title="Select mode"
              onSelect={setModeId}
            />
          ) : null}
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>Working directory</Text>
            <AutomationTextInput
              style={automationInputStyles.input}
              value={draft.cwd}
              onChangeText={setCwd}
              placeholder="/path/to/project"
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="target-cwd"
            />
          </View>
        </View>
      )}

      {validation.error ? <Text style={styles.errorText}>{validation.error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
  },
  newAgentFields: {
    gap: theme.spacing[2],
  },
  field: {
    gap: theme.spacing[1],
  },
  fieldLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
  },
}));
