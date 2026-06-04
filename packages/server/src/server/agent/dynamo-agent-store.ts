import type { Logger } from "pino";

import { resolveDaemonDataTableName, type DynamoLike } from "../cloud-dynamo-client.js";
import { createCloudSharedKeys, type CloudSharedKeys } from "../cloud-shared-mirror.js";
import { isPaseoCloudMode } from "../paseo-env.js";
import { getSessionTranscriptStore } from "./providers/claude/session-transcript-store.js";
import {
  parseStoredAgentRecord,
  type AgentStore,
  type StoredAgentRecord,
} from "./agent-storage.js";
import type { ManagedAgent } from "./agent-manager.js";
import { toStoredAgentRecord } from "./agent-projections.js";

// D-3.12 (UAT follow-ups #3 + #4) — DynamoDB-backed AgentStore for cloud
// mode. Replaces the file-backed `AgentStorage` whose `$PASEO_HOME/
// agents/<cwd-with-dashes>/<id>.json` files are wiped on every ECS task
// replacement, dropping the agent list each time the container churns.
//
// Row layout (cloud-shared keys.ts:workspaceAgentMetadata, mirrored in
// `cloud-shared-mirror.ts:CloudSharedKeys.workspaceAgentMetadata`):
//   pk = "<ws>#agent#metadata"
//   sk = "<agentId>"
// One row per agent. The full `StoredAgentRecord` body lives in the
// row's `record` attribute. The pk is intentionally distinct from the
// D-3.10 `<ws>#agent#timeline` partition so the timeline stream and
// the agent record snapshot never collide on read.
//
// Reads/writes go through `keys.workspaceAgentMetadata` (F12 — no inline
// pk/sk strings in this file). The cloud-shared-mirror's anti-drift CI
// keeps the key shape byte-equivalent with cloud-shared/src/keys.ts so
// any future external reader (lifecycle worker, support tooling) talks
// to the same partition layout the daemon writes.
//
// IAM (D-3.11 / D-3.12 — workspace-role-template.ts WorkspaceDynamoDb
// LeadingKeys): the per-workspace daemon role has
//   `<workspaceId>#agent#metadata` + `<workspaceId>#agent#metadata#*`
// allowed in its inline policy. Existing workspaces pick up the new
// grant via the D-3.11 backfill script; new workspaces get it at
// workspace-create from the updated cloud-shared template.
//
// Semantics differences from AgentStorage worth flagging:
//   - `applySnapshot` reads + writes one record. The file-backed impl
//     had to dance around per-cwd path migrations + pendingWrites; DDB
//     has none of that since pk doesn't encode cwd.
//   - `remove` is a single DeleteItem (no path migration to undo).
//   - `beginDelete` mirrors the file-backed impl's behaviour: a deleting
//     agent gets a sentinel so concurrent `upsert` calls drop on the
//     floor. Required because Session sometimes pipelines upsert →
//     remove and we don't want the upsert to re-create the row after
//     the remove.
//   - `flush` is a no-op — DDB writes are synchronous, not buffered.
//   - `initialize` is a no-op — there is no eager load (the cache is
//     lazy, and DDB is the source of truth). `list()` runs a Query on
//     every call; future optimization can add a cache if hot.
//
// Throughput note: an agent snapshot is currently written on every
// `agent_state` event via `persistence-hooks.ts`. In a high-event
// workspace this can produce 10s of PutItems/sec/agent. Each PutItem
// is ~1KB so per-tenant cost stays bounded, but if observed write
// rates exceed expectations a future follow-up can debounce inside
// the hook (NOT inside this store — the store is purely a key/value
// surface).

export interface DynamoAgentStoreOptions {
  client: DynamoLike;
  workspaceId: string;
  logger: Logger;
  tableName?: string;
  keys?: CloudSharedKeys;
}

export class DynamoAgentStore implements AgentStore {
  private readonly client: DynamoLike;
  private readonly workspaceId: string;
  private readonly tableName: string;
  private readonly keys: CloudSharedKeys;
  private readonly logger: Logger;
  // beginDelete sentinel — concurrent upsert/remove serialization.
  private readonly deleting = new Set<string>();

  constructor(options: DynamoAgentStoreOptions) {
    this.client = options.client;
    this.workspaceId = options.workspaceId;
    this.tableName = options.tableName ?? resolveDaemonDataTableName();
    this.keys = options.keys ?? createCloudSharedKeys();
    this.logger = options.logger.child({ component: "dynamo-agent-store" });
  }

  async initialize(): Promise<void> {
    // No-op. The store is lazy; `list()` runs a Query on demand.
  }

  async list(): Promise<StoredAgentRecord[]> {
    const result = await this.client.query({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": `${this.workspaceId}#agent#metadata` },
    });
    const records: StoredAgentRecord[] = [];
    for (const item of result.Items ?? []) {
      const parsed = this.tryParseRow(item);
      if (parsed) records.push(parsed);
    }
    return records;
  }

  async get(agentId: string): Promise<StoredAgentRecord | null> {
    const key = this.keys.workspaceAgentMetadata(this.workspaceId, agentId);
    const result = await this.client.get(this.tableName, key);
    if (!result.Item) return null;
    return this.tryParseRow(result.Item);
  }

  async upsert(record: StoredAgentRecord): Promise<void> {
    if (this.deleting.has(record.id)) {
      // Mirror the file-backed semantics: a concurrent remove sentinel
      // suppresses re-creation by a pipelined upsert.
      return;
    }
    const key = this.keys.workspaceAgentMetadata(this.workspaceId, record.id);
    try {
      await this.client.put({
        TableName: this.tableName,
        Item: {
          ...key,
          agentId: record.id,
          record,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
      });
    } catch (err) {
      this.logger.warn(
        { err, agentId: record.id, workspaceId: this.workspaceId },
        "DynamoAgentStore: upsert failed",
      );
      throw err;
    }
  }

  beginDelete(agentId: string): void {
    this.deleting.add(agentId);
  }

  async remove(agentId: string): Promise<void> {
    this.deleting.add(agentId);
    const key = this.keys.workspaceAgentMetadata(this.workspaceId, agentId);
    try {
      await this.client.delete(this.tableName, key);
    } catch (err) {
      this.logger.warn(
        { err, agentId, workspaceId: this.workspaceId },
        "DynamoAgentStore: remove failed",
      );
      throw err;
    }
    // A6: hard delete reclaims the agent's persisted Claude transcripts from S3.
    // Archive (archivedAt) never reaches `remove`, so archived sessions are
    // retained. Cloud-mode only; kill switch + warn-and-continue keep this off
    // the critical path.
    if (isPaseoCloudMode() && process.env.PASEO_PERSIST_CLAUDE_SESSIONS !== "0") {
      await getSessionTranscriptStore(this.logger).deleteAgent({
        workspaceId: this.workspaceId,
        agentId,
      });
    }
  }

  async applySnapshot(
    agent: ManagedAgent,
    workspaceIdOrOptions?: string | { title?: string | null; internal?: boolean },
    options?: { title?: string | null; internal?: boolean },
  ): Promise<void> {
    // Match AgentStorage.applySnapshot's overload (the workspaceId
    // positional arg is from a pre-D-3 legacy caller that's gone but
    // the signature stays for back-compat with Session callers).
    const nextOptions = typeof workspaceIdOrOptions === "string" ? options : workspaceIdOrOptions;
    const existing = await this.get(agent.id);
    const hasTitleOverride =
      nextOptions !== undefined && Object.prototype.hasOwnProperty.call(nextOptions, "title");
    const hasInternalOverride =
      nextOptions !== undefined && Object.prototype.hasOwnProperty.call(nextOptions, "internal");
    const record = toStoredAgentRecord(agent, {
      title: hasTitleOverride ? (nextOptions?.title ?? null) : (existing?.title ?? null),
      createdAt: existing?.createdAt,
      internal: hasInternalOverride
        ? nextOptions?.internal
        : (agent.internal ?? existing?.internal),
    });
    if (existing && existing.archivedAt !== undefined) {
      record.archivedAt = existing.archivedAt;
    }
    await this.upsert(record);
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    const record = await this.get(agentId);
    if (!record) {
      throw new Error(`Agent ${agentId} not found`);
    }
    await this.upsert({ ...record, title });
  }

  async flush(): Promise<void> {
    // No-op. DDB PutItem is synchronous — there's no buffer to drain.
  }

  private tryParseRow(item: Record<string, unknown>): StoredAgentRecord | null {
    try {
      return parseStoredAgentRecord(item.record);
    } catch (err) {
      this.logger.warn(
        { err, workspaceId: this.workspaceId, sk: item.sk },
        "DynamoAgentStore: row failed schema parse — skipping",
      );
      return null;
    }
  }
}
