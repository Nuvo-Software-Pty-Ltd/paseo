import { describe, expect, test } from "vitest";

import { ScheduleCadenceSchema, ScheduleTargetSchema, StoredScheduleSchema } from "./types.js";

describe("ScheduleCadenceSchema", () => {
  test("accepts existing UTC cron cadence without a time zone", () => {
    expect(ScheduleCadenceSchema.parse({ type: "cron", expression: "0 9 * * *" })).toEqual({
      type: "cron",
      expression: "0 9 * * *",
    });
  });

  test("accepts timezone-aware cron cadence", () => {
    expect(
      ScheduleCadenceSchema.parse({
        type: "cron",
        expression: "0 9 * * *",
        timezone: "America/New_York",
      }),
    ).toEqual({
      type: "cron",
      expression: "0 9 * * *",
      timezone: "America/New_York",
    });
  });
});

describe("ScheduleTargetSchema — run-location fields", () => {
  test("a new-agent target without run-location fields parses (back-compat)", () => {
    const parsed = ScheduleTargetSchema.parse({
      type: "new-agent",
      config: { provider: "claude", cwd: "/tmp" },
    });
    expect(parsed).toEqual({ type: "new-agent", config: { provider: "claude", cwd: "/tmp" } });
  });

  test("accepts workspaceMode + workspaceId on a new-agent target", () => {
    const parsed = ScheduleTargetSchema.parse({
      type: "new-agent",
      config: {
        provider: "claude",
        cwd: "/tmp",
        workspaceMode: "dedicated-worktree",
        workspaceId: "ws_1",
      },
    });
    expect(parsed).toMatchObject({
      type: "new-agent",
      config: { workspaceMode: "dedicated-worktree", workspaceId: "ws_1" },
    });
  });

  test("rejects an unknown workspaceMode", () => {
    expect(() =>
      ScheduleTargetSchema.parse({
        type: "new-agent",
        config: { provider: "claude", cwd: "/tmp", workspaceMode: "bogus" },
      }),
    ).toThrow();
  });
});

describe("StoredScheduleSchema — maxRetainedRuns back-compat", () => {
  test("a pre-upgrade record without maxRetainedRuns parses with null default", () => {
    const parsed = StoredScheduleSchema.parse({
      id: "s1",
      name: null,
      prompt: "do it",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: "/tmp" } },
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    });
    expect(parsed.maxRetainedRuns).toBeNull();
  });
});
