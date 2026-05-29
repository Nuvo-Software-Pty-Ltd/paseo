import { randomBytes } from "node:crypto";
import type { Logger } from "pino";

import { cloudHmacFetch } from "../cloud-hmac-fetch.js";
import { resolveDaemonDataTableName, type DynamoLike } from "../cloud-dynamo-client.js";
import { createCloudSharedKeys, type CloudSharedKeys } from "../cloud-shared-mirror.js";
import { StoredScheduleSchema, type StoredSchedule, type ScheduleRun } from "./types.js";
import type { ScheduleStore } from "./store.js";

// T-2 (D-3, synthesis C1) — DynamoDB-backed ScheduleStore for cloud mode.
//
// Row layout (from cloud-shared keys.ts:179-185):
//   - Schedule meta: pk = "<ws>#schedule", sk = "<scheduleId>#meta"
//   - Schedule run: pk = "<ws>#schedule", sk = "<scheduleId>#run#<runId>"
//
// Run rows are written as the schedule fires; `list` / `get` queries
// the partition and joins client-side. The on-disk `StoredSchedule`
// shape (runs[] inline) is reconstructed by sorting run rows by
// startedAt and stuffing them into the meta record.
//
// EventBridge Scheduler register/deregister (synthesis C1):
// `create` + `put` (when nextRunAt changes) HMAC-POST the lifecycle
// worker at `/api/lifecycle-internal/register-schedule`. `delete` POSTs
// `/api/lifecycle-internal/deregister-schedule`. F9: this DynamoStore is
// the single writer of the notify side-effect; ScheduleService doesn't
// call EventBridge directly. Warn-and-continue on failure — Day-1
// posture matches D-2 T-4 heartbeat.
//
// Sub-minute cadence rejection (synthesis OQ1): cloud-mode rejects
// `every` cadences where `everyMs < 60_000` BEFORE any DDB write,
// because EventBridge Scheduler's `rate(...)` minimum is 1 minute.
// The rejection lands at the daemon edge so the WS client gets the
// rpc_error before the auth/worker hop. (Lifecycle-worker mirrors the
// same gate as a backstop per its register-schedule.ts validator.)

const SUB_MINUTE_THRESHOLD_MS = 60_000;
const SUB_MINUTE_ERROR_MESSAGE =
  "Cloud-mode schedules require every >= 60s (EventBridge Scheduler minimum).";

function generateScheduleId(): string {
  return randomBytes(4).toString("hex");
}

export interface DynamoScheduleStoreOptions {
  client: DynamoLike;
  workspaceId: string;
  logger: Logger;
  tableName?: string;
  keys?: CloudSharedKeys;
  /**
   * Lifecycle-worker base URL — sourced from
   * `process.env.ORCHESTRA_LIFECYCLE_INTERNAL_URL`. If absent, the
   * register/deregister notify is a warn-and-skip (env not yet
   * shipped by cdk-infra at the time of writing; tracked as
   * INTEGRATION-NOTE in STATUS-daemon.md).
   */
  lifecycleInternalUrl?: string;
  hmacKey?: string;
  fetchImpl?: typeof fetch;
}

export class DynamoScheduleStore implements ScheduleStore {
  private readonly client: DynamoLike;
  private readonly workspaceId: string;
  private readonly tableName: string;
  private readonly keys: CloudSharedKeys;
  private readonly logger: Logger;
  private readonly lifecycleInternalUrl?: string;
  private readonly hmacKey?: string;
  private readonly fetchImpl?: typeof fetch;

  constructor(options: DynamoScheduleStoreOptions) {
    this.client = options.client;
    this.workspaceId = options.workspaceId;
    this.tableName = options.tableName ?? resolveDaemonDataTableName();
    this.keys = options.keys ?? createCloudSharedKeys();
    this.logger = options.logger.child({ component: "dynamo-schedule-store" });
    if (options.lifecycleInternalUrl) this.lifecycleInternalUrl = options.lifecycleInternalUrl;
    if (options.hmacKey) this.hmacKey = options.hmacKey;
    if (options.fetchImpl) this.fetchImpl = options.fetchImpl;
  }

  async list(): Promise<StoredSchedule[]> {
    const result = await this.client.query({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": `${this.workspaceId}#schedule` },
    });
    const items = result.Items ?? [];
    const schedulesById = new Map<string, StoredSchedule>();
    const runsById = new Map<string, ScheduleRun[]>();
    for (const item of items) {
      const sk = String(item.sk);
      if (sk.endsWith("#meta")) {
        const parsed = StoredScheduleSchema.parse(item.record);
        schedulesById.set(parsed.id, parsed);
      } else if (sk.includes("#run#")) {
        const scheduleId = sk.split("#run#")[0];
        const run = item.record as ScheduleRun;
        const existing = runsById.get(scheduleId) ?? [];
        existing.push(run);
        runsById.set(scheduleId, existing);
      }
    }
    const all: StoredSchedule[] = [];
    for (const [id, schedule] of schedulesById) {
      const runs = (runsById.get(id) ?? []).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      all.push({ ...schedule, runs });
    }
    return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(id: string): Promise<StoredSchedule | null> {
    const metaRes = await this.client.get(
      this.tableName,
      this.keys.workspaceSchedule(this.workspaceId, id),
    );
    if (!metaRes.Item) return null;
    const parsed = StoredScheduleSchema.parse(metaRes.Item.record);
    const runsRes = await this.client.query({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `${this.workspaceId}#schedule`,
        ":prefix": `${id}#run#`,
      },
    });
    const runs = (runsRes.Items ?? [])
      .map((row) => row.record as ScheduleRun)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return { ...parsed, runs };
  }

  async create(schedule: Omit<StoredSchedule, "id">): Promise<StoredSchedule> {
    // Synthesis OQ1: cloud-mode rejects sub-minute cadences at the
    // daemon edge. Lifecycle-worker is a backstop; this avoids the
    // round-trip when we know the answer.
    if (schedule.cadence.type === "every" && schedule.cadence.everyMs < SUB_MINUTE_THRESHOLD_MS) {
      throw new Error(SUB_MINUTE_ERROR_MESSAGE);
    }
    const created = StoredScheduleSchema.parse({
      ...schedule,
      id: generateScheduleId(),
    });
    await this.put(created);
    return created;
  }

  async put(schedule: StoredSchedule): Promise<void> {
    // Persist the schedule meta row. Runs are written separately by
    // `putRun` (called from ScheduleService internals when the on-
    // host code path appends to runs[]). Both row types share the
    // `<ws>#schedule` partition.
    //
    // The meta record stores the full schedule shape minus runs[] so
    // `loadAll` can reconstruct via Zod parse (the on-disk format is
    // augmented with runs: [] on read, then joined from per-run rows).
    const key = this.keys.workspaceSchedule(this.workspaceId, schedule.id);
    const { runs, ...rest } = schedule;
    const recordWithRuns = { ...rest, runs: [] as ScheduleRun[] };
    await this.client.put({
      TableName: this.tableName,
      Item: {
        ...key,
        scheduleId: schedule.id,
        record: recordWithRuns,
        createdAt: schedule.createdAt,
        updatedAt: schedule.updatedAt,
      },
    });
    // The on-host ScheduleStore stores runs[] inline; the cloud layout
    // shards each run as its own row. Compose by writing every run via
    // putRun. This re-writes existing rows idempotently.
    for (const run of runs) {
      await this.putRun(schedule.id, run);
    }
    // Notify lifecycle worker so EventBridge picks up the new
    // cadence / nextRunAt (the worker dedupes by scheduleId).
    // Single notify per put — create() calls put(), so there's
    // exactly one notify per public mutation.
    await this.notifyRegister(schedule);
  }

  async delete(id: string): Promise<void> {
    // Delete the meta row + every run row for this schedule. The
    // query reuses the partition; rows are deleted one-by-one.
    const runsRes = await this.client.query({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `${this.workspaceId}#schedule`,
        ":prefix": `${id}#`,
      },
    });
    for (const row of runsRes.Items ?? []) {
      await this.client.delete(this.tableName, {
        pk: String(row.pk),
        sk: String(row.sk),
      });
    }
    await this.notifyDeregister(id);
  }

  /**
   * Append (or update) a run row. Called from ScheduleService when
   * the on-host code path emits a new ScheduleRun.
   */
  async putRun(scheduleId: string, run: ScheduleRun): Promise<void> {
    const key = this.keys.workspaceScheduleRun(this.workspaceId, scheduleId, run.id);
    await this.client.put({
      TableName: this.tableName,
      Item: {
        ...key,
        scheduleId,
        runId: run.id,
        record: run,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        status: run.status,
      },
    });
  }

  private async notifyRegister(schedule: StoredSchedule): Promise<void> {
    if (!this.lifecycleInternalUrl || !this.hmacKey) {
      this.logger.debug(
        { scheduleId: schedule.id },
        "register-schedule notify skipped (no ORCHESTRA_LIFECYCLE_INTERNAL_URL / HMAC key)",
      );
      return;
    }
    const body = JSON.stringify({
      workspaceId: this.workspaceId,
      scheduleId: schedule.id,
      cadence: schedule.cadence,
      ...(schedule.expiresAt ? { expiresAt: schedule.expiresAt } : {}),
    });
    const result = await cloudHmacFetch({
      url: `${this.lifecycleInternalUrl.replace(/\/$/, "")}/api/lifecycle-internal/register-schedule`,
      hmacKey: this.hmacKey,
      body,
      logger: this.logger,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
      logContext: { scheduleId: schedule.id, workspaceId: this.workspaceId },
      failureLogLabel: "register-schedule",
    });
    if (!result.ok) {
      // Warn-and-continue posture per D-2 T-4 heartbeat: a transient
      // lifecycle-worker outage must not block schedule creation.
      this.logger.warn(
        { scheduleId: schedule.id, status: result.status },
        "register-schedule notify non-2xx",
      );
    }
  }

  private async notifyDeregister(scheduleId: string): Promise<void> {
    if (!this.lifecycleInternalUrl || !this.hmacKey) {
      this.logger.debug(
        { scheduleId },
        "deregister-schedule notify skipped (no ORCHESTRA_LIFECYCLE_INTERNAL_URL / HMAC key)",
      );
      return;
    }
    const body = JSON.stringify({
      workspaceId: this.workspaceId,
      scheduleId,
    });
    const result = await cloudHmacFetch({
      url: `${this.lifecycleInternalUrl.replace(/\/$/, "")}/api/lifecycle-internal/deregister-schedule`,
      hmacKey: this.hmacKey,
      body,
      logger: this.logger,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
      logContext: { scheduleId, workspaceId: this.workspaceId },
      failureLogLabel: "deregister-schedule",
    });
    if (!result.ok) {
      this.logger.warn({ scheduleId, status: result.status }, "deregister-schedule notify non-2xx");
    }
  }
}
