import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type PressableStateCallbackType,
} from "react-native";
import { Github, Lock } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useQuery } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProjectDescriptorPayload } from "@getpaseo/protocol/messages";
import { listGithubRepos, type GithubRepoSummary } from "@/lib/orchestra-cloud-client";
import {
  GITHUB_PICKER_EMPTY,
  GITHUB_PICKER_SEARCH_PLACEHOLDER,
  GITHUB_PICKER_TITLE,
  PROJECT_CLONE_PROGRESS_COPY,
} from "@/lib/cloud-workspace-copy";
import { isNative } from "@/constants/platform";

// D-3.5a (app T-3) — the GitHub project picker. Lists the signed-in user's
// repos from the cloud repo-list proxy and adds the chosen one to the current
// workspace container via the daemon's `add_project` RPC (which clones it).
// `repoUrl` sent to the daemon is the credential-free `cloneUrl`; the token is
// injected server-side at clone time.
//
// Scope: this is the CLOUD path (the repo-list endpoint is cloud-proprietary).
// Self-host `local_and_github` keeps the existing manual-URL / searchGitHub
// affordance (OQ-1) and does not mount this rich enumerator.

export interface GithubRepoPickerProps {
  visible: boolean;
  onClose: () => void;
  // The daemon-side workspace container the project is added to.
  workspaceId: string;
  client: Pick<DaemonClient, "addProjectFromSource">;
  // Called with the added project so the host can refresh its list / open it.
  onProjectAdded: (project: ProjectDescriptorPayload) => void;
}

interface RepoRowProps {
  repo: GithubRepoSummary;
  disabled: boolean;
  onSelect: (repo: GithubRepoSummary) => void;
}

function RepoRow({ repo, disabled, onSelect }: RepoRowProps) {
  const { theme } = useUnistyles();
  const handlePress = useCallback(() => {
    onSelect(repo);
  }, [onSelect, repo]);
  const pressableStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (Boolean(hovered) || pressed) && { backgroundColor: theme.colors.surface1 },
      disabled && styles.rowDisabled,
    ],
    [disabled, theme.colors.surface1],
  );
  const rowTextStyle = useMemo(
    () => [styles.rowText, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const subTextStyle = useMemo(
    () => [styles.rowSubText, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  return (
    <Pressable
      style={pressableStyle}
      onPress={handlePress}
      disabled={disabled}
      testID={`github-repo-row-${repo.fullName}`}
    >
      <View style={styles.rowContent}>
        <View style={styles.iconSlot}>
          <Github size={16} strokeWidth={2.2} color={theme.colors.foregroundMuted} />
        </View>
        <View style={styles.rowTextColumn}>
          <Text style={rowTextStyle} numberOfLines={1}>
            {repo.fullName}
          </Text>
          <Text style={subTextStyle} numberOfLines={1}>
            {repo.defaultBranch}
          </Text>
        </View>
        {repo.private ? (
          <Lock size={13} strokeWidth={2.2} color={theme.colors.foregroundMuted} />
        ) : null}
      </View>
    </Pressable>
  );
}

export function GithubRepoPicker({
  visible,
  onClose,
  workspaceId,
  client,
  onProjectAdded,
}: GithubRepoPickerProps) {
  const { theme } = useUnistyles();
  const inputRef = useRef<TextInput>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [addingRepo, setAddingRepo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = search.trim();
    const timer = setTimeout(() => setDebouncedSearch(trimmed), 200);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (visible) {
      setSearch("");
      setDebouncedSearch("");
      setError(null);
      setAddingRepo(null);
      const id = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
  }, [visible]);

  const reposQuery = useQuery({
    queryKey: ["github-repos", debouncedSearch],
    queryFn: () => listGithubRepos({ search: debouncedSearch || undefined, perPage: 50 }),
    enabled: visible,
    staleTime: 30_000,
    retry: false,
  });

  const handleSelect = useCallback(
    (repo: GithubRepoSummary) => {
      if (addingRepo) return;
      setAddingRepo(repo.fullName);
      setError(null);
      void (async () => {
        try {
          const payload = await client.addProjectFromSource({
            workspaceId,
            source: { kind: "github_repo", repoUrl: repo.cloneUrl },
          });
          if (payload.error || !payload.project) {
            setError(payload.error ?? "Failed to add project");
            setAddingRepo(null);
            return;
          }
          onProjectAdded(payload.project);
          setAddingRepo(null);
          onClose();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          setAddingRepo(null);
        }
      })();
    },
    [addingRepo, client, onClose, onProjectAdded, workspaceId],
  );

  const handleClose = useCallback(() => {
    if (addingRepo) return;
    onClose();
  }, [addingRepo, onClose]);

  const panelStyle = useMemo(
    () => [
      styles.panel,
      { borderColor: theme.colors.border, backgroundColor: theme.colors.surface0 },
    ],
    [theme.colors.border, theme.colors.surface0],
  );
  const headerStyle = useMemo(
    () => [styles.header, { borderBottomColor: theme.colors.border }],
    [theme.colors.border],
  );
  const titleStyle = useMemo(
    () => [styles.title, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const inputStyle = useMemo(
    () => [styles.input, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const emptyTextStyle = useMemo(
    () => [styles.emptyText, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  const errorTextStyle = useMemo(
    () => [styles.emptyText, { color: theme.colors.destructive }],
    [theme.colors.destructive],
  );

  const repos = reposQuery.data?.repos ?? [];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={handleClose} />
        <View style={panelStyle} testID="github-repo-picker">
          <View style={headerStyle}>
            <Text style={titleStyle}>{GITHUB_PICKER_TITLE}</Text>
            <TextInput
              ref={inputRef}
              value={search}
              onChangeText={setSearch}
              placeholder={GITHUB_PICKER_SEARCH_PLACEHOLDER}
              placeholderTextColor={theme.colors.foregroundMuted}
              style={inputStyle}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus={!isNative}
              editable={addingRepo === null}
            />
          </View>

          <ScrollView
            style={styles.results}
            contentContainerStyle={styles.resultsContent}
            keyboardShouldPersistTaps="always"
            showsVerticalScrollIndicator={false}
          >
            {addingRepo ? (
              <View style={styles.statusRow}>
                <ActivityIndicator size="small" color={theme.colors.accent} />
                <Text style={emptyTextStyle}>{PROJECT_CLONE_PROGRESS_COPY}</Text>
              </View>
            ) : null}
            {!addingRepo && reposQuery.isLoading ? (
              <View style={styles.statusRow}>
                <ActivityIndicator size="small" color={theme.colors.accent} />
              </View>
            ) : null}
            {!addingRepo && reposQuery.isError ? (
              <Text style={errorTextStyle}>
                {reposQuery.error instanceof Error
                  ? reposQuery.error.message
                  : "Failed to load repositories."}
              </Text>
            ) : null}
            {error ? <Text style={errorTextStyle}>{error}</Text> : null}
            {!addingRepo && !reposQuery.isLoading && !reposQuery.isError && repos.length === 0 ? (
              <Text style={emptyTextStyle}>{GITHUB_PICKER_EMPTY}</Text>
            ) : null}
            {repos.map((repo) => (
              <RepoRow
                key={repo.fullName}
                repo={repo}
                disabled={addingRepo !== null}
                onSelect={handleSelect}
              />
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    flex: 1,
    justifyContent: "flex-start",
    alignItems: "center",
    paddingTop: theme.spacing[12],
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  panel: {
    width: 640,
    maxWidth: "92%",
    maxHeight: "80%",
    borderWidth: 1,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    ...theme.shadow.lg,
  },
  header: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    gap: theme.spacing[2],
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  input: {
    fontSize: theme.fontSize.lg,
    paddingVertical: theme.spacing[1],
    outlineStyle: "none",
  } as object,
  results: {
    flexGrow: 0,
  },
  resultsContent: {
    paddingVertical: theme.spacing[2],
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
  },
  row: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  rowDisabled: {
    opacity: 0.5,
  },
  rowContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  iconSlot: {
    width: 16,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTextColumn: {
    flex: 1,
    flexShrink: 1,
  },
  rowText: {
    fontSize: theme.fontSize.base,
    fontWeight: "400",
    lineHeight: 20,
    flexShrink: 1,
  },
  rowSubText: {
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
  },
  emptyText: {
    fontSize: theme.fontSize.base,
  },
}));
