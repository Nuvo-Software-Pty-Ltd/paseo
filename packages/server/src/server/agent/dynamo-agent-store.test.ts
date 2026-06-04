import { describe, expect, test } from "vitest";
import pino from "pino";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { InMemoryDynamoClient } from "../cloud-dynamo-client.js";
import { DynamoAgentStore } from "./dynamo-agent-store.js";
import type { StoredAgentRecord } from "./agent-storage.js";
import {
  SessionTranscriptStore,
  setSessionTranscriptStoreForTesting,
  type S3Like,
} from "./providers/claude/session-transcript-store.js";

const TABLE = "orchestra-dev-state";

function build(workspaceId = "ws_test") {
  const ddb = new InMemoryDynamoClient();
  const store = new DynamoAgentStore({
    client: ddb,
    workspaceId,
    logger: createTestLogger(),
    tableName: TABLE,
  });
  return { store, ddb };
}

function buildRecord(overrides: Partial<StoredAgentRecord> = {}): StoredAgentRecord {
  return {
    id: overrides.id ?? "agt_1",
    provider: overrides.provider ?? "claude",
    cwd: overrides.cwd ?? "/tmp/project",
    createdAt: overrides.createdAt ?? "2026-05-30T01:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-05-30T01:00:00.000Z",
    lastActivityAt: overrides.lastActivityAt ?? "2026-05-30T01:00:00.000Z",
    lastUserMessageAt: overrides.lastUserMessageAt ?? null,
    title: overrides.title ?? "first agent",
    labels: overrides.labels ?? {},
    lastStatus: overrides.lastStatus ?? "idle",
    lastModeId: overrides.lastModeId ?? null,
    config: overrides.config ?? {
      title: "first agent",
      modeId: "plan",
      model: "gpt-5.1",
    },
    runtimeInfo: overrides.runtimeInfo,
    features: overrides.features,
    persistence: overrides.persistence ?? null,
    lastError: overrides.lastError ?? null,
    requiresAttention: overrides.requiresAttention ?? false,
    attentionReason: overrides.attentionReason ?? null,
    attentionTimestamp: overrides.attentionTimestamp ?? null,
    internal: overrides.internal,
    archivedAt: overrides.archivedAt ?? null,
  };
}

describe("DynamoAgentStore (D-3.12)", () => {
  test("list returns empty when nothing is written", async () => {
    const { store } = build();
    const records = await store.list();
    expect(records).toEqual([]);
  });

  test("upsert → get round-trips a single agent record", async () => {
    const { store } = build();
    const original = buildRecord({ id: "agt_42", title: "hello" });
    await store.upsert(original);
    const fetched = await store.get("agt_42");
    expect(fetched).toMatchObject({ id: "agt_42", title: "hello", cwd: "/tmp/project" });
  });

  test("get returns null for an unknown agent id", async () => {
    const { store } = build();
    const fetched = await store.get("agt_does_not_exist");
    expect(fetched).toBeNull();
  });

  test("upsert → list returns every persisted agent in the workspace partition", async () => {
    const { store } = build();
    await store.upsert(buildRecord({ id: "agt_1", title: "a" }));
    await store.upsert(buildRecord({ id: "agt_2", title: "b" }));
    await store.upsert(buildRecord({ id: "agt_3", title: "c" }));
    const records = await store.list();
    expect(records.map((r) => r.id).sort()).toEqual(["agt_1", "agt_2", "agt_3"]);
  });

  test("upsert overwrites the previous row body (last write wins)", async () => {
    const { store } = build();
    await store.upsert(buildRecord({ id: "agt_1", title: "original" }));
    await store.upsert(buildRecord({ id: "agt_1", title: "updated" }));
    const fetched = await store.get("agt_1");
    expect(fetched?.title).toBe("updated");
    const records = await store.list();
    expect(records).toHaveLength(1);
  });

  test("DDB row layout uses cloud-shared `<ws>#agent#metadata` / `<agentId>` shape", async () => {
    const { store, ddb } = build("ws_layout");
    await store.upsert(buildRecord({ id: "agt_layout_check" }));
    const snapshot = ddb._snapshot();
    const rows = Array.from(snapshot.values());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pk: "ws_layout#agent#metadata",
      sk: "agt_layout_check",
      agentId: "agt_layout_check",
    });
    // The full record body lives under `record` — readers (including a
    // fresh DynamoAgentStore on a different instance) parse from it.
    expect(rows[0].record).toMatchObject({ id: "agt_layout_check" });
  });

  test("remove deletes the row; subsequent get returns null", async () => {
    const { store } = build();
    await store.upsert(buildRecord({ id: "agt_to_delete" }));
    await store.remove("agt_to_delete");
    const fetched = await store.get("agt_to_delete");
    expect(fetched).toBeNull();
    const records = await store.list();
    expect(records).toEqual([]);
  });

  test("remove also deletes persisted Claude transcripts from S3 in cloud mode (A6)", async () => {
    const originalCloudMode = process.env.PASEO_CLOUD_MODE;
    process.env.PASEO_CLOUD_MODE = "1";
    const listed: string[] = [];
    const deleted: string[][] = [];
    const fake: S3Like = {
      async putObject() {},
      async getObjectBytes() {
        throw Object.assign(new Error("nope"), { name: "NoSuchKey" });
      },
      async listObjectKeys(input) {
        listed.push(input.Prefix);
        return [`${input.Prefix}sess-1.jsonl`, `${input.Prefix}current.json`];
      },
      async deleteObjects(input) {
        deleted.push(input.Keys);
      },
    };
    setSessionTranscriptStoreForTesting(
      new SessionTranscriptStore({ client: fake, bucket: "b", logger: pino({ level: "silent" }) }),
    );
    try {
      const { store } = build("ws_xyz");
      await store.upsert(buildRecord({ id: "agt_hard_delete" }));
      await store.remove("agt_hard_delete");
      expect(listed).toEqual(["ws_xyz/claude-sessions/agt_hard_delete/"]);
      expect(deleted).toEqual([
        [
          "ws_xyz/claude-sessions/agt_hard_delete/sess-1.jsonl",
          "ws_xyz/claude-sessions/agt_hard_delete/current.json",
        ],
      ]);
    } finally {
      setSessionTranscriptStoreForTesting(null);
      if (originalCloudMode === undefined) delete process.env.PASEO_CLOUD_MODE;
      else process.env.PASEO_CLOUD_MODE = originalCloudMode;
    }
  });

  test("beginDelete + concurrent upsert: upsert is suppressed (matches AgentStorage semantics)", async () => {
    const { store } = build();
    store.beginDelete("agt_being_deleted");
    await store.upsert(buildRecord({ id: "agt_being_deleted", title: "should not land" }));
    const fetched = await store.get("agt_being_deleted");
    // The upsert was suppressed by the deleting sentinel so DDB has
    // no row.
    expect(fetched).toBeNull();
  });

  test("setTitle round-trips through upsert", async () => {
    const { store } = build();
    await store.upsert(buildRecord({ id: "agt_t", title: "original" }));
    await store.setTitle("agt_t", "renamed");
    const fetched = await store.get("agt_t");
    expect(fetched?.title).toBe("renamed");
  });

  test("setTitle throws when the agent does not exist", async () => {
    const { store } = build();
    await expect(store.setTitle("agt_missing", "x")).rejects.toThrow(/agt_missing/);
  });

  test("cross-restart durability: a fresh store sees rows from a prior instance", async () => {
    const ddb = new InMemoryDynamoClient();
    const store1 = new DynamoAgentStore({
      client: ddb,
      workspaceId: "ws_restart",
      logger: createTestLogger(),
      tableName: TABLE,
    });
    await store1.upsert(buildRecord({ id: "agt_persistent", title: "survives" }));
    const store2 = new DynamoAgentStore({
      client: ddb,
      workspaceId: "ws_restart",
      logger: createTestLogger(),
      tableName: TABLE,
    });
    const fetched = await store2.get("agt_persistent");
    expect(fetched?.title).toBe("survives");
  });

  test("F3 design-out: workspaceId is captured at construction; cross-tenant reads return nothing", async () => {
    const ddb = new InMemoryDynamoClient();
    const storeA = new DynamoAgentStore({
      client: ddb,
      workspaceId: "ws_A",
      logger: createTestLogger(),
      tableName: TABLE,
    });
    const storeB = new DynamoAgentStore({
      client: ddb,
      workspaceId: "ws_B",
      logger: createTestLogger(),
      tableName: TABLE,
    });
    await storeA.upsert(buildRecord({ id: "agt_shared_id" }));
    const seenFromB = await storeB.get("agt_shared_id");
    expect(seenFromB).toBeNull();
    const listFromB = await storeB.list();
    expect(listFromB).toEqual([]);
  });

  test("partition pk is distinct from agent#timeline (no collision with D-3.10 surface)", async () => {
    const { store, ddb } = build("ws_xx");
    await store.upsert(buildRecord({ id: "agt_collision_check" }));
    const rows = Array.from(ddb._snapshot().values());
    // A timeline row would have pk = "ws_xx#agent#timeline". The metadata
    // row uses a distinct prefix so a Query of the timeline partition
    // never returns metadata rows and vice versa.
    for (const row of rows) {
      expect(row.pk).toBe("ws_xx#agent#metadata");
      expect(row.pk).not.toBe("ws_xx#agent#timeline");
    }
  });

  test("initialize is a no-op (no eager load)", async () => {
    const { store } = build();
    await expect(store.initialize()).resolves.toBeUndefined();
  });

  test("flush is a no-op (DDB writes are synchronous)", async () => {
    const { store } = build();
    await store.upsert(buildRecord({ id: "agt_flush" }));
    await expect(store.flush()).resolves.toBeUndefined();
  });

  test("list skips rows that fail schema parse (warn-and-continue)", async () => {
    const { store, ddb } = build("ws_corrupt");
    await store.upsert(buildRecord({ id: "agt_good" }));
    // Inject a garbage row directly into the partition (simulating
    // a forward-incompatible row written by a newer daemon).
    await ddb.put({
      TableName: TABLE,
      Item: {
        pk: "ws_corrupt#agent#metadata",
        sk: "agt_garbage",
        agentId: "agt_garbage",
        record: { not: "a valid stored agent record" },
      },
    });
    const records = await store.list();
    expect(records.map((r) => r.id)).toEqual(["agt_good"]);
  });
});
