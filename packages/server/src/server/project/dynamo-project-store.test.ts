import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { InMemoryDynamoClient } from "../cloud-dynamo-client.js";
import { DynamoProjectStore } from "./dynamo-project-store.js";
import type { PersistedProjectRecord } from "../workspace-registry.js";

const TABLE = "orchestra-dev-state";

function build(workspaceId = "ws_test") {
  const ddb = new InMemoryDynamoClient();
  const store = new DynamoProjectStore({
    client: ddb,
    workspaceId,
    logger: createTestLogger(),
    tableName: TABLE,
  });
  return { store, ddb };
}

function buildRecord(overrides: Partial<PersistedProjectRecord> = {}): PersistedProjectRecord {
  return {
    projectId: overrides.projectId ?? "proj_1",
    rootPath: overrides.rootPath ?? "/tmp/project-1",
    kind: overrides.kind ?? "git",
    displayName: overrides.displayName ?? "Project One",
    createdAt: overrides.createdAt ?? "2026-05-30T01:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-05-30T01:00:00.000Z",
    archivedAt: overrides.archivedAt ?? null,
    ...("workspaceId" in overrides ? { workspaceId: overrides.workspaceId } : {}),
    ...("repoUrl" in overrides ? { repoUrl: overrides.repoUrl } : {}),
  };
}

describe("DynamoProjectStore (D-3.12)", () => {
  test("list returns empty when nothing is written", async () => {
    const { store } = build();
    expect(await store.list()).toEqual([]);
  });

  test("existsOnDisk is false when partition is empty", async () => {
    const { store } = build();
    expect(await store.existsOnDisk()).toBe(false);
  });

  test("upsert → get round-trips a single project", async () => {
    const { store } = build();
    await store.upsert(buildRecord({ projectId: "proj_42", displayName: "Hello" }));
    const fetched = await store.get("proj_42");
    expect(fetched).toMatchObject({
      projectId: "proj_42",
      displayName: "Hello",
      kind: "git",
      archivedAt: null,
    });
  });

  test("get returns null for an unknown projectId", async () => {
    const { store } = build();
    expect(await store.get("proj_missing")).toBeNull();
  });

  test("upsert → list returns every persisted project in the workspace partition", async () => {
    const { store } = build();
    await store.upsert(buildRecord({ projectId: "proj_a" }));
    await store.upsert(buildRecord({ projectId: "proj_b" }));
    await store.upsert(buildRecord({ projectId: "proj_c" }));
    const records = await store.list();
    expect(records.map((r) => r.projectId).sort()).toEqual(["proj_a", "proj_b", "proj_c"]);
  });

  test("upsert overwrites the previous row body (last write wins)", async () => {
    const { store } = build();
    await store.upsert(buildRecord({ projectId: "proj_x", displayName: "original" }));
    await store.upsert(buildRecord({ projectId: "proj_x", displayName: "updated" }));
    const fetched = await store.get("proj_x");
    expect(fetched?.displayName).toBe("updated");
    expect(await store.list()).toHaveLength(1);
  });

  test("DDB row layout uses cloud-shared `<ws>#project` / `<projectId>` shape", async () => {
    const { store, ddb } = build("ws_layout");
    await store.upsert(buildRecord({ projectId: "proj_layout" }));
    const rows = Array.from(ddb._snapshot().values());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pk: "ws_layout#project",
      sk: "proj_layout",
      projectId: "proj_layout",
    });
    expect(rows[0].record).toMatchObject({ projectId: "proj_layout" });
  });

  test("archive stamps archivedAt + updatedAt, preserves the rest of the record", async () => {
    const { store } = build();
    await store.upsert(
      buildRecord({
        projectId: "proj_arch",
        displayName: "to be archived",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-29T00:00:00.000Z",
        archivedAt: null,
      }),
    );
    await store.archive("proj_arch", "2026-05-30T01:00:00.000Z");
    const fetched = await store.get("proj_arch");
    expect(fetched).toMatchObject({
      projectId: "proj_arch",
      displayName: "to be archived",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-30T01:00:00.000Z",
      archivedAt: "2026-05-30T01:00:00.000Z",
    });
  });

  test("archive on a non-existent projectId is a silent no-op (matches FileBacked semantics)", async () => {
    const { store } = build();
    await expect(
      store.archive("proj_does_not_exist", "2026-05-30T01:00:00.000Z"),
    ).resolves.toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  test("remove deletes the row; subsequent get returns null", async () => {
    const { store } = build();
    await store.upsert(buildRecord({ projectId: "proj_del" }));
    await store.remove("proj_del");
    expect(await store.get("proj_del")).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  test("existsOnDisk flips from false to true once a project lands", async () => {
    const { store } = build();
    expect(await store.existsOnDisk()).toBe(false);
    await store.upsert(buildRecord({ projectId: "proj_first" }));
    expect(await store.existsOnDisk()).toBe(true);
  });

  test("cross-restart durability: a fresh store sees rows from a prior instance", async () => {
    const ddb = new InMemoryDynamoClient();
    const store1 = new DynamoProjectStore({
      client: ddb,
      workspaceId: "ws_restart",
      logger: createTestLogger(),
      tableName: TABLE,
    });
    await store1.upsert(buildRecord({ projectId: "proj_persistent" }));
    const store2 = new DynamoProjectStore({
      client: ddb,
      workspaceId: "ws_restart",
      logger: createTestLogger(),
      tableName: TABLE,
    });
    expect(await store2.get("proj_persistent")).toMatchObject({ projectId: "proj_persistent" });
  });

  test("F3 design-out: workspaceId is captured at construction; cross-tenant reads return nothing", async () => {
    const ddb = new InMemoryDynamoClient();
    const storeA = new DynamoProjectStore({
      client: ddb,
      workspaceId: "ws_A",
      logger: createTestLogger(),
      tableName: TABLE,
    });
    const storeB = new DynamoProjectStore({
      client: ddb,
      workspaceId: "ws_B",
      logger: createTestLogger(),
      tableName: TABLE,
    });
    await storeA.upsert(buildRecord({ projectId: "proj_shared_id" }));
    expect(await storeB.get("proj_shared_id")).toBeNull();
    expect(await storeB.list()).toEqual([]);
  });

  test("D-3.5a: round-trips workspaceId + repoUrl (containment FK + provenance)", async () => {
    const { store } = build("ws_1n");
    await store.upsert(
      buildRecord({
        projectId: "remote:github.com/acme/repo",
        workspaceId: "ws_1n",
        repoUrl: "https://github.com/acme/repo",
      }),
    );
    const fetched = await store.get("remote:github.com/acme/repo");
    expect(fetched).toMatchObject({
      projectId: "remote:github.com/acme/repo",
      workspaceId: "ws_1n",
      repoUrl: "https://github.com/acme/repo",
    });
  });

  test("D-3.5a: a row body persisted WITHOUT the new fields still parses (back-compat)", async () => {
    const { store, ddb } = build("ws_legacy");
    // Simulate an old daemon's row body — no workspaceId / repoUrl.
    await ddb.put({
      TableName: TABLE,
      Item: {
        pk: "ws_legacy#project",
        sk: "proj_old",
        projectId: "proj_old",
        record: {
          projectId: "proj_old",
          rootPath: "/tmp/old",
          kind: "git",
          displayName: "Old Project",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          archivedAt: null,
        },
      },
    });
    const fetched = await store.get("proj_old");
    expect(fetched).toMatchObject({ projectId: "proj_old", kind: "git" });
    expect(fetched?.workspaceId).toBeUndefined();
    expect(fetched?.repoUrl).toBeUndefined();
  });

  test("list skips rows that fail schema parse (warn-and-continue)", async () => {
    const { store, ddb } = build("ws_corrupt");
    await store.upsert(buildRecord({ projectId: "proj_good" }));
    await ddb.put({
      TableName: TABLE,
      Item: {
        pk: "ws_corrupt#project",
        sk: "proj_garbage",
        projectId: "proj_garbage",
        record: { not: "a valid project record" },
      },
    });
    const records = await store.list();
    expect(records.map((r) => r.projectId)).toEqual(["proj_good"]);
  });
});
