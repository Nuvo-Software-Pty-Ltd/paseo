import { describe, expect, it } from "vitest";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import type { WebhookTriggerSummary } from "@getpaseo/protocol/trigger/types";
import {
  formatEveryMs,
  mergeAutomations,
  normalizeSchedule,
  normalizeWebhookTrigger,
} from "./automation-model";

function makeSchedule(overrides: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    id: "sched-1",
    name: "Nightly sync",
    prompt: "do the thing",
    cadence: { type: "every", everyMs: 5 * 60 * 1000 },
    target: { type: "new-agent", config: { provider: "claude", cwd: "/tmp" } },
    status: "active",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    pausedAt: null,
    expiresAt: null,
    maxRuns: null,
    maxRetainedRuns: null,
    cloudOwnerWorkspaceId: null,
    cloudOwnerAccountId: null,
    ...overrides,
  };
}

function makeTrigger(overrides: Partial<WebhookTriggerSummary> = {}): WebhookTriggerSummary {
  return {
    id: "trig-1",
    webhookId: "wh_public_1",
    name: "Deploy hook",
    prompt: "ship it",
    target: { type: "new-agent", config: { provider: "claude", cwd: "/tmp" } },
    payloadTemplate: null,
    enabled: true,
    ingressUrl: "https://example.test/wh/wh_public_1",
    secretFingerprint: "abc123",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    lastFiredAt: null,
    cloudOwnerWorkspaceId: null,
    cloudOwnerAccountId: null,
    ...overrides,
  };
}

describe("formatEveryMs", () => {
  it("formats seconds", () => {
    expect(formatEveryMs(30 * 1000)).toBe("Every 30s");
  });
  it("formats minutes", () => {
    expect(formatEveryMs(5 * 60 * 1000)).toBe("Every 5m");
  });
  it("formats hours", () => {
    expect(formatEveryMs(2 * 60 * 60 * 1000)).toBe("Every 2h");
  });
  it("formats days", () => {
    expect(formatEveryMs(3 * 24 * 60 * 60 * 1000)).toBe("Every 3d");
  });
  it("prefers the largest evenly-dividing unit", () => {
    expect(formatEveryMs(90 * 60 * 1000)).toBe("Every 90m");
    expect(formatEveryMs(60 * 60 * 1000)).toBe("Every 1h");
  });
});

describe("normalizeSchedule cadence + status labels", () => {
  it("labels an every-cadence schedule", () => {
    const automation = normalizeSchedule(
      makeSchedule({ cadence: { type: "every", everyMs: 2 * 60 * 60 * 1000 } }),
    );
    expect(automation.cadenceLabel).toBe("Every 2h");
    expect(automation.kind).toBe("schedule");
  });
  it("labels a cron-cadence schedule", () => {
    const automation = normalizeSchedule(
      makeSchedule({ cadence: { type: "cron", expression: "0 9 * * 1" } }),
    );
    expect(automation.cadenceLabel).toBe("Cron: 0 9 * * 1");
  });
  it("maps active/paused/completed status to labels", () => {
    expect(normalizeSchedule(makeSchedule({ status: "active" })).statusLabel).toBe("Active");
    expect(normalizeSchedule(makeSchedule({ status: "paused" })).statusLabel).toBe("Paused");
    expect(normalizeSchedule(makeSchedule({ status: "completed" })).statusLabel).toBe("Completed");
  });
  it("carries lastRunAt through and never flags lastRunFailed for summaries", () => {
    const automation = normalizeSchedule(makeSchedule({ lastRunAt: "2026-05-02T00:00:00.000Z" }));
    expect(automation.lastRunAt).toBe("2026-05-02T00:00:00.000Z");
    expect(automation.lastRunFailed).toBe(false);
  });
});

describe("normalizeWebhookTrigger labels", () => {
  it("labels cadence as On webhook regardless of state", () => {
    expect(normalizeWebhookTrigger(makeTrigger()).cadenceLabel).toBe("On webhook");
  });
  it("maps enabled to Active and disabled to Disabled", () => {
    expect(normalizeWebhookTrigger(makeTrigger({ enabled: true })).statusLabel).toBe("Active");
    expect(normalizeWebhookTrigger(makeTrigger({ enabled: false })).statusLabel).toBe("Disabled");
  });
  it("uses lastFiredAt as lastRunAt", () => {
    const automation = normalizeWebhookTrigger(
      makeTrigger({ lastFiredAt: "2026-05-03T00:00:00.000Z" }),
    );
    expect(automation.lastRunAt).toBe("2026-05-03T00:00:00.000Z");
  });
});

describe("mergeAutomations sort order", () => {
  it("sorts by updatedAt descending across both kinds", () => {
    const schedules = [
      makeSchedule({ id: "s-old", updatedAt: "2026-05-01T00:00:00.000Z" }),
      makeSchedule({ id: "s-new", updatedAt: "2026-05-05T00:00:00.000Z" }),
    ];
    const triggers = [makeTrigger({ id: "t-mid", updatedAt: "2026-05-03T00:00:00.000Z" })];
    const merged = mergeAutomations(schedules, triggers);
    expect(merged.map((a) => a.id)).toEqual(["s-new", "t-mid", "s-old"]);
  });

  it("is stable for equal updatedAt (schedules before webhooks, source order preserved)", () => {
    const ts = "2026-05-04T00:00:00.000Z";
    const schedules = [
      makeSchedule({ id: "s-a", updatedAt: ts }),
      makeSchedule({ id: "s-b", updatedAt: ts }),
    ];
    const triggers = [
      makeTrigger({ id: "t-a", updatedAt: ts }),
      makeTrigger({ id: "t-b", updatedAt: ts }),
    ];
    const merged = mergeAutomations(schedules, triggers);
    expect(merged.map((a) => a.id)).toEqual(["s-a", "s-b", "t-a", "t-b"]);
  });

  it("returns an empty list when both inputs are empty", () => {
    expect(mergeAutomations([], [])).toEqual([]);
  });
});
