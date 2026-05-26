import { useCallback } from "react";
import { View, Text, Pressable } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { getQuotaErrorCopy, type QuotaErrorEnvelope } from "@/lib/quota-error-envelope";

interface QuotaErrorBannerProps {
  envelope: QuotaErrorEnvelope;
  onArchiveWorkspaces?: () => void;
  onCloseAgent?: () => void;
  onUpgradePlan?: () => void;
}

// Renders the per-class quota error banner. The "Upgrade plan" link is a
// placeholder Day-1 (no billing module yet); D-4 wires the destination
// behind a feature flag. push_token_count is silent and returns null —
// the cap is operator-visible, not user-visible.
export function QuotaErrorBanner({
  envelope,
  onArchiveWorkspaces,
  onCloseAgent,
  onUpgradePlan,
}: QuotaErrorBannerProps) {
  const copy = getQuotaErrorCopy(envelope);

  const handlePrimary = useCallback(() => {
    const cta = copy.primaryCta;
    if (!cta) return;
    if (cta.kind === "archive-workspaces") onArchiveWorkspaces?.();
    else if (cta.kind === "close-agent") onCloseAgent?.();
    else if (cta.kind === "upgrade-plan") onUpgradePlan?.();
  }, [copy.primaryCta, onArchiveWorkspaces, onCloseAgent, onUpgradePlan]);

  const handleSecondary = useCallback(() => {
    const cta = copy.secondaryCta;
    if (!cta) return;
    if (cta.kind === "archive-workspaces") onArchiveWorkspaces?.();
    else if (cta.kind === "close-agent") onCloseAgent?.();
    else if (cta.kind === "upgrade-plan") onUpgradePlan?.();
  }, [copy.secondaryCta, onArchiveWorkspaces, onCloseAgent, onUpgradePlan]);

  if (copy.silent) {
    return null;
  }

  return (
    <View
      style={styles.container}
      accessibilityLabel={`quota-error-${envelope.quotaClass}`}
      testID={`quota-error-banner-${envelope.quotaClass}`}
    >
      <Text style={styles.message}>{copy.message}</Text>
      {copy.primaryCta || copy.secondaryCta ? (
        <View style={styles.actionsRow}>
          {copy.primaryCta ? (
            <Pressable
              onPress={handlePrimary}
              accessibilityRole="button"
              testID={`quota-error-banner-primary-${copy.primaryCta.kind}`}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryButtonText}>{copy.primaryCta.label}</Text>
            </Pressable>
          ) : null}
          {copy.secondaryCta ? (
            <Pressable
              onPress={handleSecondary}
              accessibilityRole="button"
              testID={`quota-error-banner-secondary-${copy.secondaryCta.kind}`}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>{copy.secondaryCta.label}</Text>
            </Pressable>
          ) : null}
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
  message: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  actionsRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  primaryButton: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.accent,
  },
  primaryButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.accentForeground,
  },
  secondaryButton: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  secondaryButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
})) as unknown as Record<string, object>;
