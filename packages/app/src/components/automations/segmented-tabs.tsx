import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export interface SegmentedTab<T extends string> {
  id: T;
  label: string;
}

interface SegmentedTabsProps<T extends string> {
  tabs: ReadonlyArray<SegmentedTab<T>>;
  value: T;
  onChange: (value: T) => void;
}

// A small segmented control used across the automation pickers. Centralizing it
// keeps inline `onPress`/`style` closures out of the form components (which the
// react-perf lint rules forbid).
export function SegmentedTabs<T extends string>({ tabs, value, onChange }: SegmentedTabsProps<T>) {
  return (
    <View style={styles.row}>
      {tabs.map((tab) => (
        <SegmentTab key={tab.id} tab={tab} active={tab.id === value} onPress={onChange} />
      ))}
    </View>
  );
}

function SegmentTab<T extends string>({
  tab,
  active,
  onPress,
}: {
  tab: SegmentedTab<T>;
  active: boolean;
  onPress: (value: T) => void;
}) {
  const handlePress = useCallback(() => onPress(tab.id), [onPress, tab.id]);
  const accessibilityState = useMemo(() => ({ selected: active }), [active]);
  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      style={active ? styles.tabActive : styles.tab}
    >
      <Text style={active ? styles.tabTextActive : styles.tabText}>{tab.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  tab: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  tabActive: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.accent,
  },
  tabText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  tabTextActive: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.accentForeground,
  },
}));
