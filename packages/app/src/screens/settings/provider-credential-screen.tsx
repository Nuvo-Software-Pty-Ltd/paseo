import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  getAccountCredentialStatus,
  setAccountAnthropicCredential,
  removeAccountAnthropicCredential,
  OrchestraSessionExpiredError,
  type AccountCredentialStatus,
} from "@/lib/orchestra-cloud-client";

const ACCOUNT_CREDENTIAL_STATUS_QUERY_KEY = ["orchestra", "account-credential-status"] as const;

// Write-only: the page NEVER reads or renders the stored credential value, only
// the {set, updatedAt} metadata. The credential is per-account (D-3.5b) — set
// once here, inherited by every workspace, never re-entered on resume.
export function ProviderCredentialScreen() {
  const { theme } = useUnistyles();
  const queryClient = useQueryClient();

  const statusQuery = useQuery<AccountCredentialStatus, Error>({
    queryKey: ACCOUNT_CREDENTIAL_STATUS_QUERY_KEY,
    queryFn: () => getAccountCredentialStatus(),
    staleTime: 10_000,
    retry: false,
  });

  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const isSet = statusQuery.data?.set ?? false;

  const refreshStatus = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ACCOUNT_CREDENTIAL_STATUS_QUERY_KEY });
  }, [queryClient]);

  const handleSave = useCallback(async () => {
    if (isBusy) return;
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setError("Enter your Anthropic API key.");
      return;
    }
    setIsBusy(true);
    setError("");
    try {
      await setAccountAnthropicCredential(trimmed);
      setApiKey("");
      refreshStatus();
    } catch (err) {
      if (err instanceof OrchestraSessionExpiredError) {
        return;
      }
      // Surface the auth service's live-validation error (e.g. 400 "Invalid
      // Anthropic API key") verbatim so a mistyped key fails fast here.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }, [isBusy, apiKey, refreshStatus]);

  const handleRemove = useCallback(async () => {
    if (isBusy) return;
    const confirmed = await confirmDialog({
      title: "Remove Anthropic key",
      message:
        "Remove your account Anthropic key? Agent runs across all your workspaces will fail until you set a new one.",
      confirmLabel: "Remove",
      cancelLabel: "Cancel",
      destructive: true,
    });
    if (!confirmed) return;
    setIsBusy(true);
    setError("");
    try {
      await removeAccountAnthropicCredential();
      setApiKey("");
      refreshStatus();
    } catch (err) {
      if (err instanceof OrchestraSessionExpiredError) {
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }, [isBusy, refreshStatus]);

  return (
    <SettingsSection title="Provider credential">
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Anthropic API key</Text>
            <Text style={settingsStyles.rowHint}>{describeStatus(statusQuery)}</Text>
          </View>
        </View>
      </View>

      <View style={styles.formCard}>
        <Text style={styles.label}>{isSet ? "Replace key" : "Set key"}</Text>
        <AdaptiveTextInput
          testID="provider-credential-input"
          accessibilityLabel="Anthropic API key"
          value={apiKey}
          onChangeText={setApiKey}
          placeholder="sk-ant-..."
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          editable={!isBusy}
          onSubmitEditing={handleSave}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.actions}>
          <Button
            variant="default"
            onPress={handleSave}
            disabled={isBusy}
            loading={isBusy}
            testID="provider-credential-save"
          >
            {isSet ? "Replace" : "Save"}
          </Button>
          {isSet ? (
            <Button
              variant="destructive"
              onPress={handleRemove}
              disabled={isBusy}
              testID="provider-credential-remove"
            >
              Remove
            </Button>
          ) : null}
        </View>
      </View>
    </SettingsSection>
  );
}

// Status line copy. Never references the credential value — only metadata.
function describeStatus(query: UseQueryResult<AccountCredentialStatus, Error>): string {
  if (query.isLoading) return "Checking…";
  if (query.isError) return "Couldn't check key status.";
  const data = query.data;
  if (!data?.set) return "No key set. Add one to run agents in the cloud.";
  const updated = formatUpdatedAt(data.updatedAt);
  return updated ? `Anthropic key set · updated ${updated}` : "Anthropic key set";
}

function formatUpdatedAt(updatedAt: string | undefined): string | null {
  if (!updatedAt) return null;
  const parsed = new Date(updatedAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString();
}

const styles = StyleSheet.create((theme) => ({
  formCard: {
    gap: theme.spacing[2],
    marginTop: theme.spacing[4],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  input: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[3],
    marginTop: theme.spacing[2],
  },
}));
