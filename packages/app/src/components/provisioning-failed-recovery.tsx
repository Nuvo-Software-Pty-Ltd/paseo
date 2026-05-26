import { useCallback, useState } from "react";
import { View, Text, Pressable, ActivityIndicator } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { archiveCloudWorkspace, OrchestraSessionExpiredError } from "@/lib/orchestra-cloud-client";

// Locked copy for the provisioning_failed cap-trap recovery affordance.
// Operator-resolved direction is (a) — make provisioning_failed → archived
// a legal transition + cap exclusion (CROSS-STREAM-SYNTHESIS § 1 C5,
// commit 9dc8972). PLAN-auth-and-shared owns the transition table change;
// this affordance is the load-bearing recovery path under normal operation.
// The contact-support fallback narrows to "auth's archive route returned
// a 5xx network error during recovery".
export const PROVISIONING_FAILED_TITLE = "This workspace failed to provision.";
export const PROVISIONING_FAILED_ARCHIVE_HINT =
  "Archive it to free up capacity. You can try again with a different repo.";
export const PROVISIONING_FAILED_ARCHIVE_BUTTON = "Archive this failed workspace";
export const PROVISIONING_FAILED_CONTACT_SUPPORT_HINT =
  "Couldn't archive automatically. Contact support with this ID:";

type RecoveryState =
  | { kind: "idle" }
  | { kind: "archiving" }
  | { kind: "archived" }
  | { kind: "contact_support"; reason: string };

interface ProvisioningFailedRecoveryProps {
  workspaceId: string;
  onArchived?: () => void;
}

export function ProvisioningFailedRecovery({
  workspaceId,
  onArchived,
}: ProvisioningFailedRecoveryProps) {
  const [state, setState] = useState<RecoveryState>({ kind: "idle" });

  const handleArchive = useCallback(async () => {
    setState({ kind: "archiving" });
    try {
      await archiveCloudWorkspace(workspaceId);
      setState({ kind: "archived" });
      onArchived?.();
    } catch (error) {
      // Session-expired bounces via OrchestraSessionProvider — don't render
      // contact-support copy on top of a redirect.
      if (error instanceof OrchestraSessionExpiredError) {
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      setState({ kind: "contact_support", reason });
    }
  }, [onArchived, workspaceId]);

  if (state.kind === "archived") {
    return null;
  }

  return (
    <View style={styles.container} accessibilityLabel="provisioning-failed-recovery">
      <Text style={styles.title}>{PROVISIONING_FAILED_TITLE}</Text>
      <Text style={styles.hint}>{PROVISIONING_FAILED_ARCHIVE_HINT}</Text>
      {state.kind !== "contact_support" ? (
        <Pressable
          style={styles.primaryButton}
          onPress={handleArchive}
          disabled={state.kind === "archiving"}
          accessibilityRole="button"
          testID="provisioning-failed-archive"
        >
          {state.kind === "archiving" ? (
            <ActivityIndicator size="small" />
          ) : (
            <Text style={styles.primaryButtonText}>{PROVISIONING_FAILED_ARCHIVE_BUTTON}</Text>
          )}
        </Pressable>
      ) : (
        <View style={styles.contactSupport} testID="provisioning-failed-contact-support">
          <Text style={styles.hint}>{PROVISIONING_FAILED_CONTACT_SUPPORT_HINT}</Text>
          <Text style={styles.workspaceId} selectable>
            {workspaceId}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    gap: theme.spacing[2],
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderLeftWidth: theme.borderWidth[2] ?? 2,
    borderLeftColor: theme.colors.destructive,
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  hint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  primaryButton: {
    alignSelf: "flex-start",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.accent,
  },
  primaryButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.accentForeground,
  },
  contactSupport: {
    marginTop: theme.spacing[2],
    gap: theme.spacing[1],
  },
  workspaceId: {
    fontFamily: "monospace",
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
})) as unknown as Record<string, object>;
