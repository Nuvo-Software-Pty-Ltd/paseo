import type { Logger } from "pino";

import { resolveDaemonDataTableName, type DynamoLike } from "./cloud-dynamo-client.js";
import { createCloudSharedKeys, type CloudSharedKeys } from "./cloud-shared-mirror.js";
import { LoopRecordSchema, type LoopRecord } from "./loop-types.js";
import type { LoopStore } from "./loop-store.js";

// T-3 (D-3) — DynamoDB-backed LoopStore for cloud mode.
//
// Row layout (from cloud-shared keys.ts:187-194):
//   - Loop meta: pk = "<ws>#loop", sk = "<loopId>#meta"
//   - Loop step: pk = "<ws>#loop", sk = "<loopId>#step#<zero-padded-seq>"
//
// The cloud-shared schema (schemas.ts:225-234) collapses the on-host
// `LoopIterationRecord` + `LoopLogEntry` arrays into one `LoopStepRow`
// type per (iteration, seq). The on-host `LoopRecord` shape (with
// `iterations[]` and `logs[]` inline) is reconstructed at load by
// reading every step row and partitioning by `source`. Round-19
// `maxTimeMs` / `maxIterations` cap text remains in `logs[].text`
// — there is NO top-level `failureReason` in either the on-disk or
// the DDB shape.
//
// Daemon-restart auto-stop (loop.md:332-343) is preserved by the
// LoopService consumer side at boot — see T-5 rehydration. The store
// itself just reads what's there; the auto-stop transition is applied
// by the LoopService when it owns the in-memory map post-loadAll.
//
// S3 offload deferred to PARTIAL — the cloud-shared key shape sticks
// each step in DDB, which gives us ~1KB per row × the loop's step
// count. A long-lived loop (~1000+ steps) can still write all-DDB;
// the S3 offload threshold lives in PLAN-cdk-infra and lands when
// the bucket + IAM grant deploys.

export interface DynamoLoopStoreOptions {
  client: DynamoLike;
  workspaceId: string;
  logger: Logger;
  tableName?: string;
  keys?: CloudSharedKeys;
}

export class DynamoLoopStore implements LoopStore {
  private readonly client: DynamoLike;
  private readonly workspaceId: string;
  private readonly tableName: string;
  private readonly keys: CloudSharedKeys;
  private readonly logger: Logger;

  constructor(options: DynamoLoopStoreOptions) {
    this.client = options.client;
    this.workspaceId = options.workspaceId;
    this.tableName = options.tableName ?? resolveDaemonDataTableName();
    this.keys = options.keys ?? createCloudSharedKeys();
    this.logger = options.logger.child({ component: "dynamo-loop-store" });
  }

  async loadAll(): Promise<LoopRecord[]> {
    // Single Query on the `<ws>#loop` partition returns every meta +
    // step row across every loop. Partition is per-workspace so the
    // result set is bounded by the workspace's loop history.
    const result = await this.client.query({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": `${this.workspaceId}#loop` },
    });
    const loopsById = new Map<string, LoopRecord>();
    for (const item of result.Items ?? []) {
      const sk = String(item.sk);
      if (sk.endsWith("#meta")) {
        try {
          const parsed = LoopRecordSchema.parse(item.record);
          loopsById.set(parsed.id, parsed);
        } catch (err) {
          this.logger.warn(
            { err, sk, workspaceId: this.workspaceId },
            "DynamoLoopStore: meta record failed schema parse — skipping",
          );
        }
      }
      // Step rows are read but the LoopRecord's iterations + logs
      // arrays already live inside the meta record (we serialize the
      // whole on-host LoopRecord into `record` on each save). The
      // per-step rows exist as the cloud-shared canonical shape — a
      // future LoopService refactor will consume them directly. For
      // Day-1 the meta record is the source of truth on read.
    }
    return Array.from(loopsById.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async save(records: LoopRecord[]): Promise<void> {
    // Per-loop PutItem on the meta row. The full on-host LoopRecord
    // (with iterations[] + logs[] inline) goes into `record`. This
    // matches the on-disk shape so a future toggle on
    // `isPaseoCloudMode()` between FileBackedLoopStore and
    // DynamoLoopStore round-trips byte-identical via Zod parse.
    //
    // Step rows: we ALSO write each log entry as a per-step row so
    // the cloud-shared canonical shape stays populated for the
    // lifecycle worker / future readers. The shape uses the
    // padded-seq sort key from `keys.workspaceLoopStep`.
    for (const record of records) {
      const metaKey = this.keys.workspaceLoop(this.workspaceId, record.id);
      try {
        await this.client.put({
          TableName: this.tableName,
          Item: {
            ...metaKey,
            loopId: record.id,
            record,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          },
        });
      } catch (err) {
        this.logger.warn(
          { err, loopId: record.id, workspaceId: this.workspaceId },
          "DynamoLoopStore: put meta failed",
        );
        throw err;
      }
      // Step rows mirror the log entries.
      for (const entry of record.logs) {
        const stepKey = this.keys.workspaceLoopStep(this.workspaceId, record.id, entry.seq);
        try {
          await this.client.put({
            TableName: this.tableName,
            Item: {
              ...stepKey,
              loopId: record.id,
              iteration: entry.iteration ?? -1,
              seq: entry.seq,
              source: entry.source,
              level: entry.level,
              text: entry.text,
              ts: entry.timestamp,
            },
          });
        } catch (err) {
          // Step-row writes are best-effort — the meta row is the
          // canonical source for loadAll. Warn and continue.
          this.logger.warn(
            {
              err,
              loopId: record.id,
              seq: entry.seq,
            },
            "DynamoLoopStore: put step row failed (continuing — meta row is canonical)",
          );
        }
      }
    }
  }
}
