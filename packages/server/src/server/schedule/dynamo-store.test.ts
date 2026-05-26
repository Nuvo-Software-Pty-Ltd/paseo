import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import { InMemoryDynamoClient } from "../cloud-dynamo-client.js";
import { DynamoScheduleStore } from "./dynamo-store.js";
import type { ScheduleRun, StoredSchedule } from "./types.js";

const logger = pino({ level: "silent" });
const WS = "ws_test";
const TABLE = "orchestra-dev-state";

function baseInput(): Omit<StoredSchedule, "id"> {
  return {
    name: "test",
    prompt: "do thing",
    cadence: { type: "every", everyMs: 60_000 },
    target: { type: "agent", agentId: "00000000-0000-0000-0000-000000000001" },
    status: "active",
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    nextRunAt: "2026-05-26T00:01:00.000Z",
    lastRunAt: null,
    pausedAt: null,
    expiresAt: null,
    maxRuns: null,
    runs: [],
    cloudOwnerWorkspaceId: null,
    cloudOwnerAccountId: null,
  };
}

describe("DynamoScheduleStore (T-2, synthesis C1)", () => {
  test("create + get round-trips a schedule", async () => {
    const ddb = new InMemoryDynamoClient();
    const store = new DynamoScheduleStore({
      client: ddb,
      workspaceId: WS,
      logger,
      tableName: TABLE,
    });
    const created = await store.create(baseInput());
    expect(created.id).toMatch(/^[0-9a-f]{8}$/);
    const reloaded = await store.get(created.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.cadence).toEqual(baseInput().cadence);
    expect(reloaded?.runs).toEqual([]);
  });

  test("sub-minute every cadence is rejected (synthesis OQ1)", async () => {
    const ddb = new InMemoryDynamoClient();
    const store = new DynamoScheduleStore({
      client: ddb,
      workspaceId: WS,
      logger,
      tableName: TABLE,
    });
    await expect(
      store.create({
        ...baseInput(),
        cadence: { type: "every", everyMs: 30_000 },
      }),
    ).rejects.toThrow(/Cloud-mode schedules require every >= 60s/);
    // The DDB write was NOT issued — partition is empty.
    const list = await store.list();
    expect(list).toEqual([]);
  });

  test("cron cadence is not subject to the sub-minute gate (5-field rejection is on-host)", async () => {
    const ddb = new InMemoryDynamoClient();
    const store = new DynamoScheduleStore({
      client: ddb,
      workspaceId: WS,
      logger,
      tableName: TABLE,
    });
    const created = await store.create({
      ...baseInput(),
      cadence: { type: "cron", expression: "* * * * *" },
    });
    expect(created.cadence.type).toBe("cron");
  });

  test("notifyRegister fires HMAC POST to /api/lifecycle-internal/register-schedule on create", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const ddb = new InMemoryDynamoClient();
    const store = new DynamoScheduleStore({
      client: ddb,
      workspaceId: WS,
      logger,
      tableName: TABLE,
      lifecycleInternalUrl: "https://lifecycle.example.com",
      hmacKey: "hmac-key",
      fetchImpl,
    });
    await store.create(baseInput());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0];
    expect(url).toBe("https://lifecycle.example.com/api/lifecycle-internal/register-schedule");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      workspaceId: WS,
      scheduleId: expect.stringMatching(/^[0-9a-f]{8}$/),
      cadence: { type: "every", everyMs: 60_000 },
    });
  });

  test("notifyDeregister fires HMAC POST to deregister-schedule on delete", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const ddb = new InMemoryDynamoClient();
    const store = new DynamoScheduleStore({
      client: ddb,
      workspaceId: WS,
      logger,
      tableName: TABLE,
      lifecycleInternalUrl: "https://lifecycle.example.com",
      hmacKey: "hmac-key",
      fetchImpl,
    });
    const created = await store.create(baseInput());
    fetchImpl.mockClear?.();
    await store.delete(created.id);
    const calls = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    const deregisterCall = calls.find(([url]) => url.includes("deregister-schedule"));
    expect(deregisterCall).toBeDefined();
    const body = JSON.parse(String(deregisterCall![1].body));
    expect(body).toEqual({ workspaceId: WS, scheduleId: created.id });
  });

  test("notify warn-and-continues on non-2xx (Day-1 posture; mirrors D-2 T-4 heartbeat)", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 500 }),
    ) as unknown as typeof fetch;
    const ddb = new InMemoryDynamoClient();
    const store = new DynamoScheduleStore({
      client: ddb,
      workspaceId: WS,
      logger,
      tableName: TABLE,
      lifecycleInternalUrl: "https://lifecycle.example.com",
      hmacKey: "hmac-key",
      fetchImpl,
    });
    // Should NOT throw — the schedule is still created in DDB.
    const created = await store.create(baseInput());
    expect(created.id).toMatch(/^[0-9a-f]{8}$/);
  });

  test("putRun appends a run row + get returns runs sorted by startedAt", async () => {
    const ddb = new InMemoryDynamoClient();
    const store = new DynamoScheduleStore({
      client: ddb,
      workspaceId: WS,
      logger,
      tableName: TABLE,
    });
    const created = await store.create(baseInput());
    const run1: ScheduleRun = {
      id: "00000000-0000-0000-0000-000000000010",
      scheduledFor: "2026-05-26T00:01:00.000Z",
      startedAt: "2026-05-26T00:01:00.000Z",
      endedAt: "2026-05-26T00:01:05.000Z",
      status: "succeeded",
      agentId: "00000000-0000-0000-0000-000000000001",
      output: "ok",
      error: null,
    };
    const run2: ScheduleRun = {
      id: "00000000-0000-0000-0000-000000000011",
      scheduledFor: "2026-05-26T00:02:00.000Z",
      startedAt: "2026-05-26T00:02:00.000Z",
      endedAt: null,
      status: "running",
      agentId: null,
      output: null,
      error: null,
    };
    // Write out-of-order to exercise the sort.
    await store.putRun(created.id, run2);
    await store.putRun(created.id, run1);
    const reloaded = await store.get(created.id);
    expect(reloaded?.runs.map((r) => r.id)).toEqual([run1.id, run2.id]);
  });

  test("round-19 failed-run shape round-trips (agentId:null, output:null, error:string)", async () => {
    const ddb = new InMemoryDynamoClient();
    const store = new DynamoScheduleStore({
      client: ddb,
      workspaceId: WS,
      logger,
      tableName: TABLE,
    });
    const created = await store.create({
      ...baseInput(),
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: "/tmp/does-not-exist" },
      },
    });
    const failedRun: ScheduleRun = {
      id: "00000000-0000-0000-0000-000000000020",
      scheduledFor: "2026-05-26T00:01:00.000Z",
      startedAt: "2026-05-26T00:01:00.000Z",
      endedAt: "2026-05-26T00:01:00.500Z",
      status: "failed",
      agentId: null,
      output: null,
      error: "Working directory does not exist: /tmp/does-not-exist",
    };
    await store.putRun(created.id, failedRun);
    const reloaded = await store.get(created.id);
    expect(reloaded?.runs).toHaveLength(1);
    expect(reloaded?.runs[0].status).toBe("failed");
    expect(reloaded?.runs[0].agentId).toBeNull();
    expect(reloaded?.runs[0].output).toBeNull();
    expect(reloaded?.runs[0].error).toMatch(/Working directory does not exist/);
  });

  test("delete removes both meta and run rows + cross-tenant isolation", async () => {
    const ddb = new InMemoryDynamoClient();
    const storeA = new DynamoScheduleStore({
      client: ddb,
      workspaceId: "ws_A",
      logger,
      tableName: TABLE,
    });
    const storeB = new DynamoScheduleStore({
      client: ddb,
      workspaceId: "ws_B",
      logger,
      tableName: TABLE,
    });
    const a = await storeA.create(baseInput());
    await storeB.create(baseInput());
    await storeA.putRun(a.id, {
      id: "00000000-0000-0000-0000-000000000030",
      scheduledFor: "2026-05-26T00:01:00.000Z",
      startedAt: "2026-05-26T00:01:00.000Z",
      endedAt: null,
      status: "running",
      agentId: null,
      output: null,
      error: null,
    });
    await storeA.delete(a.id);
    // workspace A has no schedules left.
    expect(await storeA.list()).toEqual([]);
    // workspace B still has its schedule (cross-tenant isolation).
    expect((await storeB.list()).length).toBe(1);
  });
});
