import {
  ARCHIVE_30_DAY_NOTICE,
  ARCHIVE_DIALOG_CANCEL_LABEL,
  ARCHIVE_DIALOG_CONFIRM_LABEL,
  ARCHIVE_DIALOG_TITLE,
} from "@/lib/cloud-workspace-copy";
import { confirmDialog } from "@/utils/confirm-dialog";

// Locked copy — workspace-lifecycle.md § "UX copy" pins both the title and the
// 30-day notice. Asserted verbatim in cloud-workspace-archive-dialog.test.ts
// so a stray refactor cannot silently rephrase the user-visible promise.
export async function showCloudWorkspaceArchiveDialog(): Promise<boolean> {
  return confirmDialog({
    title: ARCHIVE_DIALOG_TITLE,
    message: ARCHIVE_30_DAY_NOTICE,
    confirmLabel: ARCHIVE_DIALOG_CONFIRM_LABEL,
    cancelLabel: ARCHIVE_DIALOG_CANCEL_LABEL,
    destructive: true,
  });
}
