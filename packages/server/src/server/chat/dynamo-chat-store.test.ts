import pino from "pino";
import { describe, expect, test } from "vitest";

import { InMemoryDynamoClient } from "../cloud-dynamo-client.js";
import { DynamoChatStore } from "./dynamo-chat-store.js";

const logger = pino({ level: "silent" });

const WS = "ws_test";
const TABLE = "orchestra-dev-state";

function build(): { store: DynamoChatStore; ddb: InMemoryDynamoClient } {
  const ddb = new InMemoryDynamoClient();
  const store = new DynamoChatStore({
    client: ddb,
    workspaceId: WS,
    logger,
    tableName: TABLE,
  });
  return { store, ddb };
}

describe("DynamoChatStore (T-1)", () => {
  test("loadAll returns empty payload when nothing is written", async () => {
    const { store } = build();
    const payload = await store.loadAll();
    expect(payload).toEqual({ rooms: [], messages: [] });
  });

  test("save → loadAll round-trips rooms and messages", async () => {
    const { store } = build();
    await store.save({
      rooms: [
        {
          id: "room-1",
          name: "general",
          purpose: null,
          createdAt: "2026-05-26T01:00:00.000Z",
          updatedAt: "2026-05-26T01:00:00.000Z",
        },
      ],
      messages: [
        {
          id: "msg-1",
          roomId: "room-1",
          authorAgentId: "agent-1",
          body: "hello",
          replyToMessageId: null,
          mentionAgentIds: [],
          createdAt: "2026-05-26T01:01:00.000Z",
        },
        {
          id: "msg-2",
          roomId: "room-1",
          authorAgentId: "agent-2",
          body: "@agent-1 ack",
          replyToMessageId: "msg-1",
          mentionAgentIds: ["agent-1"],
          createdAt: "2026-05-26T01:02:00.000Z",
        },
      ],
    });
    const payload = await store.loadAll();
    expect(payload.rooms).toHaveLength(1);
    expect(payload.rooms[0]).toMatchObject({
      id: "room-1",
      name: "general",
      purpose: null,
    });
    expect(payload.messages).toHaveLength(2);
    const msg2 = payload.messages.find((m) => m.id === "msg-2");
    expect(msg2?.mentionAgentIds).toEqual(["agent-1"]);
    expect(msg2?.replyToMessageId).toBe("msg-1");
  });

  test("DDB row layout uses the cloud-shared partition + sort-key shapes", async () => {
    const { store, ddb } = build();
    await store.save({
      rooms: [
        {
          id: "room-a",
          name: "n",
          purpose: "p",
          createdAt: "2026-05-26T01:00:00.000Z",
          updatedAt: "2026-05-26T01:00:00.000Z",
        },
      ],
      messages: [
        {
          id: "msg-x",
          roomId: "room-a",
          authorAgentId: "agent-1",
          body: "x",
          replyToMessageId: null,
          mentionAgentIds: [],
          createdAt: "2026-05-26T01:01:00.000Z",
        },
      ],
    });
    const snapshot = ddb._snapshot();
    const rows = Array.from(snapshot.values());
    const roomRow = rows.find((r) => String(r.sk).endsWith("#meta"));
    const msgRow = rows.find((r) => String(r.sk).includes("#msg#"));
    expect(roomRow?.pk).toBe("ws_test#chat");
    expect(roomRow?.sk).toBe("room-a#meta");
    expect(msgRow?.pk).toBe("ws_test#chat");
    expect(msgRow?.sk).toBe("room-a#msg#msg-x");
  });

  test("cross-restart parity: a fresh store sees rows written by a prior instance", async () => {
    const ddb = new InMemoryDynamoClient();
    const store1 = new DynamoChatStore({ client: ddb, workspaceId: WS, logger });
    await store1.save({
      rooms: [
        {
          id: "room-r",
          name: "n",
          purpose: null,
          createdAt: "2026-05-26T01:00:00.000Z",
          updatedAt: "2026-05-26T01:00:00.000Z",
        },
      ],
      messages: [
        {
          id: "msg-r",
          roomId: "room-r",
          authorAgentId: "a",
          body: "b",
          replyToMessageId: null,
          mentionAgentIds: [],
          createdAt: "2026-05-26T01:01:00.000Z",
        },
      ],
    });
    const store2 = new DynamoChatStore({ client: ddb, workspaceId: WS, logger });
    const payload = await store2.loadAll();
    expect(payload.rooms).toHaveLength(1);
    expect(payload.messages).toHaveLength(1);
  });

  test("F3 design-out: workspaceId is captured at construction; cross-tenant writes impossible", async () => {
    const ddb = new InMemoryDynamoClient();
    const storeA = new DynamoChatStore({ client: ddb, workspaceId: "ws_A", logger });
    const storeB = new DynamoChatStore({ client: ddb, workspaceId: "ws_B", logger });
    await storeA.save({
      rooms: [
        {
          id: "room-shared",
          name: "n",
          purpose: null,
          createdAt: "2026-05-26T01:00:00.000Z",
          updatedAt: "2026-05-26T01:00:00.000Z",
        },
      ],
      messages: [],
    });
    // storeB's partition (ws_B#chat) sees no rows from storeA's
    // partition (ws_A#chat). Cross-tenant isolation by construction.
    const payloadB = await storeB.loadAll();
    expect(payloadB.rooms).toEqual([]);
    expect(payloadB.messages).toEqual([]);
    const payloadA = await storeA.loadAll();
    expect(payloadA.rooms).toHaveLength(1);
  });
});
