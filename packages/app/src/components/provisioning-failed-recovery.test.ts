import { describe, expect, it } from "vitest";
import {
  PROVISIONING_FAILED_ARCHIVE_BUTTON,
  PROVISIONING_FAILED_ARCHIVE_HINT,
  PROVISIONING_FAILED_CONTACT_SUPPORT_HINT,
  PROVISIONING_FAILED_TITLE,
} from "./provisioning-failed-recovery";

// Locked copy for the provisioning_failed cap-trap recovery affordance
// (PLAN-app.md Task 5, CROSS-STREAM-SYNTHESIS § 1 C5 resolution (a)).
// Operator-pinned phrases — a stray refactor cannot silently rephrase them
// because this test asserts each verbatim.

describe("locked provisioning_failed recovery copy", () => {
  it("matches the title verbatim", () => {
    expect(PROVISIONING_FAILED_TITLE).toBe("This workspace failed to provision.");
  });

  it("matches the archive-hint verbatim", () => {
    expect(PROVISIONING_FAILED_ARCHIVE_HINT).toBe(
      "Archive it to free up capacity. You can try again with a different repo.",
    );
  });

  it("matches the archive button label verbatim", () => {
    expect(PROVISIONING_FAILED_ARCHIVE_BUTTON).toBe("Archive this failed workspace");
  });

  it("matches the contact-support hint verbatim (auth 5xx fallback path)", () => {
    expect(PROVISIONING_FAILED_CONTACT_SUPPORT_HINT).toBe(
      "Couldn't archive automatically. Contact support with this ID:",
    );
  });
});
