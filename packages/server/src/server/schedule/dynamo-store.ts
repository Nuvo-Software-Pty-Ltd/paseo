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
    //
    // D-3.10 follow-up 3 — transactional rollback on lifecycle-worker
    // notify failure: if `notifyRegister` rejects we MUST roll back
    // the DDB writes (meta + run rows just written) so the daemon
    // never leaves an orphaned schedule row without a backing
    // EventBridge rule. The original notify error is re-thrown so the
    // caller (ScheduleService.create / update / pause / resume / fire)
    // surfaces the failure. If the rollback DELETE itself fails, we
    // log loudly and re-throw the ORIGINAL notify error — we do NOT
    // retry-loop on rollback failure (best-effort cleanup).
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
    const writtenRunKeys: { pk: string; sk: string }[] = [];
    for (const run of runs) {
      await this.putRun(schedule.id, run);
      writtenRunKeys.push(this.keys.workspaceScheduleRun(this.workspaceId, schedule.id, run.id));
    }
    // Notify lifecycle worker so EventBridge picks up the new
    // cadence / nextRunAt (the worker dedupes by scheduleId).
    // Single notify per put — create() calls put(), so there's
    // exactly one notify per public mutation.
    try {
      await this.notifyRegister(schedule);
    } catch (err) {
      await this.rollbackPutOrLog(schedule.id, key, writtenRunKeys, err);
      throw err;
    }
  }

  /**
   * Best-effort rollback for `put()` when `notifyRegister` rejects.
   * Deletes the meta row + every run row written in the same `put()`
   * call. If a delete itself errors, log loudly and CONTINUE deleting
   * the rest — we do NOT loop forever; the operator gets a clear
   * "rollback partially failed" signal in the logs and the original
   * notify error is still re-thrown by the caller.
   */
  private async rollbackPutOrLog(
    scheduleId: string,
    metaKey: { pk: string; sk: string },
    runKeys: { pk: string; sk: string }[],
    originalError: unknown,
  ): Promise<void> {
    const deletes: Promise<void>[] = [
      this.client.delete(this.tableName, metaKey).catch((deleteErr) => {
        this.logger.error(
          { err: deleteErr, scheduleId, pk: metaKey.pk, sk: metaKey.sk },
          "D-3.10 follow-up 3: rollback DELETE of schedule meta row FAILED — orphan row may remain",
        );
      }),
    ];
    for (const runKey of runKeys) {
      deletes.push(
        this.client.delete(this.tableName, runKey).catch((deleteErr) => {
          this.logger.error(
            { err: deleteErr, scheduleId, pk: runKey.pk, sk: runKey.sk },
            "D-3.10 follow-up 3: rollback DELETE of schedule run row FAILED — orphan row may remain",
          );
        }),
      );
    }
    await Promise.all(deletes);
    this.logger.warn(
      { err: originalError, scheduleId },
      "D-3.10 follow-up 3: schedule put rolled back after notifyRegister failure",
    );
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
      // Skip case: lifecycle-worker integration not configured (dev
      // without `ORCHESTRA_LIFECYCLE_INTERNAL_URL`). Logged at debug;
      // no rollback triggered — the put() succeeds with no EventBridge
      // backing, which is the dev-environment behavior.
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
      // D-3.10 follow-up 3 — throw so `put()` rolls back the meta row
      // it just wrote. Previously this was warn-and-continue (matching
      // the D-2 T-4 heartbeat posture) but that left the DDB row
      // orphaned without an EventBridge rule; the operator chose
      // transactional semantics over no-op-on-transient-failure.
      throw new Error(
        `register-schedule notify failed (status=${result.status ?? "network"}, scheduleId=${
          schedule.id
        })`,
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
