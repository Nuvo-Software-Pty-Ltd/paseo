import { TextInput } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";

// A theme-aware TextInput for the automation forms. `placeholderTextColor` is a
// non-style prop, so per docs/unistyles.md we wrap with `withUnistyles` to make
// it theme-reactive rather than calling `useUnistyles()`. Style via the shared
// `styles.input` (or pass an extra `style`).
export const AutomationTextInput = withUnistyles(TextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

export const automationInputStyles = StyleSheet.create((theme) => ({
  input: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  multiline: {
    minHeight: 80,
    textAlignVertical: "top",
  },
}));
