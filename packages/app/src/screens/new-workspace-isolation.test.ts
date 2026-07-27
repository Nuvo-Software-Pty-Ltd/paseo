import { describe, expect, it } from "vitest";

import { resolveSelectedIsGit } from "./new-workspace-isolation";

describe("resolveSelectedIsGit", () => {
  it("keeps worktree isolation available for a cloud clone awaiting rehydration", () => {
    // The sii-google-ads report: after a recycle the tmpfs clone is gone, so the
    // checkout probe reports isGit:false. Trusting it hid the isolation control
    // and sent the create down the `directory` branch, which failed
    // "Directory not found: /workspace/ws_.../Nuvo-Software-Pty-Ltd__sii-google-ads".
    expect(
      resolveSelectedIsGit({
        probeIsGit: false,
        projectCanCreateWorktree: true,
      }),
    ).toBe(true);
  });

  it("keeps it available while the probe is still in flight", () => {
    expect(
      resolveSelectedIsGit({
        probeIsGit: undefined,
        projectCanCreateWorktree: true,
      }),
    ).toBe(true);
  });

  it("trusts a positive probe even for a project with no durable git kind", () => {
    expect(
      resolveSelectedIsGit({
        probeIsGit: true,
        projectCanCreateWorktree: false,
      }),
    ).toBe(true);
  });

  it("stays false for a genuinely non-git project", () => {
    expect(
      resolveSelectedIsGit({
        probeIsGit: false,
        projectCanCreateWorktree: false,
      }),
    ).toBe(false);
    expect(
      resolveSelectedIsGit({
        probeIsGit: undefined,
        projectCanCreateWorktree: undefined,
      }),
    ).toBe(false);
  });
});
