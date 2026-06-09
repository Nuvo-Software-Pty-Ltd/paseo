import { describe, expect, it } from "vitest";

import {
  ENV_VARS_GROUP_TITLE,
  ENV_VARS_OVERRIDE_BADGE,
  ENV_VARS_PRECEDENCE_NOTE,
  ENV_VARS_UPDATE_HOST,
  envVarKeyErrorMessage,
} from "@/lib/env-vars-copy";

// D-3.5c — user-visible copy is a binding promise. Any rephrase MUST update
// the constant and this test together (mirrors cloud-workspace-archive-dialog).
describe("scoped env-var copy", () => {
  it("states the project-over-workspace precedence verbatim (DECISION P-1)", () => {
    expect(ENV_VARS_PRECEDENCE_NOTE).toBe(
      "Workspace variables apply to every project. Set a variable here to override it for this project.",
    );
  });

  it("labels the override badge verbatim", () => {
    expect(ENV_VARS_OVERRIDE_BADGE).toBe("overrides workspace");
  });

  it("uses the feature-contract 'update the host' message verbatim", () => {
    expect(ENV_VARS_UPDATE_HOST).toBe("Update the host to use this.");
  });

  it("titles the section verbatim", () => {
    expect(ENV_VARS_GROUP_TITLE).toBe("Environment variables");
  });
});

describe("envVarKeyErrorMessage", () => {
  it("maps the daemon validation codes to inline messages", () => {
    expect(envVarKeyErrorMessage("reserved")).toBe("That name is reserved by the platform.");
    expect(envVarKeyErrorMessage("invalid_charset")).toBe(
      "Use letters, digits, and underscores; can't start with a digit.",
    );
    expect(envVarKeyErrorMessage("empty")).toBe("Enter a variable name.");
    expect(envVarKeyErrorMessage("unsupported")).toBe(ENV_VARS_UPDATE_HOST);
  });

  it("falls back for unknown / missing codes", () => {
    expect(envVarKeyErrorMessage("mystery")).toBe("Couldn't save the variable.");
    expect(envVarKeyErrorMessage(undefined)).toBe("Couldn't save the variable.");
  });
});
