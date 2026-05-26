import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import { resolveCloudStateTableName, type DynamoLike } from "../cloud-dynamo-client.js";
import { createCloudSharedKeys, type CloudSharedKeys } from "../cloud-shared-mirror.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineStore,
} from "./agent-timeline-store-types.js";

// T-6 (D-3) — durable AgentTimelineStore for cloud mode (cross-restart
// + cross-instance `agent_stream` catchup).
//
// Row layout (daemon-owned local key shape — cloud-shared does NOT
// yet ship this; the daemon-side mirror at
// `cloud-shared-mirror.ts:workspaceAgentTimeline` is the source of
// truth until cloud-shared adopts it):
//
//   pk = "<ws>#agent#timeline"
//   sk = "<agentId>#<epoch>#<zero-padded-seq>"
//
// The (epoch, seq) cursor is BINDING per agent-stream.md § "Resumption
// / reconnection". On `appendCommitted`, the daemon writes the row +
// returns the assigned seq. On `fetchCommitted`, we Query the partition
// with `begins_with(sk, "<agentId>#<epoch>#")` and slice by cursor.
//
// INTEGRATION-NOTE filed in STATUS-daemon.md: the cloud-shared
// `keys.ts` does not yet include `workspaceAgentTimeline`. Daemon-side
// definition stands until cloud-shared adopts; anti-drift CI will
// catch divergence post-D-3 once both sides ship.
//
// Throughput: writes are async-with-best-effort per PLAN-daemon T-6's
// acceptance ("If the DDB write fails, the in-memory append still
// succeeds, the wire push still fires, and the failure is logged at
// warn"). This implementation throws on failure — the agent-manager
// integration site (T-6 follow-up) wraps with try-catch so the in-
// memory append + wire push are unaffected.

export interface DynamoAgentTimelineStoreOptions {
  client: DynamoLike;
  workspaceId: string;
  logger: Logger;
  tableName?: string;
  keys?: CloudSharedKeys;
}

interface AgentEpochState {
  epoch: string;
  nextSeq: number;
}

export class DynamoAgentTimelineStore implements AgentTimelineStore {
  private readonly client: DynamoLike;
  private readonly workspaceId: string;
  private readonly tableName: string;
  private readonly keys: CloudSharedKeys;
  /**
   * Per-agent epoch + nextSeq cache. Populated lazily on the first
   * appendCommitted / fetchCommitted call. The cache avoids re-
   * querying DDB for the current epoch on every append.
   */
  private readonly epochs = new Map<string, AgentEpochState>();

  constructor(options: DynamoAgentTimelineStoreOptions) {
    this.client = options.client;
    this.workspaceId = options.workspaceId;
    this.tableName = options.tableName ?? resolveCloudStateTableName();
    this.keys = options.keys ?? createCloudSharedKeys();
    // logger reserved for future warn-and-continue paths when the
    // agent-manager integration site lands (T-6 follow-up).
    void options.logger;
  }

  private async ensureEpoch(agentId: string): Promise<AgentEpochState> {
    const cached = this.epochs.get(agentId);
    if (cached) return cached;
    // Cold-start: query the most recent row to recover the epoch +
    // nextSeq. DDB returns sort-key-ascending; we read the tail by
    // sorting descending + limit 1.
    const result = await this.client.query({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `${this.workspaceId}#agent#timeline`,
        ":prefix": `${agentId}#`,
      },
      ScanIndexForward: false,
      Limit: 1,
    });
    const last = result.Items?.[0];
    if (last) {
      const epoch = String(last.epoch);
      const seq = Number(last.seq);
      const state: AgentEpochState = { epoch, nextSeq: seq + 1 };
      this.epochs.set(agentId, state);
      return state;
    }
    // Fresh agent — generate a new epoch.
    const state: AgentEpochState = { epoch: randomUUID(), nextSeq: 1 };
    this.epochs.set(agentId, state);
    return state;
  }

  async appendCommitted(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string },
  ): Promise<AgentTimelineRow> {
    const state = await this.ensureEpoch(agentId);
    const seq = state.nextSeq;
    state.nextSeq += 1;
    const row: AgentTimelineRow = {
      seq,
      timestamp: options?.timestamp ?? new Date().toISOString(),
      item,
    };
    const key = this.keys.workspaceAgentTimeline(this.workspaceId, agentId, state.epoch, seq);
    await this.client.put({
      TableName: this.tableName,
      Item: {
        ...key,
        agentId,
        epoch: state.epoch,
        seq,
        timestamp: row.timestamp,
        item,
      },
    });
    return row;
  }

  private async queryEpochRows(agentId: string, epoch: string): Promise<AgentTimelineRow[]> {
    const result = await this.client.query({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `${this.workspaceId}#agent#timeline`,
        ":prefix": `${agentId}#${epoch}#`,
      },
    });
    const rows: AgentTimelineRow[] = (result.Items ?? []).map((item) => ({
      seq: Number(item.seq),
      timestamp: String(item.timestamp),
      item: item.item as AgentTimelineItem,
    }));
    rows.sort((a, b) => a.seq - b.seq);
    return rows;
  }

  async fetchCommitted(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    const state = await this.ensureEpoch(agentId);
    const direction = options?.direction ?? "tail";
    const cursor = options?.cursor;
    const limit = options?.limit;
    const staleCursor = cursor !== undefined && cursor.epoch !== state.epoch;
    const allRows = await this.queryEpochRows(agentId, state.epoch);
    const window =
      allRows.length === 0
        ? { minSeq: 0, maxSeq: 0, nextSeq: state.nextSeq }
        : {
            minSeq: allRows[0].seq,
            maxSeq: allRows[allRows.length - 1].seq,
            nextSeq: state.nextSeq,
          };
    const selected = this.applyCursorAndLimit(allRows, {
      direction,
      cursor: staleCursor ? undefined : cursor,
      limit,
    });
    return {
      epoch: state.epoch,
      direction,
      reset: false,
      staleCursor,
      gap: false,
      window,
      hasOlder: selected.length > 0 && selected[0].seq > window.minSeq,
      hasNewer: selected.length > 0 && selected[selected.length - 1].seq < window.maxSeq,
      rows: selected,
    };
  }

  private applyCursorAndLimit(
    rows: AgentTimelineRow[],
    opts: AgentTimelineFetchOptions,
  ): AgentTimelineRow[] {
    let out = rows;
    if (opts.cursor !== undefined && opts.direction === "after") {
      const cursorSeq = opts.cursor.seq;
      out = out.filter((r) => r.seq > cursorSeq);
    } else if (opts.cursor !== undefined && opts.direction === "before") {
      const cursorSeq = opts.cursor.seq;
      out = out.filter((r) => r.seq < cursorSeq);
    }
    if (typeof opts.limit === "number" && opts.limit > 0) {
      out = opts.direction === "tail" ? out.slice(-opts.limit) : out.slice(0, opts.limit);
    }
    return out;
  }

  async getLatestCommittedSeq(agentId: string): Promise<number> {
    const state = await this.ensureEpoch(agentId);
    return Math.max(0, state.nextSeq - 1);
  }

  async getCommittedRows(agentId: string): Promise<AgentTimelineRow[]> {
    const result = await this.fetchCommitted(agentId);
    return result.rows;
  }

  async getLastItem(agentId: string): Promise<AgentTimelineItem | null> {
    const rows = await this.getCommittedRows(agentId);
    return rows.length > 0 ? rows[rows.length - 1].item : null;
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    const rows = await this.getCommittedRows(agentId);
    for (let i = rows.length - 1; i >= 0; i--) {
      const item = rows[i].item as { type?: string; text?: string };
      if (item.type === "assistant_message" && typeof item.text === "string") {
        return item.text;
      }
    }
    return null;
  }

  async hasCommittedUserMessage(
    agentId: string,
    options: { messageId: string; text: string },
  ): Promise<boolean> {
    const rows = await this.getCommittedRows(agentId);
    return rows.some((row) => {
      const item = row.item as { type?: string; messageId?: string; text?: string };
      return (
        item.type === "user_message" &&
        item.messageId === options.messageId &&
        item.text === options.text
      );
    });
  }

  async deleteAgent(agentId: string): Promise<void> {
    const state = this.epochs.get(agentId);
    if (state) {
      const all = await this.client.query({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `${this.workspaceId}#agent#timeline`,
          ":prefix": `${agentId}#`,
        },
      });
      for (const row of all.Items ?? []) {
        await this.client.delete(this.tableName, {
          pk: String(row.pk),
          sk: String(row.sk),
        });
      }
      this.epochs.delete(agentId);
    }
  }

  async bulkInsert(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void> {
    const state = await this.ensureEpoch(agentId);
    for (const row of rows) {
      const key = this.keys.workspaceAgentTimeline(this.workspaceId, agentId, state.epoch, row.seq);
      await this.client.put({
        TableName: this.tableName,
        Item: {
          ...key,
          agentId,
          epoch: state.epoch,
          seq: row.seq,
          timestamp: row.timestamp,
          item: row.item,
        },
      });
      if (row.seq >= state.nextSeq) state.nextSeq = row.seq + 1;
    }
  }
}
