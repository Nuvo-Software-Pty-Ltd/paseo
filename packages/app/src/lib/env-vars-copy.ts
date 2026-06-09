// D-3.5c — single source of truth for the scoped-env-var editor's
// user-visible copy. Centralized (per repo policy, mirroring
// `cloud-workspace-copy.ts`) so a stray refactor cannot silently rephrase
// a user-facing promise; `env-vars-copy.test.ts` asserts each verbatim.

export const ENV_VARS_GROUP_TITLE = "Environment variables";

export const ENV_VARS_GROUP_INFO =
  "Variables injected into agents and terminals you launch in this project.";

// project-over-workspace precedence (daemon DECISION P-1).
export const ENV_VARS_PRECEDENCE_NOTE =
  "Workspace variables apply to every project. Set a variable here to override it for this project.";

export const ENV_VARS_OVERRIDE_BADGE = "overrides workspace";

export const ENV_VARS_INHERITED_TITLE = "Inherited from workspace";

export const ENV_VARS_ADD_LABEL = "Add variable";

export const ENV_VARS_EMPTY = "No variables yet.";

export const ENV_VARS_SECRET_TOGGLE_LABEL = "Secret";

// Shown when the connected daemon predates the scoped-env-var RPCs
// (features.scopedEnvVars absent) — the feature contract's required
// "update the host" message (VERIFY-3.5c fix #4).
export const ENV_VARS_UPDATE_HOST = "Update the host to use this.";

// Maps daemon-side validation error codes (set_scoped_env_var_response)
// to inline messages. Falls back to a generic message for unknown codes.
export const ENV_VARS_KEY_ERROR: Record<string, string> = {
  empty: "Enter a variable name.",
  too_long: "Variable name is too long.",
  invalid_charset: "Use letters, digits, and underscores; can't start with a digit.",
  reserved: "That name is reserved by the platform.",
  value_too_long: "Value is too long.",
  unsupported: ENV_VARS_UPDATE_HOST,
};

export function envVarKeyErrorMessage(code: string | undefined): string {
  if (!code) {
    return "Couldn't save the variable.";
  }
  return ENV_VARS_KEY_ERROR[code] ?? "Couldn't save the variable.";
}
