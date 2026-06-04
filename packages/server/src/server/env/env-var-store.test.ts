import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { InMemoryDynamoClient } from "../cloud-dynamo-client.js";
import { DynamoEnvVarStore } from "./dynamo-env-var-store.js";
import {
  FileBackedEnvVarStore,
  type EnvVarStore,
  type ScopedEnvVarRecord,
} from "./env-var-store.js";

const TABLE = "orchestra-dev-state";

function buildRecord(overrides: Partial<ScopedEnvVarRecord> = {}): ScopedEnvVarRecord {
  return {
    scope: overrides.scope ?? "project",
    scopeId: overrides.scopeId ?? "proj_1",
    key: overrides.key ?? "API_BASE",
    value: overrides.value ?? "https://example.test",
    ...("secret" in overrides ? { secret: overrides.secret } : {}),
    createdAt: overrides.createdAt ?? "2026-06-04T01:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-06-04T01:00:00.000Z",
  };
}

// One suite body, run against both store impls so the file-backed and
// Dynamo variants prove the same contract.
function runStoreContract(name: string, makeStore: () => EnvVarStore) {
  describe(name, () => {
    test("listForScope returns empty when nothing is written", async () => {
      const store = makeStore();
      expect(await store.listForScope("project", "proj_1")).toEqual([]);
      expect(await store.listForScope("workspace", "ws_local")).toEqual([]);
    });

    test("upsert then listForScope round-trips both scopes independently", async () => {
      const store = makeStore();
      await store.upsert(buildRecord({ scope: "workspace", scopeId: "ws_local", key: "SHARED" }));
      await store.upsert(buildRecord({ scope: "project", scopeId: "proj_1", key: "LOCAL" }));

      const wsVars = await store.listForScope("workspace", "ws_local");
      expect(wsVars.map((r) => r.key)).toEqual(["SHARED"]);

      const projVars = await store.listForScope("project", "proj_1");
      expect(projVars.map((r) => r.key)).toEqual(["LOCAL"]);
    });

    test("upsert replaces the value for an existing (scope, scopeId, key)", async () => {
      const store = makeStore();
      await store.upsert(buildRecord({ key: "TOKEN", value: "v1" }));
      await store.upsert(buildRecord({ key: "TOKEN", value: "v2" }));
      const vars = await store.listForScope("project", "proj_1");
      expect(vars).toHaveLength(1);
      expect(vars[0]?.value).toBe("v2");
    });

    test("remove deletes one key without touching the other", async () => {
      const store = makeStore();
      await store.upsert(buildRecord({ key: "A", value: "1" }));
      await store.upsert(buildRecord({ key: "B", value: "2" }));
      await store.remove("project", "proj_1", "A");
      const vars = await store.listForScope("project", "proj_1");
      expect(vars.map((r) => r.key)).toEqual(["B"]);
    });

    test("two projects are isolated", async () => {
      const store = makeStore();
      await store.upsert(buildRecord({ scopeId: "proj_a", key: "ONLY_A", value: "a" }));
      await store.upsert(buildRecord({ scopeId: "proj_b", key: "ONLY_B", value: "b" }));
      expect((await store.listForScope("project", "proj_a")).map((r) => r.key)).toEqual(["ONLY_A"]);
      expect((await store.listForScope("project", "proj_b")).map((r) => r.key)).toEqual(["ONLY_B"]);
    });

    test("secret flag survives the round-trip", async () => {
      const store = makeStore();
      await store.upsert(buildRecord({ key: "SECRET_TOKEN", value: "sk-123", secret: true }));
      const [record] = await store.listForScope("project", "proj_1");
      expect(record?.secret).toBe(true);
      expect(record?.value).toBe("sk-123");
    });
  });
}

describe("FileBackedEnvVarStore", () => {
  let paseoHome: string;

  beforeEach(() => {
    paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-envvar-store-"));
  });

  afterEach(() => {
    rmSync(paseoHome, { recursive: true, force: true });
  });

  runStoreContract(
    "file-backed contract",
    () => new FileBackedEnvVarStore({ paseoHome, logger: createTestLogger() }),
  );

  test("persists across reloads (new store instance reads the same file)", async () => {
    const logger = createTestLogger();
    const first = new FileBackedEnvVarStore({ paseoHome, logger });
    await first.upsert(buildRecord({ key: "PERSISTED", value: "yes" }));

    const second = new FileBackedEnvVarStore({ paseoHome, logger });
    const vars = await second.listForScope("project", "proj_1");
    expect(vars.map((r) => r.key)).toEqual(["PERSISTED"]);
  });
});

runStoreContract(
  "DynamoEnvVarStore",
  () =>
    new DynamoEnvVarStore({
      client: new InMemoryDynamoClient(),
      workspaceId: "ws_test",
      logger: createTestLogger(),
      tableName: TABLE,
    }),
);

describe("DynamoEnvVarStore row layout", () => {
  test("writes under the <ws>#envvar partition with <scope>#<scopeId>#<key> sort key", async () => {
    const ddb = new InMemoryDynamoClient();
    const store = new DynamoEnvVarStore({
      client: ddb,
      workspaceId: "ws_test",
      logger: createTestLogger(),
      tableName: TABLE,
    });
    await store.upsert(buildRecord({ scope: "project", scopeId: "proj_1", key: "K" }));
    const result = await ddb.query({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "ws_test#envvar" },
    });
    expect(result.Items).toHaveLength(1);
    expect(result.Items?.[0]?.sk).toBe("project#proj_1#K");
  });
});
