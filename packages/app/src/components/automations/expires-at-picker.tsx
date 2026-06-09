import { AutomationTextInput, automationInputStyles } from "./automation-text-input";

export interface ExpiresAtPickerProps {
  // The ISO-8601 wire value ("" = no expiry).
  value: string;
  onChange: (iso: string) => void;
}

// Native / fallback implementation. iOS/Android have no <input type="datetime-local">,
// so we keep a freeform ISO text input here — it never crashes and preserves the
// exact wire contract. The web build gets the real picker via expires-at-picker.web.tsx.
export function ExpiresAtPicker({ value, onChange }: ExpiresAtPickerProps) {
  return (
    <AutomationTextInput
      style={automationInputStyles.input}
      value={value}
      onChangeText={onChange}
      placeholder="2026-12-31T00:00:00.000Z"
      autoCapitalize="none"
      autoCorrect={false}
      accessibilityLabel="automation-expires-at"
    />
  );
}
