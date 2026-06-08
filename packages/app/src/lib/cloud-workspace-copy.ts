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

// D-3.5a (app T-7) — user-visible promises for the workspace → projects[]
// refoundation (repo-less create + GitHub project picker). Centralized so a
// refactor cannot silently rephrase them; asserted verbatim in
// `cloud-workspace-copy.test.ts`.
export const EMPTY_WORKSPACE_TITLE = "No projects yet";
export const EMPTY_WORKSPACE_PROMPT = "Add a project to start running agents in this workspace.";
export const ADD_PROJECT_LABEL = "Add project";
export const GITHUB_PICKER_TITLE = "Add a GitHub repo";
export const GITHUB_PICKER_SEARCH_PLACEHOLDER = "Search your repositories…";
export const GITHUB_PICKER_EMPTY = "No repositories found.";
export const PROJECT_CLONE_PROGRESS_COPY = "Adding project…";
