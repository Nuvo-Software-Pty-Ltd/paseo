import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import * as Clipboard from "expo-clipboard";
import { Button } from "@/components/ui/button";
import { Fonts } from "@/constants/theme";

// The one-time secret reveal shown right after a webhook trigger is created or
// its secret is rotated. The full secret is served by the daemon exactly once;
// after this panel is dismissed only the masked fingerprint remains visible
// (in the detail screen). Render with the raw `secret` + `ingressUrl` from the
// create/rotate response.
interface WebhookSecretRevealProps {
  secret: string;
  ingressUrl: string | null;
  onDismiss: () => void;
}

export function WebhookSecretReveal({ secret, ingressUrl, onDismiss }: WebhookSecretRevealProps) {
  const [copiedField, setCopiedField] = useState<"secret" | "url" | null>(null);

  const copySecret = useCallback(() => {
    void Clipboard.setStringAsync(secret);
    setCopiedField("secret");
  }, [secret]);

  const copyUrl = useCallback(() => {
    if (!ingressUrl) return;
    void Clipboard.setStringAsync(ingressUrl);
    setCopiedField("url");
  }, [ingressUrl]);

  return (
    <View style={styles.container} accessibilityLabel="webhook-secret-reveal">
      <Text style={styles.heading}>Webhook created</Text>
      <Text style={styles.notice}>
        You won&apos;t see this secret again. Copy it now and store it somewhere safe.
      </Text>

      <View style={styles.fieldBlock}>
        <Text style={styles.fieldLabel}>Signing secret</Text>
        <Text style={styles.fieldValue} selectable testID="webhook-secret-value">
          {secret}
        </Text>
        <Button size="sm" variant="secondary" onPress={copySecret}>
          {copiedField === "secret" ? "Copied" : "Copy secret"}
        </Button>
      </View>

      {ingressUrl ? (
        <View style={styles.fieldBlock}>
          <Text style={styles.fieldLabel}>Ingress URL</Text>
          <Text style={styles.fieldValue} selectable>
            {ingressUrl}
          </Text>
          <Button size="sm" variant="secondary" onPress={copyUrl}>
            {copiedField === "url" ? "Copied" : "Copy URL"}
          </Button>
        </View>
      ) : null}

      <Button variant="default" onPress={onDismiss}>
        Done
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  heading: {
    fontSize: theme.fontSize.lg,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  notice: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
  },
  fieldBlock: {
    gap: theme.spacing[2],
  },
  fieldLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  fieldValue: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontFamily: Fonts.mono,
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
  },
}));
