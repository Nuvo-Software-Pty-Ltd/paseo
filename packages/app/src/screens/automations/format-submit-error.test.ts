import { describe, expect, it } from "vitest";
import { formatSubmitError } from "./format-submit-error";

describe("formatSubmitError", () => {
  it("includes the message from an Error instance", () => {
    const result = formatSubmitError(new Error("schedule register failed (500)"), "create");
    expect(result).toBe("Couldn't create the automation: schedule register failed (500)");
  });

  it("uses the save verb for the update action", () => {
    const result = formatSubmitError(new Error("nope"), "save");
    expect(result).toBe("Couldn't save the automation: nope");
  });

  it("falls back to a generic message when the error has no usable message", () => {
    expect(formatSubmitError(new Error(""), "create")).toBe(
      "Couldn't create the automation: an unexpected error occurred.",
    );
  });

  it("handles non-Error throwables (string)", () => {
    expect(formatSubmitError("boom", "create")).toBe("Couldn't create the automation: boom");
  });

  it("handles null/undefined throwables", () => {
    expect(formatSubmitError(null, "save")).toBe(
      "Couldn't save the automation: an unexpected error occurred.",
    );
    expect(formatSubmitError(undefined, "create")).toBe(
      "Couldn't create the automation: an unexpected error occurred.",
    );
  });

  it("does not leak a multi-line stack trace — only the first line of the message", () => {
    const err = new Error("top line\n    at someFn (file.ts:1:1)\n    at other (file.ts:2:2)");
    expect(formatSubmitError(err, "create")).toBe("Couldn't create the automation: top line");
  });

  it("trims surrounding whitespace from the message", () => {
    expect(formatSubmitError(new Error("   padded   "), "save")).toBe(
      "Couldn't save the automation: padded",
    );
  });
});
