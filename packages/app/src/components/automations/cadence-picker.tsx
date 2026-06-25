import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ScheduleCadence } from "@getpaseo/protocol/schedule/types";
import { AutomationTextInput, automationInputStyles } from "./automation-text-input";
import { SegmentedTabs, type SegmentedTab } from "./segmented-tabs";

export type CadenceUnit = "minute" | "hour" | "day";

// Local editor state — kept as strings so the text inputs can hold partial
// input. Converted to a `ScheduleCadence` only when valid (see draftToCadence).
export interface CadenceDraft {
  mode: "every" | "cron";
  everyValue: string;
  everyUnit: CadenceUnit;
  cronExpression: string;
}

const UNIT_MS: Record<CadenceUnit, number> = {
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
};

const MIN_CLOUD_INTERVAL_MS = 60 * 1000;

export function defaultCadenceDraft(): CadenceDraft {
  return { mode: "every", everyValue: "5", everyUnit: "minute", cronExpression: "" };
}

// Derive an editor draft from an existing cadence (edit mode).
export function cadenceToDraft(cadence: ScheduleCadence): CadenceDraft {
  if (cadence.type === "cron") {
    return { ...defaultCadenceDraft(), mode: "cron", cronExpression: cadence.expression };
  }
  const { everyMs } = cadence;
  if (everyMs % UNIT_MS.day === 0) {
    return {
      ...defaultCadenceDraft(),
      everyValue: String(everyMs / UNIT_MS.day),
      everyUnit: "day",
    };
  }
  if (everyMs % UNIT_MS.hour === 0) {
    return {
      ...defaultCadenceDraft(),
      everyValue: String(everyMs / UNIT_MS.hour),
      everyUnit: "hour",
    };
  }
  return {
    ...defaultCadenceDraft(),
    everyValue: String(Math.max(1, Math.round(everyMs / UNIT_MS.minute))),
    everyUnit: "minute",
  };
}

// Validate a 5-field cron expression. Rejects `@daily`-style macros and any
// expression that is not exactly five whitespace-separated fields.
export function isValidFiveFieldCron(expression: string): boolean {
  const trimmed = expression.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith("@")) return false;
  const fields = trimmed.split(/\s+/);
  return fields.length === 5;
}

export interface CadenceValidation {
  cadence: ScheduleCadence | null;
  error: string | null;
}

// Convert a draft to a ScheduleCadence, or return a human error. The < 60s
// cloud-rejection check mirrors the daemon's DynamoScheduleStore.
export function draftToCadence(draft: CadenceDraft): CadenceValidation {
  if (draft.mode === "cron") {
    if (!isValidFiveFieldCron(draft.cronExpression)) {
      return {
        cadence: null,
        error: "Enter a valid 5-field cron expression (macros like @daily are not supported).",
      };
    }
    return { cadence: { type: "cron", expression: draft.cronExpression.trim() }, error: null };
  }
  const value = Number.parseInt(draft.everyValue, 10);
  if (!Number.isFinite(value) || value <= 0) {
    return { cadence: null, error: "Enter a positive interval." };
  }
  const everyMs = value * UNIT_MS[draft.everyUnit];
  if (everyMs < MIN_CLOUD_INTERVAL_MS) {
    return {
      cadence: { type: "every", everyMs },
      error: "Cloud schedules require ≥ 60s.",
    };
  }
  return { cadence: { type: "every", everyMs }, error: null };
}

interface CadencePickerProps {
  draft: CadenceDraft;
  onChange: (draft: CadenceDraft) => void;
}

const MODE_TABS: ReadonlyArray<SegmentedTab<CadenceDraft["mode"]>> = [
  { id: "every", label: "Interval" },
  { id: "cron", label: "Cron" },
];

const UNIT_TABS: ReadonlyArray<SegmentedTab<CadenceUnit>> = [
  { id: "minute", label: "min" },
  { id: "hour", label: "hour" },
  { id: "day", label: "day" },
];

const NUMBER_INPUT_STYLE = [automationInputStyles.input, { minWidth: 56 }];

export function CadencePicker({ draft, onChange }: CadencePickerProps) {
  const validation = useMemo(() => draftToCadence(draft), [draft]);

  const setMode = useCallback(
    (mode: CadenceDraft["mode"]) => onChange({ ...draft, mode }),
    [draft, onChange],
  );
  const setEveryValue = useCallback(
    (everyValue: string) => onChange({ ...draft, everyValue: everyValue.replace(/[^0-9]/g, "") }),
    [draft, onChange],
  );
  const setEveryUnit = useCallback(
    (everyUnit: CadenceUnit) => onChange({ ...draft, everyUnit }),
    [draft, onChange],
  );
  const setCron = useCallback(
    (cronExpression: string) => onChange({ ...draft, cronExpression }),
    [draft, onChange],
  );

  return (
    <View style={styles.container}>
      <SegmentedTabs tabs={MODE_TABS} value={draft.mode} onChange={setMode} />

      {draft.mode === "every" ? (
        <View style={styles.everyRow}>
          <Text style={styles.everyLabel}>Every</Text>
          <AutomationTextInput
            style={NUMBER_INPUT_STYLE}
            value={draft.everyValue}
            onChangeText={setEveryValue}
            keyboardType="number-pad"
            placeholder="5"
            accessibilityLabel="cadence-every-value"
          />
          <SegmentedTabs tabs={UNIT_TABS} value={draft.everyUnit} onChange={setEveryUnit} />
        </View>
      ) : (
        <AutomationTextInput
          style={automationInputStyles.input}
          value={draft.cronExpression}
          onChangeText={setCron}
          placeholder="0 9 * * 1"
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="cadence-cron-expression"
        />
      )}

      {validation.error ? <Text style={styles.errorText}>{validation.error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
  },
  everyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  everyLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  errorText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
  },
}));
