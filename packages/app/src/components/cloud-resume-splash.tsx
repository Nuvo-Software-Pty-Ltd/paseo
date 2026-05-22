import { Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { COLD_RESUME_SPLASH_COPY } from "@/lib/cloud-workspace-copy";

// Minimal splash: spinner + "Resuming workspace…" copy. No error UI, no
// retry button — workspace-lifecycle.md § "UX copy" Invisible-to-users:
// "Auto-suspend has no copy, no confirmation, no settings toggle Day-1."
// Splash holds indefinitely while the lifecycle worker brings the
// container back; the WS upgrade or the state flip ends it.
export function CloudResumeSplash() {
  const { theme } = useUnistyles();
  return (
    <View style={styles.container} testID="cloud-resume-splash">
      <LoadingSpinner size="small" color={theme.colors.foregroundMuted} />
      <Text style={styles.copy}>{COLD_RESUME_SPLASH_COPY}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[6],
  },
  copy: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
