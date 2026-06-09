import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Trash2 } from "lucide-react-native";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  ENV_VARS_ADD_LABEL,
  ENV_VARS_EMPTY,
  ENV_VARS_INHERITED_TITLE,
  ENV_VARS_OVERRIDE_BADGE,
  ENV_VARS_PRECEDENCE_NOTE,
  ENV_VARS_SECRET_TOGGLE_LABEL,
  ENV_VARS_UPDATE_HOST,
  envVarKeyErrorMessage,
} from "@/lib/env-vars-copy";
import {
  useScopedEnvVars,
  useScopedEnvVarsSupported,
  type ScopedEnvVarScope,
  type ScopedEnvVarView,
} from "@/hooks/use-scoped-env-vars";

export interface ScopedEnvVarsEditorProps {
  serverId: string;
  scope: ScopedEnvVarScope;
  scopeId: string;
  // Project scope only: the inherited workspace vars, rendered read-only
  // above the editable project vars with the override badge (DECISION P-1).
  inheritedVars?: ScopedEnvVarView[];
  testID?: string;
}

const SECRET_MASK = "••••••••";

interface EnvVarRowProps {
  entry: ScopedEnvVarView;
  isFirst: boolean;
  overrides: boolean;
  onEdit: (entry: ScopedEnvVarView) => void;
  onDelete: (entry: ScopedEnvVarView) => void;
}

// Extracted + memoized so the per-row handlers/styles are stable (the
// react-perf lint forbids arrays/functions created in JSX scope).
const EnvVarRow = memo(function EnvVarRow({
  entry,
  isFirst,
  overrides,
  onEdit,
  onDelete,
}: EnvVarRowProps) {
  const rowStyle = useMemo(() => [styles.row, isFirst ? null : styles.rowBorder], [isFirst]);
  const handleEdit = useCallback(() => onEdit(entry), [onEdit, entry]);
  const handleDelete = useCallback(() => onDelete(entry), [onDelete, entry]);
  return (
    <Pressable onPress={handleEdit} style={rowStyle} testID={`env-var-row-${entry.key}`}>
      <View style={styles.rowContent}>
        <View style={styles.keyLine}>
          <Text style={styles.key}>{entry.key}</Text>
          {overrides ? <Text style={styles.overrideBadge}>{ENV_VARS_OVERRIDE_BADGE}</Text> : null}
        </View>
        <Text style={styles.value} numberOfLines={1}>
          {entry.secret ? SECRET_MASK : entry.value}
        </Text>
      </View>
      <Pressable
        onPress={handleDelete}
        accessibilityLabel={`Delete ${entry.key}`}
        testID={`env-var-delete-${entry.key}`}
        hitSlop={8}
      >
        <Trash2 size={16} color={styles.deleteIcon.color} />
      </Pressable>
    </Pressable>
  );
});

const InheritedRow = memo(function InheritedRow({
  entry,
  isFirst,
}: {
  entry: ScopedEnvVarView;
  isFirst: boolean;
}) {
  const rowStyle = useMemo(() => [styles.row, isFirst ? null : styles.rowBorder], [isFirst]);
  return (
    <View style={rowStyle} testID={`env-var-inherited-${entry.key}`}>
      <View style={styles.rowContent}>
        <Text style={styles.inheritedKey}>{entry.key}</Text>
        <Text style={styles.value} numberOfLines={1}>
          {entry.secret ? SECRET_MASK : entry.value}
        </Text>
      </View>
    </View>
  );
});

export function ScopedEnvVarsEditor({
  serverId,
  scope,
  scopeId,
  inheritedVars,
  testID,
}: ScopedEnvVarsEditorProps) {
  const supported = useScopedEnvVarsSupported(serverId);
  const { vars, isLoading, setVar, deleteVar } = useScopedEnvVars({
    serverId,
    scope,
    scopeId,
    enabled: supported,
  });

  const [draftKey, setDraftKey] = useState("");
  const [draftValue, setDraftValue] = useState("");
  const [draftSecret, setDraftSecret] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const inheritedKeys = useMemo(
    () => new Set((inheritedVars ?? []).map((entry) => entry.key)),
    [inheritedVars],
  );

  const resetDraft = useCallback(() => {
    setDraftKey("");
    setDraftValue("");
    setDraftSecret(false);
    setKeyError(null);
  }, []);

  const handleSave = useCallback(async () => {
    const key = draftKey.trim();
    setKeyError(null);
    setSaving(true);
    try {
      const result = await setVar({ key, value: draftValue, secret: draftSecret || undefined });
      if (!result.ok) {
        setKeyError(envVarKeyErrorMessage(result.code));
        return;
      }
      resetDraft();
    } catch {
      setKeyError(envVarKeyErrorMessage(undefined));
    } finally {
      setSaving(false);
    }
  }, [draftKey, draftValue, draftSecret, setVar, resetDraft]);

  const handleEdit = useCallback((entry: ScopedEnvVarView) => {
    setDraftKey(entry.key);
    // Secret values are write-only — start empty so the user re-enters it.
    setDraftValue(entry.secret ? "" : entry.value);
    setDraftSecret(entry.secret === true);
    setKeyError(null);
  }, []);

  const handleDelete = useCallback(
    async (entry: ScopedEnvVarView) => {
      const ok = await confirmDialog({
        title: "Remove variable?",
        message: `Remove ${entry.key}?`,
        confirmLabel: "Remove",
        cancelLabel: "Cancel",
        destructive: true,
      });
      if (!ok) {
        return;
      }
      await deleteVar(entry.key);
    },
    [deleteVar],
  );

  if (!supported) {
    return (
      <View style={styles.card} testID={testID}>
        <Text style={styles.mutedNote}>{ENV_VARS_UPDATE_HOST}</Text>
      </View>
    );
  }

  const showInherited = scope === "project" && (inheritedVars?.length ?? 0) > 0;

  return (
    <View testID={testID}>
      {scope === "project" ? (
        <Text style={styles.precedenceNote}>{ENV_VARS_PRECEDENCE_NOTE}</Text>
      ) : null}

      {showInherited ? (
        <View style={styles.inheritedBlock}>
          <Text style={styles.inheritedTitle}>{ENV_VARS_INHERITED_TITLE}</Text>
          <View style={styles.card}>
            {(inheritedVars ?? []).map((entry, index) => (
              <InheritedRow key={entry.key} entry={entry} isFirst={index === 0} />
            ))}
          </View>
        </View>
      ) : null}

      <View style={styles.card}>
        {vars.length === 0 && !isLoading ? (
          <Text style={styles.mutedNote}>{ENV_VARS_EMPTY}</Text>
        ) : (
          vars.map((entry, index) => (
            <EnvVarRow
              key={entry.key}
              entry={entry}
              isFirst={index === 0}
              overrides={scope === "project" && inheritedKeys.has(entry.key)}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ))
        )}
      </View>

      <View style={styles.addForm}>
        <TextInput
          testID="env-var-key-input"
          accessibilityLabel="Variable name"
          value={draftKey}
          onChangeText={setDraftKey}
          placeholder="NAME"
          placeholderTextColor={styles.placeholder.color}
          autoCapitalize="characters"
          autoCorrect={false}
          style={styles.input}
        />
        <TextInput
          testID="env-var-value-input"
          accessibilityLabel="Variable value"
          value={draftValue}
          onChangeText={setDraftValue}
          placeholder="value"
          placeholderTextColor={styles.placeholder.color}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry={draftSecret}
          style={styles.input}
        />
        <View style={styles.secretRow}>
          <Text style={styles.secretLabel}>{ENV_VARS_SECRET_TOGGLE_LABEL}</Text>
          <Switch
            value={draftSecret}
            onValueChange={setDraftSecret}
            accessibilityLabel="Mark as secret"
            testID="env-var-secret-toggle"
          />
        </View>
        {keyError ? (
          <Text style={styles.errorText} testID="env-var-key-error">
            {keyError}
          </Text>
        ) : null}
        <Button
          testID="env-var-add-button"
          accessibilityLabel={ENV_VARS_ADD_LABEL}
          variant="default"
          size="sm"
          loading={saving}
          disabled={saving || draftKey.trim().length === 0}
          onPress={handleSave}
        >
          {ENV_VARS_ADD_LABEL}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  rowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  rowContent: {
    flex: 1,
    marginRight: theme.spacing[3],
  },
  keyLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  key: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  inheritedKey: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  value: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  overrideBadge: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.xs,
  },
  deleteIcon: {
    color: theme.colors.foregroundMuted,
  },
  precedenceNote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginBottom: theme.spacing[3],
    marginLeft: theme.spacing[1],
  },
  inheritedBlock: {
    marginBottom: theme.spacing[4],
  },
  inheritedTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginBottom: theme.spacing[2],
    marginLeft: theme.spacing[1],
  },
  mutedNote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
  },
  addForm: {
    marginTop: theme.spacing[3],
    gap: theme.spacing[2],
  },
  input: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
  },
  placeholder: {
    color: theme.colors.foregroundMuted,
  },
  secretRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[1],
  },
  secretLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
    marginLeft: theme.spacing[1],
  },
}));
