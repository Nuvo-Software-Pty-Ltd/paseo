import { describe, expect, test, vi } from "vitest";

import {
  createDynamoLikeFromDocumentClient,
  getSharedDocumentClient,
} from "./cloud-dynamo-adapter.js";

// Verify the adapter delegates each method to client.send() exactly
// once. Production correctness is end-to-end-tested via the
// `Dynamo*Store` unit tests (which use `InMemoryDynamoClient`); this
// suite only ensures the SDK-wrapper translation is wired correctly.
//
// We mock the DocumentClient's `send` and inspect the dispatched
// command's constructor name + input — no real network is involved.

interface RecordedCall {
  commandName: string;
  input: Record<string, unknown>;
}

function buildMockClient(): {
  client: { send: ReturnType<typeof vi.fn> };
  calls: RecordedCall[];
  responses: { Item?: Record<string, unknown>; Items?: Record<string, unknown>[] };
} {
  const calls: RecordedCall[] = [];
  const responses: {
    Item?: Record<string, unknown>;
    Items?: Record<string, unknown>[];
  } = {};
  const send = vi.fn(
    async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      calls.push({ commandName: command.constructor.name, input: command.input });
      if (command.constructor.name === "GetCommand") {
        return responses.Item ? { Item: responses.Item } : {};
      }
      if (command.constructor.name === "QueryCommand") {
        return { Items: responses.Items ?? [] };
      }
      return {};
    },
  );
  return { client: { send } as { send: typeof send }, calls, responses };
}

describe("getSharedDocumentClient", () => {
  test("configures removeUndefinedValues:true so StoredAgentRecord optional fields do not throw during marshalling", async () => {
    const client = await getSharedDocumentClient();
    // @aws-sdk/lib-dynamodb stores translateConfig at client.config.translateConfig at runtime
    // (not in the public TypeScript type). Cast to read it back for assertion.
    const cfg = client.config as {
      translateConfig?: { marshallOptions?: { removeUndefinedValues?: boolean } };
    };
    expect(cfg.translateConfig?.marshallOptions?.removeUndefinedValues).toBe(true);
  });
});

describe("cloud-dynamo-adapter", () => {
  test("get delegates to GetCommand and returns Item when present", async () => {
    const { client, calls, responses } = buildMockClient();
    responses.Item = { pk: "ws_1#chat", sk: "room-1#meta", id: "room-1" };
    const dl = createDynamoLikeFromDocumentClient(client as never);
    const result = await dl.get("table-1", { pk: "ws_1#chat", sk: "room-1#meta" });
    expect(calls).toHaveLength(1);
    expect(calls[0].commandName).toBe("GetCommand");
    expect(calls[0].input).toEqual({
      TableName: "table-1",
      Key: { pk: "ws_1#chat", sk: "room-1#meta" },
    });
    expect(result.Item).toEqual({ pk: "ws_1#chat", sk: "room-1#meta", id: "room-1" });
  });

  test("get returns {} (no Item key) when the row is absent", async () => {
    const { client } = buildMockClient();
    const dl = createDynamoLikeFromDocumentClient(client as never);
    const result = await dl.get("table-1", { pk: "ws_1#chat", sk: "nothing" });
    expect(result).toEqual({});
  });

  test("put forwards Item and ConditionExpression", async () => {
    const { client, calls } = buildMockClient();
    const dl = createDynamoLikeFromDocumentClient(client as never);
    await dl.put({
      TableName: "table-1",
      Item: { pk: "ws_1#permission", sk: "perm-1", record: { id: "perm-1" } },
      ConditionExpression: "attribute_not_exists(pk)",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].commandName).toBe("PutCommand");
    expect(calls[0].input).toEqual({
      TableName: "table-1",
      Item: { pk: "ws_1#permission", sk: "perm-1", record: { id: "perm-1" } },
      ConditionExpression: "attribute_not_exists(pk)",
    });
  });

  test("delete forwards the key", async () => {
    const { client, calls } = buildMockClient();
    const dl = createDynamoLikeFromDocumentClient(client as never);
    await dl.delete("table-1", { pk: "ws_1#chat", sk: "room-1#meta" });
    expect(calls[0].commandName).toBe("DeleteCommand");
    expect(calls[0].input).toEqual({
      TableName: "table-1",
      Key: { pk: "ws_1#chat", sk: "room-1#meta" },
    });
  });

  test("query forwards KeyConditionExpression and returns Items[]", async () => {
    const { client, calls, responses } = buildMockClient();
    responses.Items = [
      { pk: "ws_1#chat", sk: "room-1#meta" },
      { pk: "ws_1#chat", sk: "room-1#msg#m1" },
    ];
    const dl = createDynamoLikeFromDocumentClient(client as never);
    const result = await dl.query({
      TableName: "table-1",
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "ws_1#chat" },
    });
    expect(calls[0].commandName).toBe("QueryCommand");
    expect(calls[0].input).toMatchObject({
      TableName: "table-1",
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "ws_1#chat" },
    });
    expect(result.Items).toHaveLength(2);
  });

  test("query returns Items:[] when DDB returns no Items field", async () => {
    const { client } = buildMockClient();
    const dl = createDynamoLikeFromDocumentClient(client as never);
    const result = await dl.query({
      TableName: "table-1",
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "ws_empty#chat" },
    });
    expect(result.Items).toEqual([]);
  });

  test("update forwards UpdateExpression and optional ConditionExpression", async () => {
    const { client, calls } = buildMockClient();
    const dl = createDynamoLikeFromDocumentClient(client as never);
    await dl.update({
      TableName: "table-1",
      Key: { pk: "ws_1#spend", sk: "2026-05-29" },
      UpdateExpression: "ADD #amount :delta",
      ExpressionAttributeNames: { "#amount": "amount" },
      ExpressionAttributeValues: { ":delta": 5 },
    });
    expect(calls[0].commandName).toBe("UpdateCommand");
    expect(calls[0].input).toEqual({
      TableName: "table-1",
      Key: { pk: "ws_1#spend", sk: "2026-05-29" },
      UpdateExpression: "ADD #amount :delta",
      ExpressionAttributeNames: { "#amount": "amount" },
      ExpressionAttributeValues: { ":delta": 5 },
    });
  });
});
