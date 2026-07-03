import type { AutomationKind } from "@/lib/automations/automation-model";
import type { ConfirmDialogInput } from "@/utils/confirm-dialog";

export interface DeleteAutomationInput {
  id: string;
  kind: AutomationKind;
}

/**
 * Confirmation copy for deleting an automation. Kept as a `ConfirmDialogInput`
 * (not a raw `Alert.alert`) so the flow routes through `confirmDialog`, whose
 * web backend uses `window.confirm`. `react-native`'s `Alert.alert` is a no-op
 * on react-native-web, so gating delete behind it made the button do nothing on
 * the web SPA.
 */
export function resolveDeleteAutomationDialog(): ConfirmDialogInput {
  return {
    title: "Delete automation",
    message: "This cannot be undone.",
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
    destructive: true,
  };
}

export interface DeleteAutomationDeps {
  confirm: (input: ConfirmDialogInput) => Promise<boolean>;
  deleteAutomation: (input: DeleteAutomationInput) => Promise<unknown>;
  onDeleted: () => void;
  reportError?: (error: unknown) => void;
}

export async function requestDeleteAutomation(
  input: DeleteAutomationInput,
  deps: DeleteAutomationDeps,
): Promise<void> {
  const confirmed = await deps.confirm(resolveDeleteAutomationDialog());
  if (!confirmed) {
    return;
  }
  try {
    await deps.deleteAutomation(input);
    deps.onDeleted();
  } catch (error) {
    deps.reportError?.(error);
  }
}
