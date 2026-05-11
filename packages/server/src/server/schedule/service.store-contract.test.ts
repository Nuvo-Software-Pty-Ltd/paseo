import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { ScheduleService } from "./service.js";
import type { ScheduleStore } from "./store.js";
import type { StoredSchedule } from "./types.js";

class InMemoryScheduleStore implements ScheduleStore {
  readonly records = new Map<string, StoredSchedule>();

  async list(): Promise<StoredSchedule[]> {
    return Array.from(this.records.values()).sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  async get(id: string): Promise<StoredSchedule | null> {
    return this.records.get(id) ?? null;
  }

  async create(schedule: Omit<StoredSchedule, "id">): Promise<StoredSchedule> {
    const created: StoredSchedule = { ...schedule, id: randomBytes(4).toString("hex") };
    this.records.set(created.id, created);
    return created;
  }

  async put(schedule: StoredSchedule): Promise<void> {
    this.records.set(schedule.id, schedule);
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }
}

describe("ScheduleService store-contract", () => {
  test("delegates persistence to the injected ScheduleStore", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "schedule-contract-"));
    const agentStorage = new AgentStorage(join(tempDir, "agents"), createTestLogger());
    await agentStorage.initialize();
    try {
      const store = new InMemoryScheduleStore();
      const service = new ScheduleService({
        store,
        logger: createTestLogger(),
        agentManager: new AgentManager({ logger: createTestLogger() }),
        agentStorage,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
      });

      const created = await service.create({
        prompt: "Run nightly check",
        cadence: { type: "every", everyMs: 60_000 },
        target: {
          type: "new-agent",
          config: { provider: "claude", cwd: tempDir },
        },
      });

      expect(store.records.size).toBe(1);
      expect(store.records.get(created.id)?.prompt).toBe("Run nightly check");

      const listed = await service.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe(created.id);

      await service.delete(created.id);
      expect(store.records.size).toBe(0);
    } finally {
      await agentStorage.flush();
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
