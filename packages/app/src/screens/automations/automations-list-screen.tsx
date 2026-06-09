import { useCallback, useMemo, useState } from "react";
import { FlatList, Modal, Pressable, RefreshControl, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { router } from "expo-router";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useAutomations } from "@/hooks/use-automations";
import type { Automation } from "@/lib/automations/automation-model";
import { buildHostAutomationDetailRoute } from "@/utils/host-routes";
import { formatTimeAgo } from "@/utils/time";
import { AutomationCreateForm } from "./automation-create-form";

// Themed spinner: `color` is a non-style prop, so inject it via `withUnistyles`
// rather than calling `useUnistyles()` (forbidden — see docs/unistyles.md).
const ThemedSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

function automationKeyExtractor(item: Automation): string {
  return `${item.kind}:${item.id}`;
}

export function AutomationsListScreen({ serverId }: { serverId: string }) {
  const isFocused = useIsFocused();
  if (!isFocused) {
    return <View style={styles.container} />;
  }
  return <AutomationsListScreenContent serverId={serverId} />;
}

function AutomationsListScreenContent({ serverId }: { serverId: string }) {
  const { automations, error, isLoading, isFetching } = useAutomations(serverId);
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  const handleOpenCreate = useCallback(() => setIsCreateOpen(true), []);
  const handleCloseCreate = useCallback(() => setIsCreateOpen(false), []);

  const handleRefresh = useCallback(() => {
    // React Query refetches on remount/focus; this triggers the visual
    // refresh control while the active query revalidates.
  }, []);

  const handlePressRow = useCallback(
    (automation: Automation) => {
      router.push(buildHostAutomationDetailRoute(serverId, automation.id));
    },
    [serverId],
  );

  const renderItem = useCallback(
    ({ item }: { item: Automation }) => (
      <AutomationRow automation={item} onPress={handlePressRow} />
    ),
    [handlePressRow],
  );

  const refreshControl = useMemo(
    () => <RefreshControl refreshing={isFetching} onRefresh={handleRefresh} />,
    [isFetching, handleRefresh],
  );

  const rightContent = useMemo(
    () => (
      <Button size="sm" variant="default" onPress={handleOpenCreate}>
        + New
      </Button>
    ),
    [handleOpenCreate],
  );

  return (
    <View style={styles.container}>
      <MenuHeader title="Automations" rightContent={rightContent} />

      {error ? (
        <View style={styles.errorBanner} accessibilityLabel="automations-error">
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {isLoading && automations.length === 0 ? (
        <View style={styles.centered}>
          <ThemedSpinner size="large" />
        </View>
      ) : null}

      {!isLoading && automations.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyText}>No automations yet</Text>
          <Button variant="default" onPress={handleOpenCreate}>
            Create your first automation
          </Button>
        </View>
      ) : null}

      {automations.length > 0 ? (
        <FlatList
          data={automations}
          keyExtractor={automationKeyExtractor}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          refreshControl={refreshControl}
        />
      ) : null}

      <Modal
        visible={isCreateOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={handleCloseCreate}
      >
        <AutomationCreateForm serverId={serverId} onClose={handleCloseCreate} />
      </Modal>
    </View>
  );
}

function AutomationRow({
  automation,
  onPress,
}: {
  automation: Automation;
  onPress: (automation: Automation) => void;
}) {
  const handlePress = useCallback(() => onPress(automation), [automation, onPress]);
  const lastRun = automation.lastRunAt
    ? formatTimeAgo(new Date(automation.lastRunAt))
    : "Never run";
  const isActiveStatus = automation.statusLabel === "Active";

  const chipStyle = useMemo(
    () => [styles.statusChip, isActiveStatus ? styles.statusChipActive : null],
    [isActiveStatus],
  );
  const chipTextStyle = useMemo(
    () => [styles.statusChipText, isActiveStatus ? styles.statusChipTextActive : null],
    [isActiveStatus],
  );
  const metaTextStyle = useMemo(
    () => [styles.metaText, automation.lastRunFailed ? styles.metaFailed : null],
    [automation.lastRunFailed],
  );

  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      style={styles.row}
      testID={`automation-row-${automation.id}`}
    >
      <View style={styles.rowHeader}>
        <Text style={styles.kindBadge}>{automation.kind === "schedule" ? "⏰" : "🔗"}</Text>
        <Text style={styles.rowName} numberOfLines={1}>
          {automation.name ?? "Untitled automation"}
        </Text>
        <View style={chipStyle} accessibilityLabel={`status-${automation.statusLabel}`}>
          <Text style={chipTextStyle}>{automation.statusLabel}</Text>
        </View>
      </View>
      <View style={styles.rowMeta}>
        <Text style={styles.metaText}>{automation.cadenceLabel}</Text>
        <Text style={styles.metaDot}>·</Text>
        <Text style={metaTextStyle}>{automation.lastRunFailed ? "Last run failed" : lastRun}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[4],
    padding: theme.spacing[6],
  },
  emptyText: {
    fontSize: theme.fontSize.lg,
    color: theme.colors.foregroundMuted,
  },
  errorBanner: {
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.destructive,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
  },
  listContent: {
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  row: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  kindBadge: {
    fontSize: theme.fontSize.base,
  },
  rowName: {
    flex: 1,
    fontSize: theme.fontSize.base,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  statusChip: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  statusChipActive: {
    backgroundColor: theme.colors.success,
  },
  statusChipText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  statusChipTextActive: {
    color: theme.colors.palette.white,
  },
  rowMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  metaText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  metaDot: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  metaFailed: {
    color: theme.colors.destructive,
  },
}));
