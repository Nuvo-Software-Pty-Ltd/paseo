import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type PressableStateCallbackType,
} from "react-native";
import { Archive, Cloud, Folder, FolderPlus, Github } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useQuery } from "@tanstack/react-query";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { shortenPath } from "@/utils/shorten-path";
import { useProjectSource, useRecommendedProjectPaths } from "@/stores/session-store-hooks";
import { projectSourceAllowsGithub, projectSourceAllowsLocalDirectory } from "@/lib/project-source";
import { GithubRepoPicker } from "@/components/github-repo-picker";
import { ADD_PROJECT_LABEL } from "@/lib/cloud-workspace-copy";
import type { ProjectDescriptorPayload } from "@getpaseo/protocol/messages";
import {
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
  useIsCloudHost,
} from "@/runtime/host-runtime";
import { useOpenProject } from "@/hooks/use-open-project";
import { useCloudWorkspaces } from "@/hooks/use-cloud-workspaces";
import { isNative } from "@/constants/platform";
import { useRouter, type Href } from "expo-router";
import { useActiveServerId } from "@/hooks/use-active-server-id";
import { useArchiveCloudWorkspace } from "@/hooks/use-archive-cloud-workspace";
import { useUnarchiveWorkspace } from "@/hooks/use-unarchive-workspace";
import { useToast } from "@/contexts/toast-context";
import {
  ARCHIVE_30_DAY_NOTICE,
  BILLING_LOCKED_PLAN_INACTIVE_BADGE,
  UNARCHIVE_TOAST_COPY,
} from "@/lib/cloud-workspace-copy";
import type { WorkspaceRecord } from "@/lib/orchestra-cloud-client";
import { partitionCloudWorkspaces } from "@/utils/cloud-workspace-sections";
import { formatTimeAgo } from "@/utils/time";
import { showCloudWorkspaceArchiveDialog } from "@/components/cloud-workspace-archive-dialog";
import {
  buildProjectPickerOptions,
  isOpenableProjectPath,
  type ProjectPickerOption,
} from "./project-picker-options";

interface PathRowProps {
  option: ProjectPickerOption;
  active: boolean;
  openPathLabel: string;
  onSelect: (path: string) => void;
}

interface CloudWorkspaceRowProps {
  workspace: WorkspaceRecord;
  onSelect: (workspace: WorkspaceRecord) => void;
  onArchive: (workspace: WorkspaceRecord) => void;
  isArchiving: boolean;
}

interface ArchivedWorkspaceRowProps {
  workspace: WorkspaceRecord;
  onSelect: (workspace: WorkspaceRecord) => void;
  onUnarchive: (workspace: WorkspaceRecord) => void;
  isUnarchiving: boolean;
}

interface ArchivedSectionProps {
  workspaces: WorkspaceRecord[];
  onSelect: (workspace: WorkspaceRecord) => void;
  onUnarchive: (workspace: WorkspaceRecord) => void;
  unarchivingWorkspaceId: string | null;
}

function ArchivedSection({
  workspaces,
  onSelect,
  onUnarchive,
  unarchivingWorkspaceId,
}: ArchivedSectionProps) {
  const { theme } = useUnistyles();
  const sectionHeaderStyle = useMemo(
    () => [styles.sectionHeader, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  const footerStyle = useMemo(
    () => [styles.archivedFooter, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  if (workspaces.length === 0) {
    return null;
  }
  return (
    <View style={styles.section}>
      <Text style={sectionHeaderStyle}>Archived</Text>
      {workspaces.map((workspace) => (
        <ArchivedWorkspaceRow
          key={workspace.workspaceId}
          workspace={workspace}
          onSelect={onSelect}
          onUnarchive={onUnarchive}
          isUnarchiving={unarchivingWorkspaceId === workspace.workspaceId}
        />
      ))}
      <Text style={footerStyle}>{ARCHIVE_30_DAY_NOTICE}</Text>
    </View>
  );
}

function ArchivedWorkspaceRow({
  workspace,
  onSelect,
  onUnarchive,
  isUnarchiving,
}: ArchivedWorkspaceRowProps) {
  const { theme } = useUnistyles();
  const handlePress = useCallback(() => {
    onSelect(workspace);
  }, [onSelect, workspace]);
  const handleUnarchive = useCallback(
    (event: { stopPropagation?: () => void }) => {
      event.stopPropagation?.();
      onUnarchive(workspace);
    },
    [onUnarchive, workspace],
  );
  const pressableStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (Boolean(hovered) || pressed) && {
        backgroundColor: theme.colors.surface1,
      },
    ],
    [theme.colors.surface1],
  );
  const rowTextStyle = useMemo(
    () => [styles.rowText, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  const subTextStyle = useMemo(
    () => [styles.rowSubText, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  const unarchiveButtonStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.unarchiveButton,
      {
        borderColor: theme.colors.border,
        backgroundColor:
          Boolean(hovered) || pressed ? theme.colors.surface2 : theme.colors.surface1,
      },
    ],
    [theme.colors.border, theme.colors.surface1, theme.colors.surface2],
  );
  const unarchiveButtonTextStyle = useMemo(
    () => [styles.unarchiveButtonText, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const displayLabel =
    workspace.displayName.trim().length > 0 ? workspace.displayName : workspace.workspaceId;
  const archivedLabel = useMemo(() => {
    if (!workspace.archivedAt) {
      return "Archived";
    }
    const parsed = new Date(workspace.archivedAt);
    if (Number.isNaN(parsed.getTime())) {
      return "Archived";
    }
    return `Archived ${formatTimeAgo(parsed)}`;
  }, [workspace.archivedAt]);
  return (
    <Pressable style={pressableStyle} onPress={handlePress} testID="picker-archived-row">
      <View style={styles.rowContent}>
        <View style={styles.iconSlot}>
          <Archive size={16} strokeWidth={2.2} color={theme.colors.foregroundMuted} />
        </View>
        <View style={styles.rowTextColumn}>
          <Text style={rowTextStyle} numberOfLines={1}>
            {displayLabel}
          </Text>
          <Text style={subTextStyle} numberOfLines={1}>
            {archivedLabel}
          </Text>
        </View>
        <Pressable
          accessibilityLabel="Unarchive workspace"
          testID="picker-archived-unarchive"
          onPress={handleUnarchive}
          disabled={isUnarchiving}
          style={unarchiveButtonStyle}
        >
          <Text style={unarchiveButtonTextStyle}>
            {isUnarchiving ? "Unarchiving…" : "Unarchive"}
          </Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

function CloudWorkspaceRow({
  workspace,
  onSelect,
  onArchive,
  isArchiving,
}: CloudWorkspaceRowProps) {
  const { theme } = useUnistyles();
  const handlePress = useCallback(() => {
    onSelect(workspace);
  }, [onSelect, workspace]);
  const handleArchive = useCallback(
    (event: { stopPropagation?: () => void }) => {
      event.stopPropagation?.();
      onArchive(workspace);
    },
    [onArchive, workspace],
  );
  const pressableStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (Boolean(hovered) || pressed) && {
        backgroundColor: theme.colors.surface1,
      },
    ],
    [theme.colors.surface1],
  );
  const rowTextStyle = useMemo(
    () => [styles.rowText, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const subTextStyle = useMemo(
    () => [styles.rowSubText, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  const planInactiveBadgeStyle = useMemo(
    () => [styles.rowSubText, { color: theme.colors.destructive }],
    [theme.colors.destructive],
  );
  const archiveButtonStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.unarchiveButton,
      {
        borderColor: theme.colors.border,
        backgroundColor:
          Boolean(hovered) || pressed ? theme.colors.surface2 : theme.colors.surface1,
      },
    ],
    [theme.colors.border, theme.colors.surface1, theme.colors.surface2],
  );
  const archiveButtonTextStyle = useMemo(
    () => [styles.unarchiveButtonText, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const displayLabel =
    workspace.displayName.trim().length > 0 ? workspace.displayName : workspace.workspaceId;
  let subRow: React.ReactNode = null;
  if (workspace.state === "billing_locked") {
    subRow = (
      <Text style={planInactiveBadgeStyle} numberOfLines={1}>
        {BILLING_LOCKED_PLAN_INACTIVE_BADGE}
      </Text>
    );
  } else if (workspace.repoUrl) {
    subRow = (
      <Text style={subTextStyle} numberOfLines={1}>
        {workspace.repoUrl}
      </Text>
    );
  }
  return (
    <Pressable style={pressableStyle} onPress={handlePress}>
      <View style={styles.rowContent}>
        <View style={styles.iconSlot}>
          <Cloud size={16} strokeWidth={2.2} color={theme.colors.foregroundMuted} />
        </View>
        <View style={styles.rowTextColumn}>
          <Text style={rowTextStyle} numberOfLines={1}>
            {displayLabel}
          </Text>
          {subRow}
        </View>
        <Pressable
          accessibilityLabel="Archive workspace"
          testID="picker-cloud-archive"
          onPress={handleArchive}
          disabled={isArchiving}
          style={archiveButtonStyle}
        >
          <Text style={archiveButtonTextStyle}>{isArchiving ? "Archiving…" : "Archive"}</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

function PathRow({ option, active, openPathLabel, onSelect }: PathRowProps) {
  const { theme } = useUnistyles();
  const Icon = option.kind === "path" ? FolderPlus : Folder;
  const path = option.path;
  const displayPath = shortenPath(path);
  const label = option.kind === "path" ? `${openPathLabel}: ${displayPath}` : displayPath;
  const handlePress = useCallback(() => {
    onSelect(path);
  }, [onSelect, path]);
  const pressableStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (Boolean(hovered) || pressed || active) && {
        backgroundColor: theme.colors.surface1,
      },
    ],
    [active, theme.colors.surface1],
  );
  const rowTextStyle = useMemo(
    () => [styles.rowText, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  return (
    <Pressable style={pressableStyle} onPress={handlePress}>
      <View style={styles.rowContent}>
        <View style={styles.iconSlot}>
          <Icon size={16} strokeWidth={2.2} color={theme.colors.foregroundMuted} />
        </View>
        <Text style={rowTextStyle} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

// D-3.5a (T-3) — the entry point that opens the GitHub repo picker. Lives in
// the GitHub source section; visible only when the daemon allows the GitHub
// source (capability-gated upstream).
function AddGithubRepoRow({
  label,
  busy,
  disabled,
  onPress,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const { theme } = useUnistyles();
  const pressableStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (Boolean(hovered) || pressed) && { backgroundColor: theme.colors.surface1 },
      disabled && { opacity: 0.5 },
    ],
    [disabled, theme.colors.surface1],
  );
  const rowTextStyle = useMemo(
    () => [styles.rowText, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  return (
    <Pressable
      style={pressableStyle}
      onPress={onPress}
      disabled={disabled}
      testID="picker-add-github-repo"
    >
      <View style={styles.rowContent}>
        <View style={styles.iconSlot}>
          <Github size={16} strokeWidth={2.2} color={theme.colors.foregroundMuted} />
        </View>
        <Text style={rowTextStyle} numberOfLines={1}>
          {busy ? "Opening…" : label}
        </Text>
      </View>
    </Pressable>
  );
}

// D-3.5a (T-3) — encapsulates the GitHub source's container resolution + add
// flow so the picker modal stays under the complexity budget.
// D-3.5a (T-3) — the GitHub source section of the picker. Capability-gated by
// the caller (`visible`); extracted to keep ProjectPickerModal under the
// complexity budget.
function GithubSourceSection({
  visible,
  busy,
  disabled,
  error,
  onAdd,
}: {
  visible: boolean;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onAdd: () => void;
}) {
  const { theme } = useUnistyles();
  const sectionHeaderStyle = useMemo(
    () => [styles.sectionHeader, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  const errorStyle = useMemo(
    () => [styles.emptyText, { color: theme.colors.destructive }],
    [theme.colors.destructive],
  );
  if (!visible) {
    return null;
  }
  return (
    <View style={styles.section}>
      <Text style={sectionHeaderStyle}>GitHub</Text>
      <AddGithubRepoRow label={ADD_PROJECT_LABEL} busy={busy} disabled={disabled} onPress={onAdd} />
      {error ? <Text style={errorStyle}>{error}</Text> : null}
    </View>
  );
}

function usePickerGithubSource(
  client: ReturnType<typeof useHostRuntimeClient>,
  onProjectOpen: (path: string) => Promise<void>,
) {
  const [githubWorkspaceId, setGithubWorkspaceId] = useState<string | null>(null);
  const [isResolvingContainer, setIsResolvingContainer] = useState(false);
  const [containerError, setContainerError] = useState<string | null>(null);

  const openGithubPicker = useCallback(() => {
    if (!client || isResolvingContainer) {
      return;
    }
    setIsResolvingContainer(true);
    setContainerError(null);
    void (async () => {
      try {
        // createWorkspaceContainer is idempotent in cloud — it returns the
        // existing ambient container (authoritative id) without renaming it.
        const result = await client.createWorkspaceContainer("");
        if (result.workspace) {
          setGithubWorkspaceId(result.workspace.workspaceId);
        } else {
          setContainerError(result.error ?? "Couldn't open this workspace");
        }
      } catch (err) {
        setContainerError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsResolvingContainer(false);
      }
    })();
  }, [client, isResolvingContainer]);

  const closeGithubPicker = useCallback(() => {
    setGithubWorkspaceId(null);
  }, []);

  const handleProjectAdded = useCallback(
    (project: ProjectDescriptorPayload) => {
      setGithubWorkspaceId(null);
      void onProjectOpen(project.rootPath);
    },
    [onProjectOpen],
  );

  return {
    githubWorkspaceId,
    isResolvingContainer,
    containerError,
    openGithubPicker,
    closeGithubPicker,
    handleProjectAdded,
  };
}

// D-3.5a (T-6) — the cwd to open for a cloud workspace. A repo-bound workspace
// opens its canonical clone; a repo-less / empty workspace (repoUrl null) opens
// the container root, which the daemon resolves to an empty workspace (no clone,
// no error) instead of the old hard `.git-canonical` assumption.
export function cloudWorkspaceOpenPath(workspace: WorkspaceRecord): string {
  return workspace.repoUrl
    ? `/workspace/${workspace.workspaceId}/.git-canonical`
    : `/workspace/${workspace.workspaceId}`;
}

interface PickerResultsBodyProps {
  isSubmitting: boolean;
  allowLocalDir: boolean;
  allowGithub: boolean;
  isCloudHost: boolean;
  githubBusy: boolean;
  githubDisabled: boolean;
  githubError: string | null;
  onAddGithub: () => void;
  options: ProjectPickerOption[];
  openPathLabel: string;
  activeIndex: number;
  query: string;
  activeCloudWorkspaces: WorkspaceRecord[];
  archivedCloudWorkspaces: WorkspaceRecord[];
  archivingWorkspaceId: string | null;
  unarchivingWorkspaceId: string | null;
  onSelectPath: (path: string) => void;
  onSelectCloudWorkspace: (workspace: WorkspaceRecord) => void;
  onArchiveCloudWorkspace: (workspace: WorkspaceRecord) => void;
  onOpenArchivedWorkspace: (workspace: WorkspaceRecord) => void;
  onUnarchiveOnly: (workspace: WorkspaceRecord) => void;
}

// Extracted from ProjectPickerModal to keep that function under the complexity
// budget. Renders the scrollable result list: GitHub source, local-directory
// suggestions, active cloud workspaces, and the archived section.
function PickerResultsBody(props: PickerResultsBodyProps) {
  const { theme } = useUnistyles();
  const emptyTextStyle = useMemo(
    () => [styles.emptyText, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  const sectionHeaderStyle = useMemo(
    () => [styles.sectionHeader, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  const showLocalEmptyHint =
    !props.isSubmitting && props.allowLocalDir && props.options.length === 0 && !props.query.trim();
  const showActiveCloud =
    !props.isSubmitting && props.isCloudHost && props.activeCloudWorkspaces.length > 0;
  const showOptions = !props.isSubmitting && !(props.options.length === 0 && !props.query.trim());
  return (
    <ScrollView
      style={styles.results}
      contentContainerStyle={styles.resultsContent}
      keyboardShouldPersistTaps="always"
      showsVerticalScrollIndicator={false}
    >
      {props.isSubmitting ? <Text style={emptyTextStyle}>Opening project...</Text> : null}
      <GithubSourceSection
        visible={!props.isSubmitting && props.allowGithub && props.isCloudHost}
        busy={props.githubBusy}
        disabled={props.githubDisabled}
        error={props.githubError}
        onAdd={props.onAddGithub}
      />
      {showLocalEmptyHint ? <Text style={emptyTextStyle}>Start typing a path</Text> : null}
      {showActiveCloud ? (
        <View style={styles.section}>
          <Text style={sectionHeaderStyle}>Cloud workspaces</Text>
          {props.activeCloudWorkspaces.map((workspace) => (
            <CloudWorkspaceRow
              key={workspace.workspaceId}
              workspace={workspace}
              onSelect={props.onSelectCloudWorkspace}
              onArchive={props.onArchiveCloudWorkspace}
              isArchiving={props.archivingWorkspaceId === workspace.workspaceId}
            />
          ))}
        </View>
      ) : null}
      {showOptions
        ? props.options.map((option, index) => (
            <PathRow
              key={`${option.kind}:${option.path}`}
              option={option}
              openPathLabel={props.openPathLabel}
              active={index === props.activeIndex}
              onSelect={props.onSelectPath}
            />
          ))
        : null}
      {!props.isSubmitting && props.isCloudHost ? (
        <ArchivedSection
          workspaces={props.archivedCloudWorkspaces}
          onSelect={props.onOpenArchivedWorkspace}
          onUnarchive={props.onUnarchiveOnly}
          unarchivingWorkspaceId={props.unarchivingWorkspaceId}
        />
      ) : null}
    </ScrollView>
  );
}

function usePickerUnarchiveBinding() {
  const unarchive = useUnarchiveWorkspace();
  const unarchivingWorkspaceId = unarchive.isPending
    ? (unarchive.variables?.workspaceId ?? null)
    : null;
  return {
    unarchiveMutate: unarchive.mutate,
    unarchiveMutateAsync: unarchive.mutateAsync,
    unarchivingWorkspaceId,
  };
}

function usePickerArchiveBinding() {
  const archive = useArchiveCloudWorkspace();
  const archivingWorkspaceId = archive.isPending ? (archive.variables?.workspaceId ?? null) : null;
  return {
    archiveMutate: archive.mutate,
    archivingWorkspaceId,
  };
}

export function ProjectPickerModal() {
  const { theme } = useUnistyles();
  const serverId = useActiveServerId();

  const open = useKeyboardShortcutsStore((s) => s.projectPickerOpen);
  const setOpen = useKeyboardShortcutsStore((s) => s.setProjectPickerOpen);

  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const recommendedPaths = useRecommendedProjectPaths(serverId);
  const isCloudHost = useIsCloudHost(serverId);

  const inputRef = useRef<TextInput>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const openProject = useOpenProject(serverId);

  // D-3.5a (T-5) — the picker's sources are decided ONLY by the connected
  // daemon's capability, never by a cloud/platform constant.
  const projectSource = useProjectSource(serverId);
  const allowLocalDir = projectSourceAllowsLocalDirectory(projectSource);
  const allowGithub = projectSourceAllowsGithub(projectSource);

  const cloudWorkspacesQuery = useCloudWorkspaces(serverId, {
    enabled: isCloudHost && open,
  });
  const cloudWorkspacesData = cloudWorkspacesQuery.data;
  const { activeCloudWorkspaces, archivedCloudWorkspaces } = useMemo(
    () => partitionCloudWorkspaces(cloudWorkspacesData ?? []),
    [cloudWorkspacesData],
  );
  const { unarchiveMutateAsync, unarchiveMutate, unarchivingWorkspaceId } =
    usePickerUnarchiveBinding();
  const { archiveMutate, archivingWorkspaceId } = usePickerArchiveBinding();
  const toast = useToast();
  const router = useRouter();

  const directorySuggestionsQuery = useQuery({
    queryKey: ["project-picker-directory-suggestions", serverId, query],
    queryFn: async () => {
      if (!client) return [];
      const result = await client.getDirectorySuggestions({
        query,
        includeDirectories: true,
        includeFiles: false,
        limit: 30,
      });
      return (
        result.entries?.flatMap((entry) => (entry.kind === "directory" ? [entry.path] : [])) ?? []
      );
    },
    enabled: Boolean(client) && isConnected && open && allowLocalDir,
    staleTime: 15_000,
    retry: false,
  });

  const options = useMemo(() => {
    // github_only (cloud) hides the local-directory source entirely.
    if (!allowLocalDir) {
      return [] as ProjectPickerOption[];
    }
    return buildProjectPickerOptions({
      recommendedPaths,
      serverPaths: directorySuggestionsQuery.data ?? [],
      query,
    });
  }, [allowLocalDir, query, directorySuggestionsQuery.data, recommendedPaths]);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, [setOpen]);

  const handleSelectPath = useCallback(
    async (path: string) => {
      const trimmed = path.trim();
      if (!trimmed || !client || !serverId) return;

      setIsSubmitting(true);
      try {
        const didOpenProject = await openProject(trimmed);
        if (didOpenProject) {
          setOpen(false);
        }
      } finally {
        setIsSubmitting(false);
      }
    },
    [client, openProject, serverId, setOpen],
  );

  const handleSubmitCustom = useCallback(() => {
    const trimmed = query.trim();
    if (!isOpenableProjectPath(trimmed)) return;
    void handleSelectPath(trimmed);
  }, [handleSelectPath, query]);

  const handleSelectCloudWorkspace = useCallback(
    (workspace: WorkspaceRecord) => {
      // billing_locked workspaces never attempt a WS upgrade — the lifecycle
      // worker has stopped the daemon container. Route to the plan management
      // page (the same target the workspace-route gate's "Manage plan" button
      // uses). COMPAT(billing_locked): /settings/billing 404s gracefully
      // Day-1; D-4 lights up the route.
      if (workspace.state === "billing_locked") {
        setOpen(false);
        router.push("/settings/billing" as Href);
        return;
      }
      // D-3.5a (T-6) — resume path no longer hard-assumes `.git-canonical`
      // (see cloudWorkspaceOpenPath). openProject clones-on-miss, so we never
      // client-side-precheck.
      void handleSelectPath(cloudWorkspaceOpenPath(workspace));
    },
    [handleSelectPath, router, setOpen],
  );

  // D-3.5a (T-3) — GitHub source: resolve the ambient container, then open the
  // repo picker scoped to it; on add, open the new checkout (T-4 multi-add:
  // re-opening the picker adds the 2nd/3rd repo into the same container).
  const {
    githubWorkspaceId,
    isResolvingContainer,
    containerError,
    openGithubPicker: handleOpenGithubPicker,
    closeGithubPicker: handleCloseGithubPicker,
    handleProjectAdded: handleGithubProjectAdded,
  } = usePickerGithubSource(client, handleSelectPath);

  const handleArchiveCloudWorkspace = useCallback(
    (workspace: WorkspaceRecord) => {
      if (!serverId) {
        return;
      }
      void (async () => {
        const confirmed = await showCloudWorkspaceArchiveDialog();
        if (!confirmed) {
          return;
        }
        archiveMutate({ serverId, workspaceId: workspace.workspaceId });
      })();
    },
    [archiveMutate, serverId],
  );

  const handleUnarchiveOnly = useCallback(
    (workspace: WorkspaceRecord) => {
      // Explicit [Unarchive] button — flips DDB state, leaves picker open so
      // the user can decide what to open next. Cache invalidate moves the
      // row to the active section after the mutation.
      unarchiveMutate({ workspaceId: workspace.workspaceId });
    },
    [unarchiveMutate],
  );

  const handleOpenArchivedWorkspace = useCallback(
    (workspace: WorkspaceRecord) => {
      // Row body press on an archived workspace: unarchive first (parity with
      // on-host's cwd-reopen behavior), then open. The toast banner with the
      // locked copy renders on success so the user knows the side effect
      // happened.
      void (async () => {
        try {
          await unarchiveMutateAsync({ workspaceId: workspace.workspaceId });
        } catch {
          // useUnarchiveWorkspace toasts the failure; don't open a workspace
          // that's still in the archived state on the server.
          return;
        }
        toast.show(UNARCHIVE_TOAST_COPY, { durationMs: 5000 });
        handleSelectCloudWorkspace(workspace);
      })();
    },
    [handleSelectCloudWorkspace, toast, unarchiveMutateAsync],
  );

  const handleChangeQuery = useCallback((text: string) => {
    setQuery(text);
    setActiveIndex(0);
  }, []);

  // Reset state when opening/closing
  useEffect(() => {
    if (!open) {
      return;
    }

    setQuery("");
    setActiveIndex(0);
    const id = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [open]);

  // Clamp active index
  useEffect(() => {
    if (!open) return;
    if (activeIndex >= options.length) {
      setActiveIndex(options.length > 0 ? options.length - 1 : 0);
    }
  }, [activeIndex, options.length, open]);

  // Keyboard navigation
  useEffect(() => {
    if (!open || isNative) return;

    function handler(event: KeyboardEvent) {
      const key = event.key;
      if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Enter" && key !== "Escape") return;

      if (key === "Escape") {
        event.preventDefault();
        handleClose();
        return;
      }

      if (key === "Enter") {
        event.preventDefault();
        if (options.length > 0 && activeIndex < options.length) {
          handleSelectPath(options[activeIndex].path);
        } else if (query.trim()) {
          handleSubmitCustom();
        }
        return;
      }

      if (key === "ArrowDown" || key === "ArrowUp") {
        if (options.length === 0) return;
        event.preventDefault();
        setActiveIndex((current) => {
          const delta = key === "ArrowDown" ? 1 : -1;
          const next = current + delta;
          if (next < 0) return options.length - 1;
          if (next >= options.length) return 0;
          return next;
        });
      }
    }

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [activeIndex, handleClose, handleSelectPath, handleSubmitCustom, open, options, query]);

  const panelStyle = useMemo(
    () => [
      styles.panel,
      {
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      },
    ],
    [theme.colors.border, theme.colors.surface0],
  );
  const headerStyle = useMemo(
    () => [styles.header, { borderBottomColor: theme.colors.border }],
    [theme.colors.border],
  );
  const inputStyle = useMemo(
    () => [styles.input, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const headerPlaceholderStyle = useMemo(
    () => [styles.input, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );

  if (!serverId) return null;

  return (
    <>
      <Modal visible={open} transparent animationType="fade" onRequestClose={handleClose}>
        <View style={styles.overlay}>
          <Pressable style={styles.backdrop} onPress={handleClose} />

          <View style={panelStyle}>
            <View style={headerStyle}>
              {allowLocalDir ? (
                <TextInput
                  ref={inputRef}
                  value={query}
                  onChangeText={handleChangeQuery}
                  placeholder="Type a directory path..."
                  placeholderTextColor={theme.colors.foregroundMuted}
                  style={inputStyle}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus
                  editable={!isSubmitting}
                  returnKeyType="go"
                  onSubmitEditing={handleSubmitCustom}
                />
              ) : (
                // github_only (cloud): no local directories — the directory input
                // is hidden entirely (T-3 source-awareness).
                <Text style={headerPlaceholderStyle}>Open a project</Text>
              )}
            </View>

            <PickerResultsBody
              isSubmitting={isSubmitting}
              allowLocalDir={allowLocalDir}
              allowGithub={allowGithub}
              isCloudHost={isCloudHost}
              githubBusy={isResolvingContainer}
              githubDisabled={!client || isResolvingContainer}
              githubError={containerError}
              options={options}
              openPathLabel="Open path"
              onAddGithub={handleOpenGithubPicker}
              activeIndex={activeIndex}
              query={query}
              activeCloudWorkspaces={activeCloudWorkspaces}
              archivedCloudWorkspaces={archivedCloudWorkspaces}
              archivingWorkspaceId={archivingWorkspaceId}
              unarchivingWorkspaceId={unarchivingWorkspaceId}
              onSelectPath={handleSelectPath}
              onSelectCloudWorkspace={handleSelectCloudWorkspace}
              onArchiveCloudWorkspace={handleArchiveCloudWorkspace}
              onOpenArchivedWorkspace={handleOpenArchivedWorkspace}
              onUnarchiveOnly={handleUnarchiveOnly}
            />
          </View>
        </View>
      </Modal>
      {client && githubWorkspaceId ? (
        <GithubRepoPicker
          visible={githubWorkspaceId !== null}
          onClose={handleCloseGithubPicker}
          workspaceId={githubWorkspaceId}
          client={client}
          onProjectAdded={handleGithubProjectAdded}
        />
      ) : null}
    </>
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
  },
  input: {
    fontSize: theme.fontSize.lg,
    paddingVertical: theme.spacing[1],
    outlineStyle: "none",
  } as object,
  errorText: {
    marginTop: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
  results: {
    flexGrow: 0,
  },
  resultsContent: {
    paddingVertical: theme.spacing[2],
  },
  row: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
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
  rowText: {
    fontSize: theme.fontSize.base,
    fontWeight: "400",
    lineHeight: 20,
    flexShrink: 1,
  },
  rowTextColumn: {
    flex: 1,
    flexShrink: 1,
  },
  rowSubText: {
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
  },
  section: {
    paddingBottom: theme.spacing[2],
  },
  sectionHeader: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  emptyText: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    fontSize: theme.fontSize.base,
  },
  archivedFooter: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[2],
    fontSize: theme.fontSize.xs,
  },
  unarchiveButton: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
  },
  unarchiveButtonText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
}));
