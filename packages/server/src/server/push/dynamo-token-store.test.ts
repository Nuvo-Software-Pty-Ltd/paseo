import pino from "pino";
import { describe, expect, test } from "vitest";

import { InMemoryDynamoClient } from "../cloud-dynamo-client.js";
import { DynamoPushTokenStore } from "./dynamo-token-store.js";

const logger = pino({ level: "silent" });
const WS = "ws_test";
const TABLE = "orchestra-dev-state";
const TOKEN_A = "ExponentPushToken[AAAAAAAAAAAAAAAAAAAAAA]";
const TOKEN_B = "ExponentPushToken[BBBBBBBBBBBBBBBBBBBBBB]";

function makeStore(client: InMemoryDynamoClient): DynamoPushTokenStore {
  return new DynamoPushTokenStore({
    client,
    workspaceId: WS,
    logger,
    tableName: TABLE,
  });
}

describe("DynamoPushTokenStore", () => {
  test("addToken then getAllTokens returns the token", async () => {
    const ddb = new InMemoryDynamoClient();
    const store = makeStore(ddb);
    await store.addToken(TOKEN_A);
    expect(await store.getAllTokens()).toEqual([TOKEN_A]);
  });

  test("survives a daemon restart — a new store instance over the same table still sees the token", async () => {
    // Regression for the tmpfs bug: cloud daemon recycles wipe
    // $PASEO_HOME, so push tokens MUST persist in DynamoDB. A fresh store
    // instance models the post-recycle daemon reading the same table.
    const ddb = new InMemoryDynamoClient();
    await makeStore(ddb).addToken(TOKEN_A); // pre-recycle daemon registers the device

    const afterRecycle = makeStore(ddb); // new daemon process, empty tmpfs
    expect(await afterRecycle.getAllTokens()).toEqual([TOKEN_A]);
  });

  test("addToken dedupes the same token", async () => {
    const ddb = new InMemoryDynamoClient();
    const store = makeStore(ddb);
    await store.addToken(TOKEN_A);
    await store.addToken(TOKEN_A);
    expect(await store.getAllTokens()).toEqual([TOKEN_A]);
  });

  test("removeToken deletes the token", async () => {
    const ddb = new InMemoryDynamoClient();
    const store = makeStore(ddb);
    await store.addToken(TOKEN_A);
    await store.addToken(TOKEN_B);
    await store.removeToken(TOKEN_A);
    expect(await store.getAllTokens()).toEqual([TOKEN_B]);
  });

  test("ignores empty / whitespace tokens and trims", async () => {
    const ddb = new InMemoryDynamoClient();
    const store = makeStore(ddb);
    await store.addToken("   ");
    await store.addToken("");
    expect(await store.getAllTokens()).toEqual([]);
    await store.addToken(`  ${TOKEN_A}  `);
    expect(await store.getAllTokens()).toEqual([TOKEN_A]);
  });

  test("writes rows under the per-workspace <ws>#push-token partition", async () => {
    const ddb = new InMemoryDynamoClient();
    await makeStore(ddb).addToken(TOKEN_A);
    const rows = [...ddb._snapshot().values()];
    expect(rows).toHaveLength(1);
    expect(rows[0].pk).toBe(`${WS}#push-token`);
    expect(rows[0].sk).toBe(TOKEN_A);
  });
});
