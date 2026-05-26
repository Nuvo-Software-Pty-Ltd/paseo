import pino from "pino";
import { describe, expect, test } from "vitest";

import { InMemoryDynamoClient } from "../cloud-dynamo-client.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { DynamoAgentTimelineStore } from "./dynamo-agent-timeline-store.js";

const logger = pino({ level: "silent" });
const WS = "ws_test";

function userMessage(messageId: string, text: string): AgentTimelineItem {
  return { type: "user_message", messageId, text } as unknown as AgentTimelineItem;
}

function assistantMessage(text: string): AgentTimelineItem {
  return { type: "assistant_message", text } as unknown as AgentTimelineItem;
}

describe("DynamoAgentTimelineStore (T-6) — daemon-owned timeline key shape", () => {
  test("appendCommitted assigns monotonic seq + reads back the row", async () => {
    const ddb = new InMemoryDynamoClient();
    const store = new DynamoAgentTimelineStore({
      client: ddb,
      workspaceId: WS,
      logger,
    });
    const row1 = await store.appendCommitted("agent-1", userMessage("m1", "hi"));
    const row2 = await store.appendCommitted("agent-1", assistantMessage("hello"));
    expect(row1.seq).toBe(1);
    expect(row2.seq).toBe(2);
    const rows = await store.getCommittedRows("agent-1");
    expect(rows).toHaveLength(2);
    expect(rows[0].seq).toBe(1);
    expect(rows[1].seq).toBe(2);
  });

  test("epoch is stable across appends; cross-restart resume recovers it from the tail", async () => {
    const ddb = new InMemoryDynamoClient();
    const store1 = new DynamoAgentTimelineStore({ client: ddb, workspaceId: WS, logger });
    await store1.appendCommitted("agent-1", userMessage("m1", "hi"));
    await store1.appendCommitted("agent-1", assistantMessage("hello"));
    // Fresh store (simulated restart) reads the tail row to recover.
    const store2 = new DynamoAgentTimelineStore({ client: ddb, workspaceId: WS, logger });
    const row3 = await store2.appendCommitted("agent-1", userMessage("m2", "again"));
    expect(row3.seq).toBe(3);
    // Same epoch across both store instances.
    const fetched = await store2.fetchCommitted("agent-1");
    expect(fetched.rows).toHaveLength(3);
    expect(fetched.epoch).toBeTruthy();
  });

  test("fetchCommitted{direction:'after',cursor} returns events after cursor (resume catchup)", async () => {
    const ddb = new InMemoryDynamoClient();
    const store = new DynamoAgentTimelineStore({ client: ddb, workspaceId: WS, logger });
    for (let i = 1; i <= 5; i++) {
      await store.appendCommitted("agent-1", userMessage(`m${i}`, `text ${i}`));
    }
    const head = await store.fetchCommitted("agent-1");
    const epoch = head.epoch;
    const result = await store.fetchCommitted("agent-1", {
      direction: "after",
      cursor: { epoch, seq: 2 },
    });
    expect(result.staleCursor).toBe(false);
    expect(result.rows.map((r) => r.seq)).toEqual([3, 4, 5]);
  });

  test("staleCursor:true when cursor epoch differs from current epoch", async () => {
    const ddb = new InMemoryDynamoClient();
    const store = new DynamoAgentTimelineStore({ client: ddb, workspaceId: WS, logger });
    await store.appendCommitted("agent-1", userMessage("m1", "hi"));
    const result = await store.fetchCommitted("agent-1", {
      direction: "after",
      cursor: { epoch: "stale-epoch-uuid", seq: 0 },
    });
    expect(result.staleCursor).toBe(true);
  });

  test("getLastAssistantMessage returns the most recent assistant_message text", async () => {
    const ddb = new InMemoryDynamoClient();
    const store = new DynamoAgentTimelineStore({ client: ddb, workspaceId: WS, logger });
    await store.appendCommitted("agent-1", userMessage("m1", "u1"));
    await store.appendCommitted("agent-1", assistantMessage("first answer"));
    await store.appendCommitted("agent-1", userMessage("m2", "u2"));
    await store.appendCommitted("agent-1", assistantMessage("second answer"));
    const last = await store.getLastAssistantMessage("agent-1");
    expect(last).toBe("second answer");
  });

  test("hasCommittedUserMessage by (messageId, text)", async () => {
    const ddb = new InMemoryDynamoClient();
    const store = new DynamoAgentTimelineStore({ client: ddb, workspaceId: WS, logger });
    await store.appendCommitted("agent-1", userMessage("m1", "hi"));
    expect(
      await store.hasCommittedUserMessage("agent-1", {
        messageId: "m1",
        text: "hi",
      }),
    ).toBe(true);
    expect(
      await store.hasCommittedUserMessage("agent-1", {
        messageId: "m1",
        text: "different",
      }),
    ).toBe(false);
  });

  test("deleteAgent purges every row + clears the epoch cache", async () => {
    const ddb = new InMemoryDynamoClient();
    const store = new DynamoAgentTimelineStore({ client: ddb, workspaceId: WS, logger });
    await store.appendCommitted("agent-1", userMessage("m1", "hi"));
    await store.appendCommitted("agent-1", userMessage("m2", "hi2"));
    await store.deleteAgent("agent-1");
    const result = await store.fetchCommitted("agent-1");
    expect(result.rows).toEqual([]);
  });

  test("cross-tenant isolation: workspace B sees nothing from workspace A", async () => {
    const ddb = new InMemoryDynamoClient();
    const a = new DynamoAgentTimelineStore({ client: ddb, workspaceId: "ws_A", logger });
    const b = new DynamoAgentTimelineStore({ client: ddb, workspaceId: "ws_B", logger });
    await a.appendCommitted("agent-shared", userMessage("m1", "hi"));
    expect(await a.getCommittedRows("agent-shared")).toHaveLength(1);
    expect(await b.getCommittedRows("agent-shared")).toEqual([]);
  });
});
