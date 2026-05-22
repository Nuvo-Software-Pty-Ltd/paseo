import { describe, expect, it } from "vitest";
import {
  ARCHIVE_30_DAY_NOTICE,
  ARCHIVE_DIALOG_CANCEL_LABEL,
  ARCHIVE_DIALOG_CONFIRM_LABEL,
  ARCHIVE_DIALOG_TITLE,
  UNARCHIVE_TOAST_COPY,
  COLD_RESUME_SPLASH_COPY,
  BILLING_LOCKED_PROMPT_COPY,
} from "@/lib/cloud-workspace-copy";

// These strings come from workspace-lifecycle.md § "UX copy". They are
// user-visible promises — treat them as binding. Any rephrase MUST update
// the spec first, then this test, then the constant.
describe("locked cloud-workspace copy", () => {
  it("matches the spec verbatim — archive dialog title", () => {
    expect(ARCHIVE_DIALOG_TITLE).toBe("Archive this workspace?");
  });

  it("matches the spec verbatim — 30-day notice (modal message + picker footer share this)", () => {
    expect(ARCHIVE_30_DAY_NOTICE).toBe(
      "Archived workspaces will be permanently removed after 30 days.",
    );
  });

  it("matches the spec verbatim — Archive confirm label", () => {
    expect(ARCHIVE_DIALOG_CONFIRM_LABEL).toBe("Archive");
  });

  it("matches the spec verbatim — Cancel label", () => {
    expect(ARCHIVE_DIALOG_CANCEL_LABEL).toBe("Cancel");
  });

  it("matches the spec verbatim — unarchive toast banner", () => {
    expect(UNARCHIVE_TOAST_COPY).toBe("Unarchived — this workspace is active again.");
  });

  it("matches the spec verbatim — cold-resume splash", () => {
    expect(COLD_RESUME_SPLASH_COPY).toBe("Resuming workspace…");
  });

  it("matches the spec verbatim — billing-locked prompt", () => {
    expect(BILLING_LOCKED_PROMPT_COPY).toBe("Reactivate your plan to resume this workspace.");
  });
});
