import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft } from "lucide-react-native";
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
  OrchestraSessionExpiredError,
  type WorkspaceRecord,
} from "@/lib/orchestra-cloud-client";
import { createWorkspaceTokenTransportFactory } from "@/lib/orchestra-cloud-transport";
import { connectAndProbe, DaemonConnectionTestError } from "@/utils/test-daemon-connection";
import { getOrCreateClientId } from "@/utils/client-id";
import { resolveAppVersion } from "@/utils/app-version";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { extractHostPortFromWebSocketUrl } from "@server/shared/daemon-endpoints";

import {
  filterChoosableWorkspaces,
  setupHeaderTitle,
  setupMintErrorMessage,
  shouldShowWorkspaceChooser,
  workspaceStateBadge,
  type SetupStep,
  type WorkspaceStepView,
} from "./orchestra-setup-helpers";

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
  chooserCreateCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    borderStyle: "dashed",
  },
  chooserCreateLabel: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
}));

const FLEX_ONE_STYLE = { flex: 1 } as const;

export function OrchestraSetupScreen() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<SetupStep>("workspace");
  const [workspaceStepView, setWorkspaceStepView] = useState<WorkspaceStepView>("auto");
  const [displayName, setDisplayName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [workspace, setWorkspace] = useState<WorkspaceRecord | null>(null);
  const [error, setError] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  // Single query keyed on the same key the post-setup picker uses so the
  // chooser and the picker stay in sync after createWorkspace invalidates.
  const workspacesQuery = useQuery<WorkspaceRecord[], Error>({
    queryKey: CLOUD_WORKSPACES_QUERY_KEY,
    queryFn: () => listWorkspaces(),
    enabled: step === "workspace",
    staleTime: 15_000,
    retry: false,
  });
  const choosableWorkspaces = useMemo(
    () => filterChoosableWorkspaces(workspacesQuery.data ?? []),
    [workspacesQuery.data],
  );
  const shouldShowChooser = shouldShowWorkspaceChooser(
    step,
    workspaceStepView,
    choosableWorkspaces,
  );

  const handleBack = useCallback(() => {
    if (step === "workspace") {
      // Workspace step has two sub-views: the create form may be reached
      // EITHER as the auto-render-because-zero-workspaces path (no chooser to
      // return to) OR as the explicit "Create new" pick from the chooser.
      // In the latter case, Back lands on the chooser; in the former, Back
      // returns to /welcome. Preserve any typed form values across the chooser
      // round-trip per the plan.
      if (workspaceStepView === "create") {
        setWorkspaceStepView("auto");
        setError("");
        return;
      }
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
  }, [step, workspaceStepView, router]);

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
      // D-3.5a (T-2) — the cloud workspace shell is created repo-less (name
      // only). Projects are added AFTER connecting to the workspace's daemon
      // (where projectSource + add_project live), via the GitHub project
      // picker. `repoUrl` must be present and explicitly null (the cloud
      // CreateWorkspaceBody schema is `.nullable()`, not `.optional()`).
      const ws = await createWorkspace({
        repoUrl: null,
        displayName: displayName.trim() || undefined,
      });
      // Refresh the cached list so the chooser/picker reflects the new row
      // immediately on a future re-visit.
      void queryClient.invalidateQueries({ queryKey: CLOUD_WORKSPACES_QUERY_KEY });
      setWorkspace(ws);
      setStep("credential");
    } catch (err) {
      // Session-expired bounces via OrchestraSessionProvider — don't render an
      // inline string the user would see for a single frame before the route swap.
      if (err instanceof OrchestraSessionExpiredError) {
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }, [isBusy, displayName, queryClient]);

  const handlePickExistingWorkspace = useCallback((picked: WorkspaceRecord) => {
    setWorkspace(picked);
    setStep("credential");
    setError("");
  }, []);

  const handleSwitchToCreate = useCallback(() => {
    setWorkspaceStepView("create");
    setError("");
  }, []);

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

      const mintResult = await mintWorkspaceToken(fresh.workspaceId);
      if (mintResult.status !== "active") {
        // The workspace was created moments ago in this same flow, so any
        // non-active state here is unexpected (the lifecycle worker hasn't
        // had time to suspend / archive / lock anything yet). Surface a
        // friendly inline error and bounce back to the credential step.
        setStep("credential");
        setError(setupMintErrorMessage(mintResult));
        return;
      }
      const token = mintResult.token;
      // D-3.4: WS URL is derived from the workspaceId so a single app build
      // can address every workspace the user owns. EXPO_PUBLIC_ORCHESTRA_DAEMON_WS_URL
      // remains as a dev-only single-workspace override.
      const wsUrl = getOrchestraDaemonWsUrl(fresh.workspaceId);
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
      if (err instanceof OrchestraSessionExpiredError) {
        // Same as handleCreateWorkspace: defer to the global session-expired
        // bounce; don't paint an inline error the user would see one-frame.
        return;
      }
      // D-3.9: surface the underlying transport-close reason (e.g. "code 1006")
      // in the inline error so a support session can read it without DevTools.
      // See paseo-cloud-daemon/D-3-9-investigation.md.
      if (err instanceof DaemonConnectionTestError) {
        setError(
          `${err.message}${err.lastError && err.lastError !== err.message ? ` (${err.lastError})` : ""}`,
        );
        return;
      }
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
            <Text style={styles.title}>{setupHeaderTitle(step, shouldShowChooser)}</Text>
          </View>

          {step === "workspace" && shouldShowChooser && (
            <WorkspaceChooser
              workspaces={choosableWorkspaces}
              isLoading={workspacesQuery.isLoading}
              onPick={handlePickExistingWorkspace}
              onCreateNew={handleSwitchToCreate}
            />
          )}

          {step === "workspace" && !shouldShowChooser && (
            <WorkspaceStep
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

function WorkspaceChooser({
  workspaces,
  isLoading,
  onPick,
  onCreateNew,
}: {
  workspaces: WorkspaceRecord[];
  isLoading: boolean;
  onPick: (workspace: WorkspaceRecord) => void;
  onCreateNew: () => void;
}) {
  const { theme } = useUnistyles();
  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="small" color={theme.colors.accent} />
      </View>
    );
  }
  return (
    <>
      <Text style={styles.subtitle}>
        Pick a workspace to set credentials on, or create a new one.
      </Text>
      {workspaces.map((entry) => (
        <ChooserExistingWorkspaceCard key={entry.workspaceId} workspace={entry} onPick={onPick} />
      ))}
      <Pressable
        style={styles.chooserCreateCard}
        onPress={onCreateNew}
        accessibilityRole="button"
        accessibilityLabel="Create a new workspace"
        testID="orchestra-create-new-workspace"
      >
        <Plus size={18} color={theme.colors.accent} />
        <Text style={styles.chooserCreateLabel}>Create a new workspace</Text>
      </Pressable>
    </>
  );
}

function ChooserExistingWorkspaceCard({
  workspace,
  onPick,
}: {
  workspace: WorkspaceRecord;
  onPick: (workspace: WorkspaceRecord) => void;
}) {
  const { theme } = useUnistyles();
  const handlePress = useCallback(() => {
    onPick(workspace);
  }, [onPick, workspace]);
  const label =
    workspace.displayName.trim().length > 0 ? workspace.displayName : workspace.workspaceId;
  const badge = workspaceStateBadge(workspace.state);
  const badgeStyle = useMemo(
    () => [styles.workspaceCardSub, { color: theme.colors.destructive }],
    [theme.colors.destructive],
  );
  return (
    <Pressable
      style={styles.workspaceCard}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`Use workspace ${label}`}
      testID={`orchestra-pick-workspace-${workspace.workspaceId}`}
    >
      <View style={FLEX_ONE_STYLE}>
        <Text style={styles.workspaceCardText} numberOfLines={1}>
          {label}
        </Text>
        {workspace.repoUrl ? (
          <Text style={styles.workspaceCardSub} numberOfLines={1}>
            {workspace.repoUrl}
          </Text>
        ) : null}
        {badge ? <Text style={badgeStyle}>{badge}</Text> : null}
      </View>
    </Pressable>
  );
}

function WorkspaceStep({
  displayName,
  setDisplayName,
  error,
  isBusy,
  onSubmit,
}: {
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

  return (
    <>
      {/* D-3.5a (T-2) — name-only create. The workspace is a container; you add
          GitHub projects to it after connecting, via the project picker. No
          repo URL is required (or accepted) here anymore. */}
      <Text style={styles.subtitle}>
        Name your workspace. You&apos;ll add GitHub projects to it after it connects.
      </Text>

      <View style={styles.field}>
        <Text style={styles.label}>Workspace name</Text>
        <AdaptiveTextInput
          testID="orchestra-display-name"
          accessibilityLabel="Workspace name"
          value={displayName}
          onChangeText={setDisplayName}
          placeholder="My workspace"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.input}
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
