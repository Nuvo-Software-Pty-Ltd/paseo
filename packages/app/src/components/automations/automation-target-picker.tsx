import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ComboboxOption } from "@/components/ui/combobox";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useAgentHistory } from "@/hooks/use-agent-history";
import { useServerProjects } from "@/stores/session-store-hooks";
import { buildSelectableProviderOptions } from "@/utils/provider-definitions";
import { AutomationSelect } from "./automation-select";
import { AutomationTextInput, automationInputStyles } from "./automation-text-input";
import { SegmentedTabs, type SegmentedTab } from "./segmented-tabs";
import {
  buildProjectOptions,
  draftToScheduleTarget,
  preselectProjectIdForCwd,
  projectRootPathForId,
  shouldUseProjectPicker,
  type TargetDraft,
} from "./automation-target-model";

// Re-export the pure model so existing imports
// (`@/components/automations/automation-target-picker`) keep working. The logic
// itself lives in automation-target-model.ts so it stays unit-testable in the
// node-env vitest project without pulling in react-native.
export {
  defaultTargetDraft,
  draftToScheduleTarget,
  scheduleTargetToDraft,
  type TargetDraft,
  type TargetValidation,
} from "./automation-target-model";

const MODE_TABS: ReadonlyArray<SegmentedTab<TargetDraft["mode"]>> = [
  { id: "new-agent", label: "New agent" },
  { id: "agent", label: "Existing agent" },
];

interface AutomationTargetPickerProps {
  serverId: string;
  draft: TargetDraft;
  onChange: (draft: TargetDraft) => void;
  // Schedule EDIT mode: the daemon's scheduleUpdate.newAgentConfig only patches
  // provider/model/modeId/thinkingOptionId/cwd and there is NO target-kind
  // switch. So hide the new-agent/existing-agent toggle and the existing-agent
  // path entirely.
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
  const projects = useServerProjects(serverId);

  // Provider eligibility is derived from the SAME helper the chat composer uses
  // (status-based selectability), so the two cannot diverge — the old
  // `entry.enabled` filter dropped selectable cloud providers, leaving this
  // dropdown empty.
  const providerOptions = useMemo<ComboboxOption[]>(
    () => buildSelectableProviderOptions(entries),
    [entries],
  );

  const selectedEntry = useMemo(
    () => (entries ?? []).find((candidate) => candidate.provider === draft.provider),
    [entries, draft.provider],
  );

  const modelOptions = useMemo<ComboboxOption[]>(
    () => (selectedEntry?.models ?? []).map((model) => ({ id: model.id, label: model.label })),
    [selectedEntry],
  );

  const modeOptions = useMemo<ComboboxOption[]>(
    () => (selectedEntry?.modes ?? []).map((mode) => ({ id: mode.id, label: mode.label })),
    [selectedEntry],
  );

  // Effort/thinking options for the selected model (mirrors the chat composer's
  // Brain-icon selector). Only shown when the model exposes thinking options.
  const thinkingOptions = useMemo<ComboboxOption[]>(() => {
    const model = (selectedEntry?.models ?? []).find((candidate) => candidate.id === draft.model);
    return (model?.thinkingOptions ?? []).map((option) => ({ id: option.id, label: option.label }));
  }, [selectedEntry, draft.model]);

  const agentOptions = useMemo<ComboboxOption[]>(
    () =>
      agents.map((agent) => ({
        id: agent.id,
        label: agent.title ?? agent.id,
        description: agent.cwd,
      })),
    [agents],
  );

  const projectOptions = useMemo<ComboboxOption[]>(() => buildProjectOptions(projects), [projects]);
  const useProjectPicker = shouldUseProjectPicker(projects);
  const selectedProjectId = useMemo(
    () => preselectProjectIdForCwd(projects, draft.cwd),
    [projects, draft.cwd],
  );

  const setMode = useCallback(
    (mode: TargetDraft["mode"]) => onChange({ ...draft, mode }),
    [draft, onChange],
  );
  const setProvider = useCallback(
    // Reset model/mode/effort when the provider changes — like the composer.
    (provider: string) =>
      onChange({ ...draft, provider, model: null, modeId: null, thinkingOptionId: null }),
    [draft, onChange],
  );
  const setModel = useCallback(
    // Reset effort when the model changes (thinking options are per-model).
    (model: string) => onChange({ ...draft, model, thinkingOptionId: null }),
    [draft, onChange],
  );
  const setModeId = useCallback(
    (modeId: string) => onChange({ ...draft, modeId }),
    [draft, onChange],
  );
  const setThinkingOptionId = useCallback(
    (thinkingOptionId: string) => onChange({ ...draft, thinkingOptionId }),
    [draft, onChange],
  );
  const setCwd = useCallback((cwd: string) => onChange({ ...draft, cwd }), [draft, onChange]);
  const setCwdFromProject = useCallback(
    (projectId: string) => {
      const rootPath = projectRootPathForId(projects, projectId);
      if (rootPath !== null) {
        onChange({ ...draft, cwd: rootPath });
      }
    },
    [draft, onChange, projects],
  );
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
          {thinkingOptions.length > 0 ? (
            <AutomationSelect
              label="Effort"
              value={draft.thinkingOptionId ?? ""}
              options={thinkingOptions}
              placeholder="Default effort"
              title="Select effort"
              onSelect={setThinkingOptionId}
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
          {useProjectPicker ? (
            <AutomationSelect
              label="Working directory"
              value={selectedProjectId}
              options={projectOptions}
              placeholder="Select a project…"
              title="Select working directory"
              onSelect={setCwdFromProject}
            />
          ) : (
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
          )}
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
