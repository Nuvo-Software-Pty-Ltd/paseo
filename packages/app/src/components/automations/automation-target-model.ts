// Pure (RN-free) editor model for the automation spawn target. The picker
// component (automation-target-picker.tsx) renders these; keeping the logic in
// a plain module lets it be unit-tested in the node-env vitest project without
// pulling in react-native / unistyles.

import type { AutomationTarget } from "@server/client/daemon-client";
import type { ScheduleTarget } from "@server/server/schedule/types";
import type { ComboboxOption } from "@/components/ui/combobox";

// Editor state for the spawn target. We keep both the new-agent fields and the
// chosen existing-agent id around so toggling between modes does not lose input.
export interface TargetDraft {
  mode: "new-agent" | "agent";
  provider: string;
  model: string | null;
  modeId: string | null;
  // Mirrors the chat composer's Brain-icon "effort" selector: the selected
  // model's thinking option (Low/Medium/High/Max). Null = provider default.
  thinkingOptionId: string | null;
  cwd: string;
  agentId: string | null;
}

export function defaultTargetDraft(): TargetDraft {
  return {
    mode: "new-agent",
    provider: "",
    model: null,
    modeId: null,
    thinkingOptionId: null,
    cwd: "",
    agentId: null,
  };
}

export function scheduleTargetToDraft(target: ScheduleTarget): TargetDraft {
  if (target.type === "agent") {
    return { ...defaultTargetDraft(), mode: "agent", agentId: target.agentId };
  }
  const { config } = target;
  return {
    ...defaultTargetDraft(),
    mode: "new-agent",
    provider: config.provider,
    model: config.model ?? null,
    modeId: config.modeId ?? null,
    thinkingOptionId: config.thinkingOptionId ?? null,
    cwd: config.cwd,
    agentId: null,
  };
}

export interface TargetValidation {
  target: AutomationTarget | null;
  error: string | null;
}

// Convert the draft to a create-shaped target (the wire shape that
// schedule/trigger create + update accept). Only the fields the daemon accepts
// are emitted (provider/model/modeId/thinkingOptionId/cwd for new-agent).
// Returns a human error when required input is missing.
export function draftToScheduleTarget(draft: TargetDraft): TargetValidation {
  if (draft.mode === "agent") {
    if (!draft.agentId) {
      return { target: null, error: "Select an existing agent." };
    }
    return { target: { type: "agent", agentId: draft.agentId }, error: null };
  }
  if (!draft.provider.trim()) {
    return { target: null, error: "Select a provider." };
  }
  if (!draft.cwd.trim()) {
    return { target: null, error: "Enter a working directory." };
  }
  return {
    target: {
      type: "new-agent",
      config: {
        provider: draft.provider.trim(),
        cwd: draft.cwd.trim(),
        ...(draft.model ? { model: draft.model } : {}),
        ...(draft.modeId ? { modeId: draft.modeId } : {}),
        ...(draft.thinkingOptionId ? { thinkingOptionId: draft.thinkingOptionId } : {}),
      },
    },
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Working-directory project picker (CHANGE 2).
//
// The "Working directory" field used to be a freeform text input. The wire
// value (draft.cwd) is still a path string; the picker just chooses it from the
// current workspace's projects[]. These helpers are the pure decision logic.

export interface AutomationProjectOption {
  projectId: string;
  displayName: string;
  rootPath: string;
}

// The project rows offered in the picker (label = displayName, id = projectId).
export function buildProjectOptions(projects: AutomationProjectOption[]): ComboboxOption[] {
  return projects.map((project) => ({
    id: project.projectId,
    label: project.displayName,
    description: project.rootPath,
  }));
}

// The wire cwd for a selected project id (its rootPath), or null when unknown.
export function projectRootPathForId(
  projects: AutomationProjectOption[],
  projectId: string,
): string | null {
  return projects.find((project) => project.projectId === projectId)?.rootPath ?? null;
}

// Whether to render the project picker. With no projects (self-host / empty
// workspace) we fall back to the freeform text input so those flows still work.
export function shouldUseProjectPicker(projects: AutomationProjectOption[]): boolean {
  return projects.length > 0;
}

// Preselect the project whose rootPath matches the current cwd (edit mode), or
// "" when nothing matches (the cwd is some other / hand-typed path).
export function preselectProjectIdForCwd(projects: AutomationProjectOption[], cwd: string): string {
  const trimmed = cwd.trim();
  if (!trimmed) {
    return "";
  }
  return projects.find((project) => project.rootPath === trimmed)?.projectId ?? "";
}
