import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft, Check } from "lucide-react-native";
import { CLOUD_WORKSPACES_QUERY_KEY } from "@/hooks/use-cloud-workspaces";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import {
  createWorkspace,
  setAnthropicCredential,
  mintWorkspaceToken,
  listWorkspaces,
  clearSession,
  getOrchestraDaemonWsUrl,
  type WorkspaceRecord,
} from "@/lib/orchestra-cloud-client";
import { createWorkspaceTokenTransportFactory } from "@/lib/orchestra-cloud-transport";
import { connectAndProbe } from "@/utils/test-daemon-connection";
import { getOrCreateClientId } from "@/utils/client-id";
import { resolveAppVersion } from "@/utils/app-version";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { extractHostPortFromWebSocketUrl } from "@server/shared/daemon-endpoints";

type SetupStep = "workspace" | "credential" | "connecting" | "done";

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  container: {
    flexGrow: 1,
    padding: theme.spacing[6],
    alignItems: "center",
  },
  content: {
    width: "100%",
    maxWidth: 480,
    gap: theme.spacing[4],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    marginBottom: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.medium,
    flex: 1,
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  field: {
    gap: theme.spacing[2],
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
  center: {
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[4],
    paddingVertical: theme.spacing[8],
  },
  statusText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
  checkboxRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  workspaceCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  workspaceCardActive: {
    borderColor: theme.colors.accent,
  },
  workspaceCardText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  workspaceCardSub: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));

const FLEX_ONE_STYLE = { flex: 1 } as const;

export function OrchestraSetupScreen() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<SetupStep>("workspace");
  const [repoUrl, setRepoUrl] = useState("");
  const [repoLess, setRepoLess] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceRecord | null>(null);
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const handleBack = useCallback(() => {
    if (step === "workspace") {
      void clearSession();
      router.replace("/welcome");
    } else if (step === "credential") {
      // Clear cached workspace/apiKey so the next forward press re-fetches
      // from listWorkspaces() — if a deletion happened out-of-band while the
      // user was on the credential step, we don't carry a dead workspaceId.
      setStep("workspace");
      setWorkspace(null);
      setApiKey("");
      setError("");
    }
  }, [step, router]);

  const reconcileCachedWorkspace = useCallback(async (): Promise<WorkspaceRecord | null> => {
    const list = await listWorkspaces();
    const cachedId = workspace?.workspaceId;
    if (cachedId) {
      const stillExists = list.find((entry) => entry.workspaceId === cachedId);
      if (stillExists) {
        setWorkspace(stillExists);
        return stillExists;
      }
    }
    // Cache miss — workspace was deleted out-of-band, or the list is empty.
    // Reset the wizard to the workspace step with an inline explanation.
    setWorkspace(null);
    setApiKey("");
    setStep("workspace");
    setError("Your workspace is no longer available. Create a new one.");
    return null;
  }, [workspace]);

  const handleCreateWorkspace = useCallback(async () => {
    if (isBusy) return;
    setIsBusy(true);
    setError("");

    try {
      const existing = await listWorkspaces();
      if (existing.length > 0) {
        setWorkspace(existing[0]);
        setStep("credential");
        return;
      }

      const url = repoLess ? null : repoUrl.trim() || null;
      if (!repoLess && !url) {
        setError("Enter a repo URL or check repo-less.");
        return;
      }

      const ws = await createWorkspace({
        repoUrl: url,
        displayName: displayName.trim() || undefined,
      });
      setWorkspace(ws);
      setStep("credential");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }, [isBusy, repoLess, repoUrl, displayName]);

  const handleSetCredential = useCallback(async () => {
    if (isBusy || !workspace) return;
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      setError("Enter your Anthropic API key.");
      return;
    }

    setIsBusy(true);
    setError("");

    try {
      // Re-derive the workspace from the auth service before any mutation —
      // the cached record could be stale if the workspace was deleted while
      // the user was on this step.
      const fresh = await reconcileCachedWorkspace();
      if (!fresh) {
        // reconcileCachedWorkspace already reset the wizard + set error.
        return;
      }

      await setAnthropicCredential(fresh.workspaceId, trimmedKey);
      setStep("connecting");

      const { token } = await mintWorkspaceToken(fresh.workspaceId);
      const wsUrl = getOrchestraDaemonWsUrl();
      const clientId = await getOrCreateClientId();
      const transportFactory = createWorkspaceTokenTransportFactory(token);

      const { client, serverId } = await connectAndProbe(
        {
          url: wsUrl,
          clientId,
          clientType: "browser",
          appVersion: resolveAppVersion() ?? undefined,
          suppressSendErrors: true,
          reconnect: { enabled: false },
          transportFactory,
        },
        10_000,
      );

      // parseHostPort downstream requires a literal `host:port`. When the
      // daemon URL omits the port (ALB on default :80 / :443), the regex
      // strip leaves a bare hostname and fails. Use the URL-aware helper.
      const wsEndpoint = extractHostPortFromWebSocketUrl(wsUrl);
      const store = getHostRuntimeStore();
      await store.upsertDirectConnection({
        serverId,
        endpoint: wsEndpoint,
        useTls: wsUrl.startsWith("wss"),
        workspaceId: fresh.workspaceId,
        label: fresh.displayName ?? fresh.workspaceId,
      });

      void client.close();

      // Refresh the cached cloud workspaces so the project picker on the
      // host screen reflects the just-created workspace immediately.
      void queryClient.invalidateQueries({ queryKey: CLOUD_WORKSPACES_QUERY_KEY });

      setStep("done");
      router.replace(`/h/${serverId}`);
    } catch (err) {
      setStep("credential");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }, [isBusy, workspace, apiKey, router, queryClient, reconcileCachedWorkspace]);

  const scrollContentStyle = useMemo(
    () => [styles.container, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }],
    [insets.top, insets.bottom],
  );

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={scrollContentStyle} showsVerticalScrollIndicator={false}>
        <View style={styles.content}>
          <View style={styles.header}>
            {step !== "connecting" && step !== "done" ? (
              <Pressable onPress={handleBack} accessibilityLabel="Back" testID="orchestra-back">
                <ArrowLeft size={20} color={theme.colors.foreground} />
              </Pressable>
            ) : null}
            <Text style={styles.title}>
              {step === "workspace" && "Create workspace"}
              {step === "credential" && "Anthropic API key"}
              {step === "connecting" && "Connecting..."}
              {step === "done" && "Connected"}
            </Text>
          </View>

          {step === "workspace" && (
            <WorkspaceStep
              repoUrl={repoUrl}
              setRepoUrl={setRepoUrl}
              repoLess={repoLess}
              setRepoLess={setRepoLess}
              displayName={displayName}
              setDisplayName={setDisplayName}
              error={error}
              isBusy={isBusy}
              onSubmit={handleCreateWorkspace}
            />
          )}

          {step === "credential" && (
            <CredentialStep
              apiKey={apiKey}
              setApiKey={setApiKey}
              workspaceName={workspace?.displayName ?? workspace?.workspaceId ?? ""}
              error={error}
              isBusy={isBusy}
              onSubmit={handleSetCredential}
            />
          )}

          {(step === "connecting" || step === "done") && (
            <View style={styles.center}>
              {step === "connecting" ? (
                <ActivityIndicator size="large" color={theme.colors.accent} />
              ) : null}
              <Text style={styles.statusText}>
                {step === "connecting"
                  ? "Minting token and connecting to daemon..."
                  : "Connected! Redirecting..."}
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function WorkspaceStep({
  repoUrl,
  setRepoUrl,
  repoLess,
  setRepoLess,
  displayName,
  setDisplayName,
  error,
  isBusy,
  onSubmit,
}: {
  repoUrl: string;
  setRepoUrl: (v: string) => void;
  repoLess: boolean;
  setRepoLess: (v: boolean) => void;
  displayName: string;
  setDisplayName: (v: string) => void;
  error: string;
  isBusy: boolean;
  onSubmit: () => void;
}) {
  const { theme } = useUnistyles();

  const handleSubmit = useCallback(() => {
    onSubmit();
  }, [onSubmit]);

  const toggleRepoLess = useCallback(() => {
    setRepoLess(!repoLess);
  }, [repoLess, setRepoLess]);

  const checkboxStyle = useMemo(
    () => [styles.checkbox, repoLess ? styles.checkboxChecked : null],
    [repoLess],
  );

  return (
    <>
      <Text style={styles.subtitle}>
        Point a workspace at a GitHub repo, or create a repo-less workspace to explore ideas.
      </Text>

      <View style={styles.field}>
        <Text style={styles.label}>GitHub repo URL</Text>
        <AdaptiveTextInput
          testID="orchestra-repo-url"
          accessibilityLabel="GitHub repo URL"
          value={repoUrl}
          onChangeText={setRepoUrl}
          placeholder="https://github.com/owner/repo"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          editable={!isBusy && !repoLess}
        />
      </View>

      <Pressable
        style={styles.checkboxRow}
        onPress={toggleRepoLess}
        disabled={isBusy}
        accessibilityRole="checkbox"
        accessibilityLabel="Repo-less workspace"
        testID="orchestra-repoless-toggle"
      >
        <View style={checkboxStyle}>
          {repoLess ? <Check size={14} color={theme.colors.palette.white} /> : null}
        </View>
        <Text style={styles.label}>Repo-less workspace</Text>
      </Pressable>

      <View style={styles.field}>
        <Text style={styles.label}>Display name (optional)</Text>
        <AdaptiveTextInput
          testID="orchestra-display-name"
          accessibilityLabel="Display name"
          value={displayName}
          onChangeText={setDisplayName}
          placeholder="My Project"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.input}
          editable={!isBusy}
        />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.actions}>
        <Button
          style={FLEX_ONE_STYLE}
          variant="default"
          onPress={handleSubmit}
          disabled={isBusy}
          testID="orchestra-create-workspace"
        >
          {isBusy ? "Creating..." : "Create workspace"}
        </Button>
      </View>
    </>
  );
}

function CredentialStep({
  apiKey,
  setApiKey,
  workspaceName,
  error,
  isBusy,
  onSubmit,
}: {
  apiKey: string;
  setApiKey: (v: string) => void;
  workspaceName: string;
  error: string;
  isBusy: boolean;
  onSubmit: () => void;
}) {
  const { theme } = useUnistyles();

  const handleSubmit = useCallback(() => {
    onSubmit();
  }, [onSubmit]);

  return (
    <>
      <Text style={styles.subtitle}>
        {`Workspace "${workspaceName}" is ready. Paste your Anthropic API key to enable agent runs.`}
      </Text>

      <View style={styles.field}>
        <Text style={styles.label}>Anthropic API key</Text>
        <AdaptiveTextInput
          testID="orchestra-api-key"
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
          onSubmitEditing={handleSubmit}
        />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.actions}>
        <Button
          style={FLEX_ONE_STYLE}
          variant="default"
          onPress={handleSubmit}
          disabled={isBusy}
          testID="orchestra-set-credential"
        >
          {isBusy ? "Saving..." : "Continue"}
        </Button>
      </View>
    </>
  );
}
