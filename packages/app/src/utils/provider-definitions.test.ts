import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { buildSelectableProviderOptions, isSelectableProviderEntry } from "./provider-definitions";

function entry(overrides: Partial<ProviderSnapshotEntry>): ProviderSnapshotEntry {
  return {
    provider: "claude",
    status: "ready",
    enabled: true,
    ...overrides,
  };
}

describe("buildSelectableProviderOptions", () => {
  it("offers ready providers, mapping label/provider", () => {
    const options = buildSelectableProviderOptions([
      entry({ provider: "claude", label: "Claude", status: "ready" }),
      entry({ provider: "codex", label: "Codex", status: "ready" }),
    ]);
    expect(options).toEqual([
      { id: "claude", label: "Claude" },
      { id: "codex", label: "Codex" },
    ]);
  });

  it("falls back to the provider id when no label is present", () => {
    const options = buildSelectableProviderOptions([
      entry({ provider: "opencode", label: undefined }),
    ]);
    expect(options).toEqual([{ id: "opencode", label: "opencode" }]);
  });

  // Regression: the old `.filter((entry) => entry.enabled)` predicate dropped a
  // selectable ("ready") provider that was not flagged `enabled` — exactly the
  // cloud Anthropic case that left the automation dropdown empty. The composer
  // offers it (status-based), so the automation picker must too.
  it("offers a ready provider even when enabled is false (regression)", () => {
    const options = buildSelectableProviderOptions([
      entry({ provider: "claude", label: "Claude", status: "ready", enabled: false }),
    ]);
    expect(options).toEqual([{ id: "claude", label: "Claude" }]);
  });

  it("excludes providers that are not selectable (loading / error)", () => {
    const options = buildSelectableProviderOptions([
      entry({ provider: "claude", status: "loading" }),
      entry({ provider: "codex", status: "error" }),
    ]);
    expect(options).toEqual([]);
  });

  it("handles an undefined snapshot", () => {
    expect(buildSelectableProviderOptions(undefined)).toEqual([]);
  });
});

describe("isSelectableProviderEntry", () => {
  it("keys off status, not the enabled flag", () => {
    expect(isSelectableProviderEntry(entry({ status: "ready", enabled: false }))).toBe(true);
    expect(isSelectableProviderEntry(entry({ status: "loading", enabled: true }))).toBe(false);
  });
});
