import pino from "pino";
import { describe, expect, test } from "vitest";

import { InMemoryDynamoClient } from "./cloud-dynamo-client.js";
import { DynamoLoopStore } from "./dynamo-loop-store.js";
import type { LoopRecord } from "./loop-types.js";

const logger = pino({ level: "silent" });
const WS = "ws_test";

function makeRecord(overrides: Partial<LoopRecord> = {}): LoopRecord {
  return {
    id: "loop-001",
    name: "test",
    prompt: "prompt",
    cwd: "/tmp/wd",
    provider: "claude",
    model: null,
    modeId: null,
    workerProvider: null,
    workerModel: null,
    verifierProvider: null,
    verifierModel: null,
    verifierModeId: null,
    verifyPrompt: "verify",
    verifyChecks: [],
    archive: false,
    sleepMs: 0,
    maxIterations: null,
    maxTimeMs: null,
    status: "running",
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    startedAt: "2026-05-26T00:00:00.000Z",
    completedAt: null,
    stopRequestedAt: null,
    iterations: [],
    logs: [],
    nextLogSeq: 1,
    activeIteration: null,
    activeWorkerAgentId: null,
    activeVerifierAgentId: null,
    cloudOwnerWorkspaceId: null,
    cloudOwnerAccountId: null,
    ...overrides,
  };
}

describe("DynamoLoopStore (T-3)", () => {
  test("save + loadAll round-trips a simple loop record", async () => {
    const ddb = new InMemoryDynamoClient();
    const store = new DynamoLoopStore({ client: ddb, workspaceId: WS, logger });
    await store.save([makeRecord()]);
    const reloaded = await store.loadAll();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].id).toBe("loop-001");
    expect(reloaded[0].status).toBe("running");
  });

  test("maxTimeMs cap (round-19 binding): cap message lives in logs[].text — no top-level failureReason", async () => {
    const ddb = new InMemoryDynamoClient();
    const store = new DynamoLoopStore({ client: ddb, workspaceId: WS, logger });
    const failed = makeRecord({
      id: "loop-cap",
      status: "failed",
      maxTimeMs: 60_000,
      completedAt: "2026-05-26T00:01:00.000Z",
      logs: [
        {
          seq: 1,
          timestamp: "2026-05-26T00:00:00.000Z",
          iteration: null,
          source: "loop",
          level: "info",
          text: "Loop created in /tmp/wd",
        },
        {
          seq: 2,
          timestamp: "2026-05-26T00:01:00.000Z",
          iteration: null,
          source: "loop",
          level: "error",
          text: "Reached max time (60000ms).",
        },
      ],
      nextLogSeq: 3,
    });
    await store.save([failed]);
    const reloaded = await store.loadAll();
    expect(reloaded[0].status).toBe("failed");
    expect(reloaded[0].logs[1].text).toBe("Reached max time (60000ms).");
    // No top-level failureReason field exists on the wire shape —
    // verifying via the schema not surfacing one.
    expect((reloaded[0] as unknown as { failureReason?: unknown }).failureReason).toBeUndefined();
  });

  test("step rows are written to the cloud-shared canonical shape", async () => {
    const ddb = new InMemoryDynamoClient();
    const store = new DynamoLoopStore({ client: ddb, workspaceId: WS, logger });
    const record = makeRecord({
      id: "loop-steps",
      logs: [
        {
          seq: 1,
          timestamp: "2026-05-26T00:00:00.000Z",
          iteration: 1,
          source: "worker",
          level: "info",
          text: "first",
        },
        {
          seq: 2,
          timestamp: "2026-05-26T00:00:01.000Z",
          iteration: 1,
          source: "verifier",
          level: "info",
          text: "second",
        },
      ],
      nextLogSeq: 3,
    });
    await store.save([record]);
    const snapshot = ddb._snapshot();
    const stepRows = Array.from(snapshot.values()).filter((r) => String(r.sk).includes("#step#"));
    expect(stepRows).toHaveLength(2);
    // Both rows live in the <ws>#loop partition with zero-padded seq.
    expect(stepRows[0].pk).toBe("ws_test#loop");
    const sks = stepRows.map((r) => String(r.sk)).sort();
    expect(sks).toEqual(["loop-steps#step#000000000001", "loop-steps#step#000000000002"]);
  });

  test("cross-tenant isolation: workspace B sees nothing from workspace A's partition", async () => {
    const ddb = new InMemoryDynamoClient();
    const a = new DynamoLoopStore({ client: ddb, workspaceId: "ws_A", logger });
    const b = new DynamoLoopStore({ client: ddb, workspaceId: "ws_B", logger });
    await a.save([makeRecord({ id: "loop-a" })]);
    expect((await a.loadAll()).map((r) => r.id)).toEqual(["loop-a"]);
    expect(await b.loadAll()).toEqual([]);
  });

  test("cross-restart parity: fresh store reads rows written by a prior instance", async () => {
    const ddb = new InMemoryDynamoClient();
    const store1 = new DynamoLoopStore({ client: ddb, workspaceId: WS, logger });
    await store1.save([
      makeRecord({ id: "loop-r1" }),
      makeRecord({
        id: "loop-r2",
        createdAt: "2026-05-26T01:00:00.000Z",
        updatedAt: "2026-05-26T01:00:00.000Z",
        startedAt: "2026-05-26T01:00:00.000Z",
      }),
    ]);
    const store2 = new DynamoLoopStore({ client: ddb, workspaceId: WS, logger });
    const reloaded = await store2.loadAll();
    expect(reloaded.map((r) => r.id).sort()).toEqual(["loop-r1", "loop-r2"]);
  });
});
