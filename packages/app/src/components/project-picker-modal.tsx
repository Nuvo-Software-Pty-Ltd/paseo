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
import { Archive, Cloud, Folder } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useQuery } from "@tanstack/react-query";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { shortenPath } from "@/utils/shorten-path";
import { useRecommendedProjectPaths } from "@/stores/session-store-hooks";
import {
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
  useIsCloudHost,
} from "@/runtime/host-runtime";
import { useOpenProject } from "@/hooks/use-open-project";
import { useCloudWorkspaces } from "@/hooks/use-cloud-workspaces";
import { buildWorkingDirectorySuggestions } from "@/utils/working-directory-suggestions";
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

interface PathRowProps {
  path: string;
  active: boolean;
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

function PathRow({ path, active, onSelect }: PathRowProps) {
  const { theme } = useUnistyles();
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
          <Folder size={16} strokeWidth={2.2} color={theme.colors.foregroundMuted} />
        </View>
        <Text style={rowTextStyle} numberOfLines={1}>
          {shortenPath(path)}
        </Text>
      </View>
    </Pressable>
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
    enabled: Boolean(client) && isConnected && open,
    staleTime: 15_000,
    retry: false,
  });

  const options = useMemo(() => {
    const suggestedPaths = buildWorkingDirectorySuggestions({
      recommendedPaths,
      serverPaths: directorySuggestionsQuery.data ?? [],
      query,
    });
    const trimmedQuery = query.trim();
    if (!trimmedQuery || suggestedPaths.includes(trimmedQuery)) {
      return suggestedPaths;
    }
    return [trimmedQuery, ...suggestedPaths];
  }, [query, directorySuggestionsQuery.data, recommendedPaths]);

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
    if (!trimmed) return;
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
      // The daemon's container exposes each cloud workspace at this canonical
      // mount; openProject clones-on-miss, so we never client-side-precheck.
      const path = `/workspace/${workspace.workspaceId}/.git-canonical`;
      void handleSelectPath(path);
    },
    [handleSelectPath, router, setOpen],
  );

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
    if (open) {
      setQuery("");
      setActiveIndex(0);
      const id = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
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
        setOpen(false);
        return;
      }

      if (key === "Enter") {
        event.preventDefault();
        if (options.length > 0 && activeIndex < options.length) {
          void handleSelectPath(options[activeIndex]);
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
  }, [activeIndex, handleSelectPath, handleSubmitCustom, open, options, query, setOpen]);

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
  const emptyTextStyle = useMemo(
    () => [styles.emptyText, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );
  const sectionHeaderStyle = useMemo(
    () => [styles.sectionHeader, { color: theme.colors.foregroundMuted }],
    [theme.colors.foregroundMuted],
  );

  if (!serverId) return null;

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={handleClose} />

        <View style={panelStyle}>
          <View style={headerStyle}>
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
          </View>

          <ScrollView
            style={styles.results}
            contentContainerStyle={styles.resultsContent}
            keyboardShouldPersistTaps="always"
            showsVerticalScrollIndicator={false}
          >
            {isSubmitting ? <Text style={emptyTextStyle}>Opening project...</Text> : null}
            {!isSubmitting && options.length === 0 && !query.trim() ? (
              <Text style={emptyTextStyle}>Start typing a path</Text>
            ) : null}
            {!isSubmitting && isCloudHost && activeCloudWorkspaces.length > 0 ? (
              <View style={styles.section}>
                <Text style={sectionHeaderStyle}>Cloud workspaces</Text>
                {activeCloudWorkspaces.map((workspace) => (
                  <CloudWorkspaceRow
                    key={workspace.workspaceId}
                    workspace={workspace}
                    onSelect={handleSelectCloudWorkspace}
                    onArchive={handleArchiveCloudWorkspace}
                    isArchiving={archivingWorkspaceId === workspace.workspaceId}
                  />
                ))}
              </View>
            ) : null}
            {!isSubmitting && !(options.length === 0 && !query.trim()) ? (
              <>
                {options.map((path, index) => (
                  <PathRow
                    key={path}
                    path={path}
                    active={index === activeIndex}
                    onSelect={handleSelectPath}
                  />
                ))}
              </>
            ) : null}
            {!isSubmitting && isCloudHost ? (
              <ArchivedSection
                workspaces={archivedCloudWorkspaces}
                onSelect={handleOpenArchivedWorkspace}
                onUnarchive={handleUnarchiveOnly}
                unarchivingWorkspaceId={unarchivingWorkspaceId}
              />
            ) : null}
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
