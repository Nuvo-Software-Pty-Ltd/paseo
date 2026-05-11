import { describe, expect, test } from "vitest";
import { AgentManager } from "./agent/agent-manager.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { LoopService } from "./loop-service.js";
import type { LoopStore } from "./loop-store.js";
import type { LoopRecord } from "./loop-types.js";

class InMemoryLoopStore implements LoopStore {
  records: LoopRecord[] = [];
  saveCount = 0;

  async loadAll(): Promise<LoopRecord[]> {
    return this.records.map((record) => structuredClone(record));
  }

  async save(records: LoopRecord[]): Promise<void> {
    this.saveCount += 1;
    this.records = records.map((record) => structuredClone(record));
  }
}

describe("LoopService store-contract", () => {
  test("delegates persistence to the injected LoopStore", async () => {
    const store = new InMemoryLoopStore();
    const logger = createTestLogger();
    const service = new LoopService({
      store,
      agentManager: new AgentManager({ logger }),
      logger,
    });

    await service.initialize();
    expect(store.saveCount).toBe(1);
    expect(store.records).toEqual([]);

    const seeded: LoopRecord = {
      id: "abcd1234",
      name: "warmup",
      prompt: "do work",
      cwd: "/tmp",
      provider: "claude",
      model: null,
      modeId: null,
      workerProvider: null,
      workerModel: null,
      verifierProvider: null,
      verifierModel: null,
      verifierModeId: null,
      verifyPrompt: null,
      verifyChecks: ["true"],
      archive: false,
      sleepMs: 0,
      maxIterations: 1,
      maxTimeMs: null,
      status: "succeeded",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.000Z",
      stopRequestedAt: null,
      iterations: [],
      logs: [],
      nextLogSeq: 1,
      activeIteration: null,
      activeWorkerAgentId: null,
      activeVerifierAgentId: null,
    };
    store.records = [seeded];

    const replay = new LoopService({
      store,
      agentManager: new AgentManager({ logger }),
      logger,
    });
    await replay.initialize();

    const listed = await replay.listLoops();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(seeded.id);

    const inspected = await replay.inspectLoop(seeded.id);
    expect(inspected.status).toBe("succeeded");
  });
});
