import { describe, expect, it } from "vitest";

import { getClaudeModels } from "./agent/providers/claude/models.js";
import {
  CLOUD_PROVIDER_SNAPSHOT,
  CLOUD_PROVIDER_SNAPSHOT_VERSION,
} from "./cloud-provider-snapshot.js";

// Drift guard: the cloud-mode Claude catalog (`CLOUD_PROVIDER_SNAPSHOT`) is a
// hand-curated mirror of the on-host catalog (`getClaudeModels()`), served only
// when `isPaseoCloudMode()` is true. The two have historically drifted silently
// (a model added to `models.ts` never reached cloud). These assertions couple
// the functional fields — ids, default, thinking/effort options — so any future
// `models.ts` change forces a deliberate cloud-catalog update.
//
// `label`/`description` are intentionally NOT asserted: cloud curates its own
// end-user copy and is free to differ there.
describe("CLOUD_PROVIDER_SNAPSHOT — Claude catalog drift guard", () => {
  const claudeEntry = CLOUD_PROVIDER_SNAPSHOT.find((entry) => entry.provider === "claude");
  const cloudModels = claudeEntry?.models ?? [];
  const sourceModels = getClaudeModels();

  it("has a claude entry with models", () => {
    expect(claudeEntry).toBeDefined();
    expect(cloudModels.length).toBeGreaterThan(0);
  });

  it("exposes exactly the same model ids as getClaudeModels()", () => {
    const cloudIds = cloudModels.map((model) => model.id).sort();
    const sourceIds = sourceModels.map((model) => model.id).sort();
    // Catches both a models.ts model missing from cloud (the drift bug) and a
    // stale cloud-only id that no longer exists on-host.
    expect(cloudIds).toEqual(sourceIds);
  });

  it("marks the same single default model as getClaudeModels()", () => {
    const cloudDefaults = cloudModels.filter((model) => model.isDefault).map((model) => model.id);
    const sourceDefaults = sourceModels.filter((model) => model.isDefault).map((model) => model.id);
    expect(cloudDefaults).toHaveLength(1);
    expect(cloudDefaults).toEqual(sourceDefaults);
  });

  it("matches thinkingOptions per model id", () => {
    const sourceById = new Map(sourceModels.map((model) => [model.id, model]));
    for (const cloudModel of cloudModels) {
      const source = sourceById.get(cloudModel.id);
      expect(source, `cloud model ${cloudModel.id} missing from getClaudeModels()`).toBeDefined();
      expect(cloudModel.thinkingOptions ?? null).toEqual(source?.thinkingOptions ?? null);
    }
  });

  it("uses a well-formed catalog version string", () => {
    expect(CLOUD_PROVIDER_SNAPSHOT_VERSION).toMatch(/^\d{4}\.\d{2}-\d+$/);
  });
});
