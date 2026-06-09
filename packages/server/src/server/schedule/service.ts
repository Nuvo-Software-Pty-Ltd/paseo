import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { AgentManager } from "../agent/agent-manager.js";
import type { AgentStore } from "../agent/agent-storage.js";
import { formatSystemNotificationPrompt } from "../agent/agent-prompt.js";
import { getCurrentWorkspaceAuth, workspaceAuthStorage } from "../cloud-auth.js";
import { spawnFromAutomation } from "../automation/spawn.js";
import type { ScheduleStore } from "./store.js";
import { computeNextRunAt, validateScheduleCadence } from "./cron.js";
import type {
  CreateScheduleInput,
  ScheduleExecutionResult,
  ScheduleRun,
  ScheduleTarget,
  StoredSchedule,
  UpdateScheduleInput,
  UpdateScheduleNewAgentConfig,
} from "./types.js";

const SCHEDULE_TICK_INTERVAL_MS = 1000;

function trimOptionalName(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildScheduleFireBody(schedule: StoredSchedule, runId: string): string {
  const heading = schedule.name
    ? `Schedule "${schedule.name}" fired (id=${schedule.id}, run=${runId}).`
    : `Schedule fired (id=${schedule.id}, run=${runId}).`;
  return `${heading}\n${schedule.prompt}`;
}

function normalizePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error("Schedule prompt is required");
  }
  return trimmed;
}

function applyNewAgentConfig(
  target: Extract<ScheduleTarget, { type: "new-agent" }>,
  patch: UpdateScheduleNewAgentConfig,
): Extract<ScheduleTarget, { type: "new-agent" }> {
  const config = { ...target.config };
  if (patch.provider !== undefined) {
    const trimmed = patch.provider.trim();
    if (!trimmed) {
      throw new Error("provider cannot be empty");
    }
    config.provider = trimmed;
  }
  if (patch.cwd !== undefined) {
    const trimmed = patch.cwd.trim();
    if (!trimmed) {
      throw new Error("cwd cannot be empty");
    }
    config.cwd = trimmed;
  }
  if (patch.model !== undefined) {
    const trimmed = patch.model?.trim();
    if (trimmed) {
      config.model = trimmed;
    } else {
      delete config.model;
    }
  }
  if (patch.modeId !== undefined) {
    const trimmed = patch.modeId?.trim();
    if (trimmed) {
      config.modeId = trimmed;
    } else {
      delete config.modeId;
    }
  }
  return { ...target, config };
}

function normalizeMaxRuns(value: number | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("maxRuns must be a positive integer");
  }
  return value;
}

function countCompletedRuns(schedule: StoredSchedule): number {
  return schedule.runs.filter((run) => run.status !== "running").length;
}

function shouldCompleteSchedule(schedule: StoredSchedule, now: Date): boolean {
  if (schedule.expiresAt && new Date(schedule.expiresAt).getTime() <= now.getTime()) {
    return true;
  }
  if (schedule.maxRuns == null) {
    return false;
  }
  return countCompletedRuns(schedule) >= schedule.maxRuns;
}

function completeSchedule(schedule: StoredSchedule, now: Date): StoredSchedule {
  return {
    ...schedule,
    status: "completed",
    nextRunAt: null,
    pausedAt: null,
    updatedAt: now.toISOString(),
  };
}

export interface ScheduleServiceOptions {
  store: ScheduleStore;
  logger: Logger;
  agentManager: AgentManager;
  agentStorage: AgentStore;
  now?: () => Date;
  runner?: (schedule: StoredSchedule, runId: string) => Promise<ScheduleExecutionResult>;
}

export class ScheduleService {
  private readonly store: ScheduleStore;
  private readonly logger: Logger;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStore;
  private readonly now: () => Date;
  private readonly runner: (
    schedule: StoredSchedule,
    runId: string,
  ) => Promise<ScheduleExecutionResult>;
  private readonly runningScheduleIds = new Set<string>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ScheduleServiceOptions) {
    this.store = options.store;
    this.logger = options.logger.child({ module: "schedule-service" });
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.now = options.now ?? (() => new Date());
    this.runner = options.runner ?? ((schedule, runId) => this.executeSchedule(schedule, runId));
  }

  async start(): Promise<void> {
    await this.recoverInterruptedRuns();
    if (this.tickTimer) {
      return;
    }
    const timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.logger.error({ err: error }, "Failed to process schedule tick");
      });
    }, SCHEDULE_TICK_INTERVAL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.tickTimer = timer;
  }

  async stop(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  async create(input: CreateScheduleInput): Promise<StoredSchedule> {
    const now = this.now();
    const prompt = normalizePrompt(input.prompt);
    validateScheduleCadence(input.cadence);
    const runOnCreate = input.runOnCreate ?? input.cadence.type === "every";
    const nextRunAt = runOnCreate ? now : computeNextRunAt(input.cadence, now);
    // T-7 (synthesis carryover): persist the workspace + account
    // claims from the ALS at create-time so the fire-time spawn can
    // restore them before invoking the agent. F3 design-out: NEVER
    // accept from a caller; ALWAYS derive from getCurrentWorkspaceAuth.
    // On-host (no ALS) → both null.
    const cloudOwner = getCurrentWorkspaceAuth();
    const schedule = await this.store.create({
      name: trimOptionalName(input.name),
      prompt,
      cadence: input.cadence,
      target: input.target,
      status: "active",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: nextRunAt.toISOString(),
      lastRunAt: null,
      pausedAt: null,
      expiresAt: input.expiresAt ?? null,
      maxRuns: normalizeMaxRuns(input.maxRuns),
      runs: [],
      cloudOwnerWorkspaceId: cloudOwner?.workspaceId ?? null,
      cloudOwnerAccountId: cloudOwner?.accountId ?? null,
    });
    return schedule;
  }

  async list(): Promise<StoredSchedule[]> {
    return this.store.list();
  }

  /**
   * Public store accessor. Used by the bootstrap caller to wire the
   * same store into the T-15 `/api/internal/schedule-fire` route — so
   * the route looks the schedule up via the same DDB / file path the
   * service itself uses.
   */
  getStore(): ScheduleStore {
    return this.store;
  }

  /**
   * Count of schedules whose `nextRunAt` falls within the next
   * `lookaheadMs` ms (default 30s — one heartbeat window). Consumed by
   * the cloud-mode heartbeat (T-17, synthesis A6) so the lifecycle
   * worker's R7 idle-suspend gate does not false-positive on a
   * workspace whose only activity is a pending schedule that's about
   * to fire (no agents alive, no WS clients connected).
   *
   * Schedules with `status:"paused"` / `"completed"` / `nextRunAt:null`
   * are excluded. Schedules whose `nextRunAt` has already elapsed are
   * INCLUDED — they are due to fire and count as "active work".
   *
   * The method reads the store directly (no in-memory cache); a cloud
   * `DynamoScheduleStore` will query DDB per call. The cost is one
   * partition scan per 30s, acceptable given the per-workspace scope.
   */
  async pendingCount(lookaheadMs = 30_000, now: Date = this.now()): Promise<number> {
    const upperBound = new Date(now.getTime() + lookaheadMs);
    const schedules = await this.store.list();
    let count = 0;
    for (const schedule of schedules) {
      if (schedule.status !== "active") continue;
      if (!schedule.nextRunAt) continue;
      if (new Date(schedule.nextRunAt) <= upperBound) count += 1;
    }
    return count;
  }

  async inspect(id: string): Promise<StoredSchedule> {
    const schedule = await this.store.get(id);
    if (!schedule) {
      throw new Error(`Schedule not found: ${id}`);
    }
    return schedule;
  }

  async logs(id: string): Promise<ScheduleRun[]> {
    const schedule = await this.inspect(id);
    return [...schedule.runs].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  async pause(id: string): Promise<StoredSchedule> {
    const schedule = await this.inspect(id);
    if (schedule.status === "completed") {
      throw new Error(`Schedule ${id} is already completed`);
    }
    if (schedule.status === "paused") {
      return schedule;
    }
    const now = this.now();
    const paused = {
      ...schedule,
      status: "paused" as const,
      nextRunAt: null,
      pausedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await this.store.put(paused);
    return paused;
  }

  async resume(id: string): Promise<StoredSchedule> {
    const schedule = await this.inspect(id);
    if (schedule.status === "completed") {
      throw new Error(`Schedule ${id} is already completed`);
    }
    if (schedule.status === "active") {
      return schedule;
    }
    const now = this.now();
    const resumed = {
      ...schedule,
      status: "active" as const,
      pausedAt: null,
      nextRunAt: computeNextRunAt(schedule.cadence, now).toISOString(),
      updatedAt: now.toISOString(),
    };
    await this.store.put(resumed);
    return resumed;
  }

  async update(input: UpdateScheduleInput): Promise<StoredSchedule> {
    const schedule = await this.inspect(input.id);
    const now = this.now();
    let updated: StoredSchedule = schedule;

    if (input.prompt !== undefined) {
      updated = { ...updated, prompt: normalizePrompt(input.prompt) };
    }

    if (input.name !== undefined) {
      updated = { ...updated, name: trimOptionalName(input.name) };
    }

    if (input.cadence !== undefined) {
      validateScheduleCadence(input.cadence);
      const nextRunAt =
        updated.status === "active" ? computeNextRunAt(input.cadence, now).toISOString() : null;
      updated = { ...updated, cadence: input.cadence, nextRunAt };
    }

    if (input.newAgentConfig !== undefined) {
      if (updated.target.type !== "new-agent") {
        throw new Error("new-agent config updates are only valid for new-agent target schedules");
      }
      updated = { ...updated, target: applyNewAgentConfig(updated.target, input.newAgentConfig) };
    }

    if (input.maxRuns !== undefined) {
      updated = { ...updated, maxRuns: normalizeMaxRuns(input.maxRuns) };
    }

    if (input.expiresAt !== undefined) {
      updated = { ...updated, expiresAt: input.expiresAt };
    }

    updated = { ...updated, updatedAt: now.toISOString() };
    await this.store.put(updated);
    return updated;
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(id);
  }

  async runOnce(id: string): Promise<StoredSchedule> {
    const schedule = await this.inspect(id);
    if (schedule.status === "completed") {
      throw new Error(`Schedule ${id} is already completed`);
    }
    if (this.runningScheduleIds.has(id)) {
      throw new Error(`Schedule ${id} is already running`);
    }
    await this.runSchedule(schedule, this.now(), { manual: true });
    return this.inspect(id);
  }

  async tick(): Promise<void> {
    const now = this.now();
    const schedules = await this.store.list();
    for (const schedule of schedules) {
      if (schedule.status !== "active" || !schedule.nextRunAt) {
        continue;
      }
      if (this.runningScheduleIds.has(schedule.id)) {
        continue;
      }
      if (shouldCompleteSchedule(schedule, now)) {
        await this.store.put(completeSchedule(schedule, now));
        continue;
      }
      if (new Date(schedule.nextRunAt).getTime() > now.getTime()) {
        continue;
      }
      await this.runSchedule(schedule, now);
    }
  }

  private async recoverInterruptedRuns(): Promise<void> {
    const schedules = await this.store.list();
    const now = this.now();
    await Promise.all(
      schedules.map(async (schedule) => {
        let updated = { ...schedule };
        let dirty = false;

        // Mark any in-flight runs as failed
        const runningIndex = updated.runs.findIndex((run) => run.status === "running");
        if (runningIndex !== -1) {
          const runs = [...updated.runs];
          runs[runningIndex] = {
            ...runs[runningIndex],
            status: "failed",
            endedAt: now.toISOString(),
            error: "Daemon restarted before the scheduled run completed",
          };
          updated = { ...updated, runs };
          dirty = true;
        }

        // Advance stale nextRunAt for active schedules
        if (
          updated.status === "active" &&
          updated.nextRunAt &&
          new Date(updated.nextRunAt).getTime() <= now.getTime()
        ) {
          let nextRunAt = computeNextRunAt(updated.cadence, new Date(updated.nextRunAt));
          while (nextRunAt.getTime() <= now.getTime()) {
            nextRunAt = computeNextRunAt(updated.cadence, nextRunAt);
          }
          updated = { ...updated, nextRunAt: nextRunAt.toISOString() };
          dirty = true;
        }

        if (dirty) {
          updated = { ...updated, updatedAt: now.toISOString() };
          await this.store.put(updated);
        }
      }),
    );
  }

  private async runSchedule(
    schedule: StoredSchedule,
    now: Date,
    options?: { manual?: boolean },
  ): Promise<void> {
    const manual = options?.manual === true;
    this.runningScheduleIds.add(schedule.id);
    const runId = randomUUID();
    const runningRun: ScheduleRun = {
      id: runId,
      scheduledFor: manual ? now.toISOString() : (schedule.nextRunAt ?? now.toISOString()),
      startedAt: now.toISOString(),
      endedAt: null,
      status: "running",
      agentId: null,
      output: null,
      error: null,
    };
    const scheduleWithRun = {
      ...schedule,
      updatedAt: now.toISOString(),
      runs: [...schedule.runs, runningRun],
    };
    await this.store.put(scheduleWithRun);

    try {
      // T-7 (synthesis carryover): restore the workspaceAuthStorage
      // context at fire time so the agent spawn finds the per-spawn
      // ~/.claude credential (cloud-credentials.ts:170-174 fail-loud
      // branch). On-host records have null cloudOwner* → runner runs
      // without an ALS context (identical to today's on-host behavior).
      // expiresAt: schedules outlive a JWT lifetime; set the value to
      // far-future so any downstream consumer of `expiresAt` treats
      // the context as still-valid. The schedule's authority comes
      // from the workspace's existence, not the original JWT's expiry.
      const result =
        scheduleWithRun.cloudOwnerWorkspaceId && scheduleWithRun.cloudOwnerAccountId
          ? await workspaceAuthStorage.run(
              {
                workspaceId: scheduleWithRun.cloudOwnerWorkspaceId,
                accountId: scheduleWithRun.cloudOwnerAccountId,
                expiresAt: Number.MAX_SAFE_INTEGER,
              },
              () => this.runner(scheduleWithRun, runId),
            )
          : await this.runner(scheduleWithRun, runId);
      await this.finishRun({
        scheduleId: schedule.id,
        runId,
        status: "succeeded",
        agentId: result.agentId,
        output: result.output,
        error: null,
        manual,
      });
    } catch (error) {
      await this.finishRun({
        scheduleId: schedule.id,
        runId,
        status: "failed",
        agentId: null,
        output: null,
        error: error instanceof Error ? error.message : String(error),
        manual,
      });
    } finally {
      this.runningScheduleIds.delete(schedule.id);
    }
  }

  private async finishRun(params: {
    scheduleId: string;
    runId: string;
    status: "succeeded" | "failed";
    agentId: string | null;
    output: string | null;
    error: string | null;
    manual: boolean;
  }): Promise<void> {
    const schedule = await this.inspect(params.scheduleId);
    const now = this.now();
    const completedRuns = schedule.runs.map((run) =>
      run.id === params.runId
        ? {
            ...run,
            status: params.status,
            endedAt: now.toISOString(),
            agentId: params.agentId,
            output: params.output,
            error: params.error,
          }
        : run,
    );
    let updated: StoredSchedule = {
      ...schedule,
      runs: completedRuns,
      lastRunAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    if (params.manual) {
      // Manual one-shot runs do not advance the cadence or recompute completion.
    } else if (shouldCompleteSchedule(updated, now)) {
      updated = completeSchedule(updated, now);
    } else if (updated.status === "paused") {
      updated = {
        ...updated,
        nextRunAt: null,
      };
    } else {
      const after = new Date(schedule.nextRunAt ?? now.toISOString());
      let nextRunAt = computeNextRunAt(updated.cadence, after);
      while (nextRunAt.getTime() <= now.getTime()) {
        nextRunAt = computeNextRunAt(updated.cadence, nextRunAt);
      }
      updated = {
        ...updated,
        nextRunAt: nextRunAt.toISOString(),
      };
    }

    await this.store.put(updated);
  }

  private async executeSchedule(
    schedule: StoredSchedule,
    runId: string,
  ): Promise<ScheduleExecutionResult> {
    // D-3.5d — spawn through the shared automation path so schedules and
    // webhook triggers reach `createAgent`/`runAgent` via one helper.
    const wrappedPrompt = formatSystemNotificationPrompt(buildScheduleFireBody(schedule, runId));
    return spawnFromAutomation({
      target: schedule.target,
      wrappedPrompt,
      labels: {
        "paseo.schedule-id": schedule.id,
        "paseo.schedule-run": runId,
      },
      deps: {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.logger,
      },
    });
  }
}
