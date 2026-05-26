// Locked copy from workspace-lifecycle.md § "UX copy". These strings are the
// only user-visible promises the cloud-workspace lifecycle makes. Treat them
// as binding — any rephrase has to walk through this file (and the asserting
// unit tests).

export const ARCHIVE_30_DAY_NOTICE =
  "Archived workspaces will be permanently removed after 30 days.";

export const ARCHIVE_DIALOG_TITLE = "Archive this workspace?";

export const ARCHIVE_DIALOG_CONFIRM_LABEL = "Archive";
export const ARCHIVE_DIALOG_CANCEL_LABEL = "Cancel";

export const UNARCHIVE_TOAST_COPY = "Unarchived — this workspace is active again.";

export const COLD_RESUME_SPLASH_COPY = "Resuming workspace…";

export const BILLING_LOCKED_PROMPT_COPY = "Reactivate your plan to resume this workspace.";
export const BILLING_LOCKED_PLAN_INACTIVE_BADGE = "Plan inactive";
