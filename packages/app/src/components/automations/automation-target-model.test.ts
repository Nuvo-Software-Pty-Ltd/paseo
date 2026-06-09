import { describe, expect, it } from "vitest";
import type { ScheduleTarget } from "@server/server/schedule/types";
import {
  type AutomationProjectOption,
  buildProjectOptions,
  defaultTargetDraft,
  draftToScheduleTarget,
  preselectProjectIdForCwd,
  projectRootPathForId,
  scheduleTargetToDraft,
  shouldUseProjectPicker,
} from "./automation-target-model";

const PROJECTS: AutomationProjectOption[] = [
  { projectId: "p1", displayName: "Web App", rootPath: "/home/me/web" },
  { projectId: "p2", displayName: "API", rootPath: "/home/me/api" },
];

describe("draftToScheduleTarget — thinkingOptionId", () => {
  it("emits config.thinkingOptionId when set", () => {
    const { target, error } = draftToScheduleTarget({
      ...defaultTargetDraft(),
      provider: "claude",
      cwd: "/home/me/web",
      model: "claude-opus-4-7",
      thinkingOptionId: "high",
    });
    expect(error).toBeNull();
    expect(target).toEqual({
      type: "new-agent",
      config: {
        provider: "claude",
        cwd: "/home/me/web",
        model: "claude-opus-4-7",
        thinkingOptionId: "high",
      },
    });
  });

  it("omits thinkingOptionId when null", () => {
    const { target } = draftToScheduleTarget({
      ...defaultTargetDraft(),
      provider: "claude",
      cwd: "/home/me/web",
      thinkingOptionId: null,
    });
    expect(target).toEqual({
      type: "new-agent",
      config: { provider: "claude", cwd: "/home/me/web" },
    });
    expect(target && "config" in target ? "thinkingOptionId" in target.config : false).toBe(false);
  });
});

describe("scheduleTargetToDraft — thinkingOptionId round-trip", () => {
  it("round-trips thinkingOptionId from a new-agent target", () => {
    const target: ScheduleTarget = {
      type: "new-agent",
      config: {
        provider: "claude",
        cwd: "/home/me/web",
        model: "claude-opus-4-7",
        thinkingOptionId: "max",
      },
    };
    const draft = scheduleTargetToDraft(target);
    expect(draft.thinkingOptionId).toBe("max");
    // and back out again
    expect(draftToScheduleTarget(draft).target).toEqual(target);
  });

  it("defaults thinkingOptionId to null when the target omits it", () => {
    const draft = scheduleTargetToDraft({
      type: "new-agent",
      config: { provider: "claude", cwd: "/home/me/web" },
    });
    expect(draft.thinkingOptionId).toBeNull();
  });
});

describe("working-directory project picker helpers", () => {
  it("maps a selected project id to its rootPath (the wire cwd)", () => {
    expect(projectRootPathForId(PROJECTS, "p2")).toBe("/home/me/api");
  });

  it("returns null for an unknown project id", () => {
    expect(projectRootPathForId(PROJECTS, "nope")).toBeNull();
  });

  it("builds combobox options with displayName labels and projectId ids", () => {
    expect(buildProjectOptions(PROJECTS)).toEqual([
      { id: "p1", label: "Web App", description: "/home/me/web" },
      { id: "p2", label: "API", description: "/home/me/api" },
    ]);
  });

  it("uses the picker when projects exist and falls back when empty", () => {
    expect(shouldUseProjectPicker(PROJECTS)).toBe(true);
    expect(shouldUseProjectPicker([])).toBe(false);
  });

  it("preselects the project whose rootPath matches the current cwd", () => {
    expect(preselectProjectIdForCwd(PROJECTS, "/home/me/api")).toBe("p2");
  });

  it("preselects nothing when the cwd matches no project or is empty", () => {
    expect(preselectProjectIdForCwd(PROJECTS, "/other/path")).toBe("");
    expect(preselectProjectIdForCwd(PROJECTS, "")).toBe("");
  });
});
