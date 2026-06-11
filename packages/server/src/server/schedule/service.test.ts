import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { getCurrentWorkspaceAuth, workspaceAuthStorage } from "../cloud-auth.js";
import { ScheduleService } from "./service.js";
import { FileBackedScheduleStore } from "./store.js";
import type { StoredSchedule, ScheduleExecutionResult } from "./types.js";

function makeStore(paseoHome: string): FileBackedScheduleStore {
  return new FileBackedScheduleStore(join(paseoHome, "schedules"));
}

interface ScheduleServiceInternals {
  executeSchedule(schedule: StoredSchedule): Promise<ScheduleExecutionResult>;
}

describe("ScheduleService", () => {
  let tempDir: string;
  let agentStorage: AgentStorage;
  let now: Date;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "schedule-service-test-"));
    await mkdir(join(tempDir, "agents"), { recursive: true });
    agentStorage = new AgentStorage(join(tempDir, "agents"), createTestLogger());
    await agentStorage.initialize();
    now = new Date("2026-01-01T00:00:00.000Z");
  });

  afterEach(async () => {
    // Drain pending background persists before deleting the dir to avoid
    // ENOTEMPTY races when AgentManager flushes a snapshot mid-cleanup.
    await agentStorage.flush();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("ticks due schedules and records run history on disk", async () => {
    const service = new ScheduleService({
      store: makeStore(tempDir),
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      now: () => now,
      runner: async (schedule) => ({
        agentId: "00000000-0000-0000-0000-000000000001",
        output: `ran:${schedule.prompt}`,
      }),
    });

    const created = await service.create({
      prompt: "Review new PRs",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
        },
      },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs).toHaveLength(1);
    expect(inspected.runs[0]).toMatchObject({
      status: "succeeded",
      agentId: "00000000-0000-0000-0000-000000000001",
      output: "ran:Review new PRs",
    });
    expect(inspected.nextRunAt).toBe("2026-01-01T00:02:00.000Z");
  });

  test("pause and resume update persisted schedule state", async () => {
    const service = new ScheduleService({
      store: makeStore(tempDir),
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      now: () => now,
      runner: async () => ({
        agentId: null,
        output: "ok",
      }),
    });

    const created = await service.create({
      prompt: "Check status",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
        },
      },
    });

    const paused = await service.pause(created.id);
    expect(paused.status).toBe("paused");
    expect(paused.nextRunAt).toBeNull();

    now = new Date("2026-01-01T00:03:00.000Z");
    const resumed = await service.resume(created.id);
    expect(resumed.status).toBe("active");
    expect(resumed.nextRunAt).toBe("2026-01-01T00:04:00.000Z");
  });

  test("completes schedules when max runs is reached", async () => {
    const service = new ScheduleService({
      store: makeStore(tempDir),
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      now: () => now,
      runner: async () => ({
        agentId: null,
        output: "done",
      }),
    });

    const created = await service.create({
      prompt: "One shot",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("completed");
    expect(inspected.nextRunAt).toBeNull();
  });

  test("executes new-agent schedules through AgentManager with real fake clients", async () => {
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const service = new ScheduleService({
      store: makeStore(tempDir),
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      now: () => now,
    });

    const created = await service.create({
      prompt: "Respond with exactly hello",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
          approvalPolicy: "never",
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    expect(inspected.runs).toHaveLength(1);
    expect(inspected.runs[0]?.status).toBe("succeeded");
    expect(inspected.runs[0]?.agentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("defaults new-agent modeId to provider's unattended mode", async () => {
    const manager = new AgentManager({
      logger: createTestLogger(),
      clients: createTestAgentClients(),
      registry: agentStorage,
    });
    const service = new ScheduleService({
      store: makeStore(tempDir),
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      now: () => now,
    });

    const created = await service.create({
      prompt: "Respond with exactly hello",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
          approvalPolicy: "never",
        },
      },
      maxRuns: 1,
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    const inspected = await service.inspect(created.id);
    const agentId = inspected.runs[0]?.agentId;
    expect(agentId).toBeTruthy();
    const agent = manager.getAgent(agentId!);
    expect(agent?.currentModeId).toBe("bypassPermissions");
  });

  test("advances stale nextRunAt on daemon restart", async () => {
    const service1 = new ScheduleService({
      store: makeStore(tempDir),
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service1.create({
      prompt: "Periodic check",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      runOnCreate: false,
    });

    expect(created.nextRunAt).toBe("2026-01-01T00:01:00.000Z");
    await service1.stop();

    // Simulate daemon restart 10 minutes later
    now = new Date("2026-01-01T00:10:00.000Z");
    const service2 = new ScheduleService({
      store: makeStore(tempDir),
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });
    await service2.start();

    const inspected = await service2.inspect(created.id);
    expect(new Date(inspected.nextRunAt!).getTime()).toBeGreaterThan(now.getTime());
    await service2.stop();
  });

  test("keeps schedules paused when an in-flight run finishes after pause", async () => {
    let releaseRun: (() => void) | null = null;
    const runStarted = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let finishRun: (() => void) | null = null;
    const runBlocked = new Promise<void>((resolve) => {
      finishRun = resolve;
    });

    const service = new ScheduleService({
      store: makeStore(tempDir),
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      now: () => now,
      runner: async () => {
        releaseRun?.();
        await runBlocked;
        return {
          agentId: null,
          output: "finished",
        };
      },
    });

    const created = await service.create({
      prompt: "Check status",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
        },
      },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    const tickPromise = service.tick();
    await runStarted;

    const paused = await service.pause(created.id);
    expect(paused.status).toBe("paused");
    expect(paused.nextRunAt).toBeNull();

    finishRun?.();
    await tickPromise;

    const inspected = await service.inspect(created.id);
    expect(inspected.status).toBe("paused");
    expect(inspected.nextRunAt).toBeNull();
    expect(inspected.runs).toHaveLength(1);
    expect(inspected.runs[0]?.status).toBe("succeeded");
  });

  test("rejects archived target agents before loading them", async () => {
    const manager = new AgentManager({ logger: createTestLogger() });
    const service = new ScheduleService({
      store: makeStore(tempDir),
      logger: createTestLogger(),
      agentManager: manager,
      agentStorage,
      now: () => now,
    });

    await agentStorage.upsert({
      id: "archived-agent",
      provider: "claude",
      cwd: tempDir,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastActivityAt: now.toISOString(),
      lastUserMessageAt: null,
      title: "Archived Agent",
      labels: {},
      lastStatus: "closed",
      lastModeId: "default",
      config: {
        modeId: "default",
      },
      runtimeInfo: null,
      features: [],
      persistence: null,
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      internal: false,
      archivedAt: "2026-01-02T00:00:00.000Z",
    });

    await expect(
      (service as unknown as ScheduleServiceInternals).executeSchedule({
        id: "schedule-1",
        name: null,
        prompt: "Check archived agent",
        cadence: { type: "every", everyMs: 60_000 },
        target: {
          type: "agent",
          agentId: "archived-agent",
        },
        status: "active",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        nextRunAt: now.toISOString(),
        lastRunAt: null,
        pausedAt: null,
        expiresAt: null,
        maxRuns: null,
        runs: [],
      }),
    ).rejects.toThrow("Agent archived-agent is archived");
  });

  test("defaults --every schedules to fire immediately on creation", async () => {
    const service = new ScheduleService({
      store: makeStore(tempDir),
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "every default",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
    });

    expect(created.nextRunAt).toBe(now.toISOString());
  });

  test("--every with runOnCreate=false waits the full interval", async () => {
    const service = new ScheduleService({
      store: makeStore(tempDir),
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "wait interval",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      runOnCreate: false,
    });

    expect(created.nextRunAt).toBe("2026-01-01T00:01:00.000Z");
  });

  test("--cron defaults to the next cron slot", async () => {
    const service = new ScheduleService({
      store: makeStore(tempDir),
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "cron default",
      cadence: { type: "cron", expression: "30 9 * * *" },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
    });

    expect(created.nextRunAt).toBe("2026-01-01T09:30:00.000Z");
  });

  test("--cron with runOnCreate=true fires immediately on creation", async () => {
    const service = new ScheduleService({
      store: makeStore(tempDir),
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "cron run-now",
      cadence: { type: "cron", expression: "30 9 * * *" },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      runOnCreate: true,
    });

    expect(created.nextRunAt).toBe(now.toISOString());
  });

  test("runOnce records a run without changing nextRunAt or completing the schedule", async () => {
    const service = new ScheduleService({
      store: makeStore(tempDir),
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      now: () => now,
      runner: async (schedule) => ({
        agentId: "00000000-0000-0000-0000-000000000099",
        output: `manual:${schedule.prompt}`,
      }),
    });

    const created = await service.create({
      prompt: "manual fire",
      cadence: { type: "cron", expression: "30 9 * * *" },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      maxRuns: 1,
    });
    expect(created.nextRunAt).toBe("2026-01-01T09:30:00.000Z");

    const after = await service.runOnce(created.id);
    expect(after.nextRunAt).toBe("2026-01-01T09:30:00.000Z");
    expect(after.status).toBe("active");
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0]).toMatchObject({
      status: "succeeded",
      agentId: "00000000-0000-0000-0000-000000000099",
      output: "manual:manual fire",
    });
  });

  test("update mutates cadence, prompt, name, and target fields in place", async () => {
    const service = new ScheduleService({
      store: makeStore(tempDir),
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      name: "morning",
      prompt: "first prompt",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir, modeId: "default" },
      },
    });
    expect(created.runs).toEqual([]);

    now = new Date("2026-01-01T00:00:30.000Z");
    const updated = await service.update({
      id: created.id,
      prompt: "second prompt",
      name: "renamed",
      cadence: { type: "every", everyMs: 5 * 60_000 },
      newAgentConfig: {
        provider: "codex",
        model: "gpt-5",
        modeId: "full-access",
        cwd: "/new/path",
      },
    });

    expect(updated.prompt).toBe("second prompt");
    expect(updated.name).toBe("renamed");
    expect(updated.cadence).toEqual({ type: "every", everyMs: 5 * 60_000 });
    expect(updated.target).toEqual({
      type: "new-agent",
      config: {
        provider: "codex",
        cwd: "/new/path",
        model: "gpt-5",
        modeId: "full-access",
      },
    });
    expect(updated.nextRunAt).toBe("2026-01-01T00:05:30.000Z");
    expect(updated.updatedAt).toBe("2026-01-01T00:00:30.000Z");
    expect(updated.createdAt).toBe(created.createdAt);
  });

  test("update switches between every and cron cadences and recomputes nextRunAt", async () => {
    const service = new ScheduleService({
      store: makeStore(tempDir),
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });
    expect(created.nextRunAt).toBe("2026-01-01T00:00:00.000Z");

    const cron = await service.update({
      id: created.id,
      cadence: { type: "cron", expression: "30 9 * * *" },
    });
    expect(cron.cadence).toEqual({ type: "cron", expression: "30 9 * * *" });
    expect(cron.nextRunAt).toBe("2026-01-01T09:30:00.000Z");

    const back = await service.update({
      id: created.id,
      cadence: { type: "every", everyMs: 2 * 60_000 },
    });
    expect(back.cadence).toEqual({ type: "every", everyMs: 2 * 60_000 });
    expect(back.nextRunAt).toBe("2026-01-01T00:02:00.000Z");
  });

  test("update preserves nextRunAt and run history when cadence is unchanged", async () => {
    const service = new ScheduleService({
      store: makeStore(tempDir),
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ran" }),
    });

    const created = await service.create({
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });

    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();
    const after = await service.inspect(created.id);
    expect(after.runs).toHaveLength(1);

    now = new Date("2026-01-01T00:01:30.000Z");
    const updated = await service.update({ id: created.id, prompt: "new prompt" });

    expect(updated.prompt).toBe("new prompt");
    expect(updated.cadence).toEqual(created.cadence);
    expect(updated.nextRunAt).toBe(after.nextRunAt);
    expect(updated.runs).toEqual(after.runs);
    expect(updated.lastRunAt).toBe(after.lastRunAt);
  });

  test("update clears the schedule name when given an empty string", async () => {
    const service = new ScheduleService({
      store: makeStore(tempDir),
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      name: "named",
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });
    expect(created.name).toBe("named");

    const cleared = await service.update({ id: created.id, name: "" });
    expect(cleared.name).toBeNull();

    const renamed = await service.update({ id: created.id, name: "again" });
    expect(renamed.name).toBe("again");
  });

  test("update rejects new-agent fields on agent-target schedules", async () => {
    const service = new ScheduleService({
      store: makeStore(tempDir),
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "agent target",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "agent", agentId: "00000000-0000-0000-0000-000000000005" },
    });

    await expect(
      service.update({
        id: created.id,
        newAgentConfig: { provider: "codex" },
      }),
    ).rejects.toThrow("only valid for new-agent target schedules");
  });

  test("update changes individual new-agent fields independently", async () => {
    const service = new ScheduleService({
      store: makeStore(tempDir),
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir, model: "sonnet", modeId: "default" },
      },
    });

    const modeOnly = await service.update({
      id: created.id,
      newAgentConfig: { modeId: "bypassPermissions" },
    });
    expect(modeOnly.target).toMatchObject({
      type: "new-agent",
      config: {
        provider: "claude",
        cwd: tempDir,
        model: "sonnet",
        modeId: "bypassPermissions",
      },
    });

    const clearModel = await service.update({
      id: created.id,
      newAgentConfig: { model: null },
    });
    if (clearModel.target.type !== "new-agent") {
      throw new Error("target type changed unexpectedly");
    }
    expect(clearModel.target.config.model).toBeUndefined();
    expect(clearModel.target.config.modeId).toBe("bypassPermissions");
  });

  test("update patches and clears the new-agent thinkingOptionId independently", async () => {
    const service = new ScheduleService({
      store: makeStore(tempDir),
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir, model: "opus" },
      },
    });

    const withEffort = await service.update({
      id: created.id,
      newAgentConfig: { thinkingOptionId: "high" },
    });
    if (withEffort.target.type !== "new-agent") {
      throw new Error("target type changed unexpectedly");
    }
    expect(withEffort.target.config.thinkingOptionId).toBe("high");
    expect(withEffort.target.config.model).toBe("opus");

    const cleared = await service.update({
      id: created.id,
      newAgentConfig: { thinkingOptionId: null },
    });
    if (cleared.target.type !== "new-agent") {
      throw new Error("target type changed unexpectedly");
    }
    expect(cleared.target.config.thinkingOptionId).toBeUndefined();
  });

  test("update returns a schedule that round-trips through the store", async () => {
    const service = new ScheduleService({
      store: makeStore(tempDir),
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "p",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
    });

    await service.update({
      id: created.id,
      cadence: { type: "cron", expression: "0 9 * * *" },
      newAgentConfig: { provider: "codex", modeId: "full-access" },
    });

    const reloaded = await service.inspect(created.id);
    expect(reloaded.cadence).toEqual({ type: "cron", expression: "0 9 * * *" });
    expect(reloaded.target).toEqual({
      type: "new-agent",
      config: { provider: "codex", cwd: tempDir, modeId: "full-access" },
    });
  });

  test("runOnce rejects completed schedules", async () => {
    const service = new ScheduleService({
      store: makeStore(tempDir),
      logger: createTestLogger(),
      agentManager: new AgentManager({ logger: createTestLogger() }),
      agentStorage,
      now: () => now,
      runner: async () => ({ agentId: null, output: "ok" }),
    });

    const created = await service.create({
      prompt: "one-shot",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      maxRuns: 1,
    });
    now = new Date("2026-01-01T00:01:00.000Z");
    await service.tick();

    await expect(service.runOnce(created.id)).rejects.toThrow("already completed");
  });

  // D-3.5d async-ack — fireOnceDetached (the cloud schedule-fire-callback
  // path) spawns the agent in the foreground and runs its first turn
  // detached, bypassing the injected `runner` to use the real spawn core.
  // Kept as flat tests (not a nested describe) to stay within the repo's
  // max-nested-callbacks=3 lint ceiling.
  {
    const AGENT_ID = "00000000-0000-0000-0000-000000000abc";

    function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    function makeService(manager: AgentManager): ScheduleService {
      return new ScheduleService({
        store: makeStore(tempDir),
        logger: createTestLogger(),
        agentManager: manager,
        agentStorage,
        now: () => now,
      });
    }

    // A function, not a const: `tempDir` is only assigned in beforeEach, after
    // the describe body is evaluated.
    function newAgentTarget() {
      return { type: "new-agent" as const, config: { provider: "claude", cwd: tempDir } };
    }

    test("acks on spawn and finalizes the run record in the background", async () => {
      const gate = deferred<{ timeline: never[]; finalText: string }>();
      const runAgent = vi.fn(() => gate.promise);
      const manager = {
        createAgent: vi.fn(async () => ({ id: AGENT_ID })),
        runAgent,
        hasInFlightRun: vi.fn(() => false),
      } as unknown as AgentManager;
      const service = makeService(manager);
      const created = await service.create({
        prompt: "deploy",
        cadence: { type: "every", everyMs: 60_000 },
        target: newAgentTarget(),
      });

      const { done } = await service.fireOnceDetached(created.id);
      // Spawned but turn not finished: run is `running`, names its agent.
      expect(runAgent).toHaveBeenCalledTimes(1);
      const running = (await service.inspect(created.id)).runs;
      expect(running).toHaveLength(1);
      expect(running[0].status).toBe("running");
      expect(running[0].agentId).toBe(AGENT_ID);

      gate.resolve({ timeline: [], finalText: "ok" });
      await done;
      const settled = (await service.inspect(created.id)).runs;
      expect(settled[0].status).toBe("succeeded");
      expect(settled[0].agentId).toBe(AGENT_ID);
      // Manual semantics: cadence is NOT advanced (EventBridge owns it).
      expect((await service.inspect(created.id)).nextRunAt).toBe(created.nextRunAt);
    });

    test("a create failure rejects synchronously and records a failed run", async () => {
      const runAgent = vi.fn(async () => ({ timeline: [], finalText: "x" }));
      const manager = {
        createAgent: vi.fn(async () => {
          throw new Error("ENOENT: bad cwd");
        }),
        runAgent,
        hasInFlightRun: vi.fn(() => false),
      } as unknown as AgentManager;
      const service = makeService(manager);
      const created = await service.create({
        prompt: "deploy",
        cadence: { type: "every", everyMs: 60_000 },
        target: newAgentTarget(),
      });

      await expect(service.fireOnceDetached(created.id)).rejects.toThrow(/ENOENT/);
      expect(runAgent).not.toHaveBeenCalled();
      const runs = (await service.inspect(created.id)).runs;
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe("failed");
      // The in-flight lock is released, so a re-fire is allowed.
      await expect(service.fireOnceDetached(created.id)).rejects.toThrow(/ENOENT/);
    });

    test("the detached turn runs inside the schedule's workspace ALS context", async () => {
      let seen: ReturnType<typeof getCurrentWorkspaceAuth>;
      const runAgent = vi.fn(async () => {
        seen = getCurrentWorkspaceAuth();
        return { timeline: [], finalText: "ok" };
      });
      const manager = {
        createAgent: vi.fn(async () => ({ id: AGENT_ID })),
        runAgent,
        hasInFlightRun: vi.fn(() => false),
      } as unknown as AgentManager;
      const service = makeService(manager);
      // Create inside an ALS so the schedule persists cloudOwner* claims.
      const created = await workspaceAuthStorage.run(
        { workspaceId: "ws_x", accountId: "acc_x", expiresAt: Number.MAX_SAFE_INTEGER },
        () =>
          service.create({
            prompt: "deploy",
            cadence: { type: "every", everyMs: 60_000 },
            target: newAgentTarget(),
          }),
      );
      expect(created.cloudOwnerWorkspaceId).toBe("ws_x");

      // Fire OUTSIDE any ALS — the detached turn must restore the context.
      const { done } = await service.fireOnceDetached(created.id);
      await done;
      expect(seen).toMatchObject({ workspaceId: "ws_x", accountId: "acc_x" });
    });
  }
});
