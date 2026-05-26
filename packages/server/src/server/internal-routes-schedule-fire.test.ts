import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import express from "express";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createInternalRoutes } from "./internal-routes.js";
import type { StoredSchedule } from "./schedule/types.js";
import type { ScheduleService } from "./schedule/service.js";
import type { ScheduleStore } from "./schedule/store.js";

// T-15 — `/api/internal/schedule-fire` HMAC-validated handler. Lifecycle
// worker POSTs `{ scheduleId }`; daemon looks up the schedule, restores
// the ALS context via T-7's persisted cloudOwner* fields, and invokes
// `scheduleService.runOnce`.

const logger = pino({ level: "silent" });

interface Fixture {
  url: string;
  close: () => Promise<void>;
  hmacKey: string;
  scheduleStore: ScheduleStore;
  scheduleService: ScheduleService;
  runOnce: ReturnType<typeof vi.fn>;
}

function makeSchedule(overrides: Partial<StoredSchedule> = {}): StoredSchedule {
  return {
    id: "abc12345",
    name: null,
    prompt: "prompt",
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
    cloudOwnerWorkspaceId: "ws_self",
    cloudOwnerAccountId: "acc_self",
    ...overrides,
  };
}

async function buildFixture(opts: {
  scheduleByGetId: Record<string, StoredSchedule | null>;
  runOnceImpl?: (id: string) => Promise<StoredSchedule>;
  expectedWorkspaceId?: string;
}): Promise<Fixture> {
  const hmacKey = "test-hmac-key";
  const runOnce = vi.fn(async (id: string) => {
    if (opts.runOnceImpl) return opts.runOnceImpl(id);
    return makeSchedule({ id });
  });
  const scheduleStore: ScheduleStore = {
    list: async () => [],
    get: async (id: string) => opts.scheduleByGetId[id] ?? null,
    create: async () => makeSchedule(),
    put: async () => {},
    delete: async () => {},
  };
  const scheduleService = {
    runOnce,
  } as unknown as ScheduleService;

  const app = express();
  app.use(
    createInternalRoutes({
      hmacKey,
      logger,
      scheduleService,
      scheduleStore,
      ...(opts.expectedWorkspaceId ? { expectedWorkspaceId: opts.expectedWorkspaceId } : {}),
    }),
  );

  const httpServer = await new Promise<Server>((resolve) => {
    const s = createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    hmacKey,
    scheduleStore,
    scheduleService,
    runOnce,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      }),
  };
}

function signBody(key: string, body: string): string {
  return createHmac("sha256", key).update(body).digest("hex");
}

describe("POST /api/internal/schedule-fire (T-15)", () => {
  let fixture: Fixture;

  afterEach(async () => {
    if (fixture) await fixture.close();
  });

  test("HMAC-valid + active schedule + matching workspaceId → 200 and runOnce invoked", async () => {
    fixture = await buildFixture({
      scheduleByGetId: { abc12345: makeSchedule() },
      expectedWorkspaceId: "ws_self",
    });
    const body = JSON.stringify({ scheduleId: "abc12345" });
    const res = await fetch(`${fixture.url}/api/internal/schedule-fire`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Orchestra-Internal-HMAC": signBody(fixture.hmacKey, body),
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(fixture.runOnce).toHaveBeenCalledWith("abc12345");
  });

  test("HMAC-invalid → 401", async () => {
    fixture = await buildFixture({
      scheduleByGetId: { abc12345: makeSchedule() },
    });
    const body = JSON.stringify({ scheduleId: "abc12345" });
    const res = await fetch(`${fixture.url}/api/internal/schedule-fire`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Orchestra-Internal-HMAC": "deadbeef".repeat(8),
      },
      body,
    });
    expect(res.status).toBe(401);
    expect(fixture.runOnce).not.toHaveBeenCalled();
  });

  test("cross-workspace cloudOwnerWorkspaceId → 403 (defense-in-depth)", async () => {
    fixture = await buildFixture({
      scheduleByGetId: {
        abc12345: makeSchedule({ cloudOwnerWorkspaceId: "ws_other" }),
      },
      expectedWorkspaceId: "ws_self",
    });
    const body = JSON.stringify({ scheduleId: "abc12345" });
    const res = await fetch(`${fixture.url}/api/internal/schedule-fire`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Orchestra-Internal-HMAC": signBody(fixture.hmacKey, body),
      },
      body,
    });
    expect(res.status).toBe(403);
    expect(fixture.runOnce).not.toHaveBeenCalled();
  });

  test("unknown scheduleId → 404", async () => {
    fixture = await buildFixture({
      scheduleByGetId: {},
      expectedWorkspaceId: "ws_self",
    });
    const body = JSON.stringify({ scheduleId: "missing" });
    const res = await fetch(`${fixture.url}/api/internal/schedule-fire`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Orchestra-Internal-HMAC": signBody(fixture.hmacKey, body),
      },
      body,
    });
    expect(res.status).toBe(404);
  });

  test("paused schedule → 200 with skipped:true (worker logs + moves on)", async () => {
    fixture = await buildFixture({
      scheduleByGetId: {
        abc12345: makeSchedule({ status: "paused" }),
      },
      expectedWorkspaceId: "ws_self",
    });
    const body = JSON.stringify({ scheduleId: "abc12345" });
    const res = await fetch(`${fixture.url}/api/internal/schedule-fire`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Orchestra-Internal-HMAC": signBody(fixture.hmacKey, body),
      },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { skipped?: boolean; reason?: string };
    expect(json.skipped).toBe(true);
    expect(json.reason).toBe("status_paused");
    expect(fixture.runOnce).not.toHaveBeenCalled();
  });

  test("invalid body shape → 400", async () => {
    fixture = await buildFixture({
      scheduleByGetId: {},
    });
    const body = JSON.stringify({ wrongField: 1 });
    const res = await fetch(`${fixture.url}/api/internal/schedule-fire`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Orchestra-Internal-HMAC": signBody(fixture.hmacKey, body),
      },
      body,
    });
    expect(res.status).toBe(400);
  });
});
