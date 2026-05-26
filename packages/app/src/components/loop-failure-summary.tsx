import { useMemo } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { LoopRecord } from "@server/server/loop-types";
import type { Theme } from "@/styles/theme";
import { buildLoopFailureSummaryModel } from "./loop-failure-summary-model";

interface LoopFailureSummaryProps {
  loop: LoopRecord;
}

// Renders the cap-class explanation for a failed loop. Round-19 binding: the
// cap message lives in the trailing `logs[].text`; there is NO top-level
// `failureReason` field on LoopRecord. The failed iterations are listed
// below the summary with their own per-iteration `failureReason`.
export function LoopFailureSummary({ loop }: LoopFailureSummaryProps) {
  const model = useMemo(() => buildLoopFailureSummaryModel(loop), [loop]);
  if (model.kind === "not_failed") {
    return null;
  }
  const message = model.kind === "cap" ? model.capMessage : model.fallbackMessage;
  return (
    <View style={styles.container} accessibilityLabel="loop-failure-summary">
      <Text style={styles.heading}>Loop failed</Text>
      <Text style={styles.capMessage} testID="loop-failure-message">
        {message}
      </Text>
      {model.failedIterations.length > 0 ? (
        <View style={styles.iterations}>
          <Text style={styles.iterationsHeader}>Failed iterations</Text>
          {model.failedIterations.map((iter) => (
            <View key={iter.index} style={styles.iterationRow}>
              <Text style={styles.iterationIndex}>#{iter.index}</Text>
              <Text style={styles.iterationReason}>
                {iter.failureReason ?? "(no reason recorded)"}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderLeftWidth: theme.borderWidth[2] ?? 2,
    borderLeftColor: theme.colors.destructive,
  },
  heading: {
    fontSize: theme.fontSize.base,
    fontWeight: "600",
    color: theme.colors.destructive,
  },
  capMessage: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  iterations: {
    gap: theme.spacing[1],
    marginTop: theme.spacing[2],
  },
  iterationsHeader: {
    fontSize: theme.fontSize.xs,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
  },
  iterationRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  iterationIndex: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  iterationReason: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
})) as unknown as Record<string, object>;
