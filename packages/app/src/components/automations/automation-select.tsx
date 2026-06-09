import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ChevronDown } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";

const ChevronDownIcon = withUnistyles(ChevronDown, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

interface AutomationSelectProps {
  label: string;
  value: string;
  options: ComboboxOption[];
  placeholder?: string;
  title?: string;
  disabled?: boolean;
  onSelect: (id: string) => void;
}

// A labelled select: a pressable trigger that opens the shared Combobox popover.
// Centralizes the anchorRef + open-state boilerplate so the forms stay compact.
export function AutomationSelect({
  label,
  value,
  options,
  placeholder,
  title,
  disabled,
  onSelect,
}: AutomationSelectProps) {
  const anchorRef = useRef<View>(null);
  const [isOpen, setIsOpen] = useState(false);

  const selectedLabel = useMemo(
    () => options.find((option) => option.id === value)?.label ?? placeholder ?? "Select…",
    [options, value, placeholder],
  );

  const handleOpen = useCallback(() => {
    if (!disabled) setIsOpen(true);
  }, [disabled]);

  const handleSelect = useCallback(
    (id: string) => {
      onSelect(id);
      setIsOpen(false);
    },
    [onSelect],
  );

  const triggerStyle = useMemo(
    () => [styles.trigger, disabled ? styles.triggerDisabled : null],
    [disabled],
  );

  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View ref={anchorRef} collapsable={false}>
        <Pressable
          onPress={handleOpen}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${selectedLabel}`}
          style={triggerStyle}
        >
          <Text style={styles.triggerText} numberOfLines={1}>
            {selectedLabel}
          </Text>
          <ChevronDownIcon size={14} />
        </Pressable>
        <Combobox
          options={options}
          value={value}
          onSelect={handleSelect}
          searchable={options.length > 8}
          placeholder={placeholder ?? "Select…"}
          title={title ?? label}
          open={isOpen}
          onOpenChange={setIsOpen}
          anchorRef={anchorRef}
          desktopPlacement="bottom-start"
          desktopPreventInitialFlash
          desktopMinWidth={240}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  field: {
    gap: theme.spacing[1],
  },
  label: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  triggerDisabled: {
    opacity: theme.opacity[50],
  },
  triggerText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
