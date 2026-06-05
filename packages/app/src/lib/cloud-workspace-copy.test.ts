import { describe, expect, it } from "vitest";
import {
  ADD_PROJECT_LABEL,
  EMPTY_WORKSPACE_PROMPT,
  EMPTY_WORKSPACE_TITLE,
  GITHUB_PICKER_EMPTY,
  GITHUB_PICKER_SEARCH_PLACEHOLDER,
  GITHUB_PICKER_TITLE,
  PROJECT_CLONE_PROGRESS_COPY,
} from "./cloud-workspace-copy";

// D-3.5a (app T-7): these are user-visible promises. Assert them verbatim so a
// stray refactor that rephrases them fails CI (mirror of
// cloud-workspace-archive-dialog.test.ts policy).
describe("D-3.5a project-picker copy (locked)", () => {
  it("empty-workspace strings are verbatim", () => {
    expect(EMPTY_WORKSPACE_TITLE).toBe("No projects yet");
    expect(EMPTY_WORKSPACE_PROMPT).toBe("Add a project to start running agents in this workspace.");
    expect(ADD_PROJECT_LABEL).toBe("Add project");
  });

  it("GitHub picker strings are verbatim", () => {
    expect(GITHUB_PICKER_TITLE).toBe("Add a GitHub repo");
    expect(GITHUB_PICKER_SEARCH_PLACEHOLDER).toBe("Search your repositories…");
    expect(GITHUB_PICKER_EMPTY).toBe("No repositories found.");
    expect(PROJECT_CLONE_PROGRESS_COPY).toBe("Adding project…");
  });
});
