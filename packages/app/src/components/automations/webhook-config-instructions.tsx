import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import * as Clipboard from "expo-clipboard";
import { Button } from "@/components/ui/button";
import { Fonts } from "@/constants/theme";
import {
  WEBHOOK_HOW_TO_SIGN,
  WEBHOOK_METHOD,
  WEBHOOK_PAYLOAD_TEMPLATE_NOTE,
  WEBHOOK_SIGNATURE_TOLERANCE_NOTE,
  buildWebhookCurlExample,
  webhookSignatureHeaderName,
} from "@/lib/automations/webhook-config";

// D-3.5d — the "how to call this webhook" panel, shared by the create-success
// reveal and the webhook detail screen. Renders the verified inbound contract:
// method, signature header + signing recipe, a ready-to-run curl example, and
// the payload-template note. Carries NO secret — it derives everything from the
// public `ingressUrl`, so it is safe on the detail screen where the secret is
// no longer available.
interface WebhookConfigInstructionsProps {
  ingressUrl: string;
}

export function WebhookConfigInstructions({ ingressUrl }: WebhookConfigInstructionsProps) {
  const [copied, setCopied] = useState(false);
  const headerName = useMemo(() => webhookSignatureHeaderName(ingressUrl), [ingressUrl]);
  const curl = useMemo(() => buildWebhookCurlExample({ ingressUrl }), [ingressUrl]);

  const copyCurl = useCallback(() => {
    void Clipboard.setStringAsync(curl);
    setCopied(true);
  }, [curl]);

  return (
    <View style={styles.container} accessibilityLabel="webhook-config-instructions">
      <Text style={styles.heading}>How to call it</Text>

      <View style={styles.row}>
        <Text style={styles.label}>Method</Text>
        <Text style={styles.value} selectable>
          {WEBHOOK_METHOD}
        </Text>
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>Signature header</Text>
        <Text style={styles.value} selectable>
          {headerName}
        </Text>
      </View>

      <Text style={styles.note}>{WEBHOOK_HOW_TO_SIGN}</Text>
      <Text style={styles.note}>{WEBHOOK_SIGNATURE_TOLERANCE_NOTE}</Text>

      <View style={styles.exampleBlock}>
        <Text style={styles.label}>Example request</Text>
        <Text style={styles.code} selectable testID="webhook-curl-example">
          {curl}
        </Text>
        <Button size="sm" variant="secondary" onPress={copyCurl}>
          {copied ? "Copied" : "Copy example"}
        </Button>
      </View>

      <Text style={styles.note}>{WEBHOOK_PAYLOAD_TEMPLATE_NOTE}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
  },
  heading: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  label: {
    fontSize: theme.fontSize.xs,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
  },
  value: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontFamily: Fonts.mono,
  },
  note: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  exampleBlock: {
    gap: theme.spacing[2],
  },
  code: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    fontFamily: Fonts.mono,
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
  },
}));
