import { useCallback, useMemo } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ScheduleRun } from "@getpaseo/protocol/schedule/types";
import type { Theme } from "@/styles/theme";
import {
  buildScheduleRunRowModel,
  type ScheduleFailedRunRowModel,
} from "./schedule-failed-run-row-model";

interface ScheduleRunRowProps {
  run: ScheduleRun;
  onPressAgent?: (agentId: string) => void;
}

// Renders a single ScheduleRun. Schedule failures (round-19 binding) carry a
// free-form `error: string` and `agentId: null` — we render the error
// verbatim and suppress the agent link when there's no agent to link to.
export function ScheduleRunRow({ run, onPressAgent }: ScheduleRunRowProps) {
  const model = useMemo(() => buildScheduleRunRowModel(run), [run]);
  return <ScheduleRunRowView model={model} onPressAgent={onPressAgent} />;
}

interface ScheduleRunRowViewProps {
  model: ScheduleFailedRunRowModel;
  onPressAgent?: (agentId: string) => void;
}

export function ScheduleRunRowView({ model, onPressAgent }: ScheduleRunRowViewProps) {
  const agentId = model.status === "succeeded" ? model.agentId : null;
  const handlePressAgent = useCallback(() => {
    if (agentId && onPressAgent) onPressAgent(agentId);
  }, [agentId, onPressAgent]);

  if (model.status === "running") {
    return (
      <View style={styles.container} accessibilityLabel="schedule-run-running">
        <Text style={styles.statusLabel}>Running…</Text>
        <Text style={styles.timestamp}>Scheduled for {model.scheduledFor}</Text>
      </View>
    );
  }
  if (model.status === "succeeded") {
    return (
      <View style={styles.container} accessibilityLabel="schedule-run-succeeded">
        <Text style={styles.statusLabelSucceeded}>Succeeded</Text>
        <Text style={styles.timestamp}>Started {model.startedAt}</Text>
        {model.output ? <Text style={styles.outputPreview}>{model.output}</Text> : null}
        {agentId && onPressAgent ? (
          <Text style={styles.agentLink} accessibilityRole="link" onPress={handlePressAgent}>
            Open agent
          </Text>
        ) : null}
      </View>
    );
  }
  // status === "failed"
  return (
    <View style={styles.container} accessibilityLabel="schedule-run-failed">
      <Text style={styles.statusLabelFailed}>Failed</Text>
      <Text style={styles.timestamp}>Started {model.startedAt}</Text>
      <Text style={styles.errorText} testID="schedule-run-error">
        {model.error}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  statusLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  statusLabelSucceeded: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.success,
  },
  statusLabelFailed: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.destructive,
  },
  timestamp: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
  },
  outputPreview: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  agentLink: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.accent,
    textDecorationLine: "underline",
  },
})) as unknown as Record<string, object>;
