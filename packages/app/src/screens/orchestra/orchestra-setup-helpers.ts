import type { MintWorkspaceTokenResult, WorkspaceRecord } from "@/lib/orchestra-cloud-client";

export type SetupStep = "workspace" | "credential" | "connecting" | "done";

// Sub-view of the "workspace" step:
//   "auto"   — let the chooser auto-pick: render `chooser` if ≥1 active
//              workspaces exist, otherwise the create form.
//   "create" — the user explicitly tapped "Create new workspace" from the
//              chooser; render the create form even if existing workspaces
//              are present.
export type WorkspaceStepView = "auto" | "create";

// Pure: returns the active workspace rows the chooser may surface. Archived
// rows are filtered out — the wizard's purpose is to set credentials on an
// active workspace; archived isn't a valid pick target. Plan § Open Q3.
export function filterChoosableWorkspaces(
  workspaces: ReadonlyArray<WorkspaceRecord>,
): WorkspaceRecord[] {
  return workspaces.filter((entry) => entry.state !== "archived");
}

// Pure: returns true if the wizard should render the chooser instead of the
// create form for the workspace step.
export function shouldShowWorkspaceChooser(
  step: SetupStep,
  view: WorkspaceStepView,
  choosable: ReadonlyArray<WorkspaceRecord>,
): boolean {
  return step === "workspace" && view === "auto" && choosable.length > 0;
}

export function setupHeaderTitle(step: SetupStep, shouldShowChooser: boolean): string {
  if (step === "workspace") {
    return shouldShowChooser ? "Choose a workspace" : "Create workspace";
  }
  if (step === "credential") return "Anthropic API key";
  if (step === "connecting") return "Connecting...";
  return "Connected";
}

// Friendly inline-error copy for the create-flow's mint step. The setup
// wizard treats every non-active mint result as exceptional (we just created
// the workspace; lifecycle states should be active for the next few
// seconds), so this maps the discriminated result to a single sentence.
export function setupMintErrorMessage(result: MintWorkspaceTokenResult): string {
  switch (result.status) {
    case "active":
      return "";
    case "resuming":
      return "Your workspace is resuming — try again in a moment.";
    case "archived":
      return "This workspace is archived. Unarchive it from the picker before connecting.";
    case "billing_locked":
      return "Your plan is inactive. Reactivate it to use this workspace.";
    case "provisioning":
      return "Your workspace is still provisioning — try again in a moment.";
    case "provisioning_failed":
      return result.retryable
        ? "Workspace failed to start. Try again."
        : "Workspace failed to start. Contact support if this keeps happening.";
  }
}

// Pure: which step to enter after a workspace is picked or created. The
// credential is per-account (D-3.5b) — once the account has a credential, every
// workspace inherits it, so the wizard skips the credential prompt and connects
// directly. First-run (no account credential) still routes through the
// credential step once, which now writes the account-scoped credential.
export function nextStepAfterWorkspacePick(hasAccountCredential: boolean): SetupStep {
  return hasAccountCredential ? "connecting" : "credential";
}

export function workspaceStateBadge(state: WorkspaceRecord["state"]): string | null {
  switch (state) {
    case "active":
      return null;
    case "suspended":
      return "Suspended";
    case "billing_locked":
      return "Plan inactive";
    case "archived":
      // Filtered out from the chooser; included here for exhaustiveness.
      return "Archived";
  }
}
