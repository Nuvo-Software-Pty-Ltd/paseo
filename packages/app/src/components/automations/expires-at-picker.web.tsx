import { useCallback } from "react";
import { StyleSheet } from "react-native-unistyles";
import { View } from "react-native";
import { dateTimeLocalToIso, isoToDateTimeLocal } from "./expires-at";
import type { ExpiresAtPickerProps } from "./expires-at-picker";

// Web implementation: a native <input type="datetime-local">. The visible value
// is a timezone-less "YYYY-MM-DDTHH:mm"; we convert to/from the ISO-8601 wire
// value so the submitted `expiresAt` contract is unchanged (empty = no expiry).
// The themed surface lives on the wrapper View; the input is transparent and
// reads theme colors via the Unistyles-emitted CSS variables (no useUnistyles).
export function ExpiresAtPicker({ value, onChange }: ExpiresAtPickerProps) {
  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      onChange(dateTimeLocalToIso(event.target.value));
    },
    [onChange],
  );

  return (
    <View style={styles.container}>
      <input
        type="datetime-local"
        value={isoToDateTimeLocal(value)}
        onChange={handleChange}
        aria-label="automation-expires-at"
        style={INPUT_STYLE}
      />
    </View>
  );
}

// Inline CSS for the DOM input. `color-scheme` makes the native calendar/clock
// popup follow the app theme; colors come from Unistyles' CSS variables.
const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  border: "none",
  outline: "none",
  background: "transparent",
  color: "var(--colors-foreground)",
  colorScheme: "light dark",
  fontSize: 14,
  fontFamily: "inherit",
  padding: 0,
  margin: 0,
};

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
}));
