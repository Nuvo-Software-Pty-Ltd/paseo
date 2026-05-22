import { createHmac } from "node:crypto";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startHeartbeatLoop,
  type HeartbeatSessionRegistry,
  type HeartbeatWireBody,
} from "./cloud-heartbeat.js";

const logger = pino({ level: "silent" });

function fakeRegistry(active: number, connected: number): HeartbeatSessionRegistry {
  return {
    countActiveAgents: () => active,
    countConnectedClients: () => connected,
  };
}

interface CapturedFetch {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function makeCapturingFetch(): { calls: CapturedFetch[]; fetchImpl: typeof fetch } {
  const calls: CapturedFetch[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      body: String(init?.body),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("startHeartbeatLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("POSTs one heartbeat per 30s tick to /api/auth-internal/heartbeat with body { workspaceId, lastHeartbeat, activeAgents, connectedClients, daemonImageTag }", async () => {
    const { calls, fetchImpl } = makeCapturingFetch();

    const controller = startHeartbeatLoop({
      authServiceBaseUrl: "https://auth.example.com",
      hmacKey: "test-key",
      workspaceId: "ws_test",
      daemonImageTag: "0.2.0-cloud.abc",
      sessionRegistry: fakeRegistry(2, 1),
      logger,
      fetchImpl,
      initialJitterMaxMs: 0,
    });

    // Allow the initial immediate tick to resolve.
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBe(1);

    // 100s = three more ticks at the 30s cadence.
    await vi.advanceTimersByTimeAsync(100_000);
    expect(calls.length).toBe(4);

    expect(calls[0].url).toBe("https://auth.example.com/api/auth-internal/heartbeat");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(calls[0].headers["X-Orchestra-Internal-HMAC"]).toMatch(/^[a-f0-9]{64}$/);

    const parsed = JSON.parse(calls[0].body) as HeartbeatWireBody;
    expect(parsed.workspaceId).toBe("ws_test");
    expect(parsed.activeAgents).toBe(2);
    expect(parsed.connectedClients).toBe(1);
    expect(parsed.daemonImageTag).toBe("0.2.0-cloud.abc");
    expect(typeof parsed.lastHeartbeat).toBe("string");
    expect(() => new Date(parsed.lastHeartbeat).toISOString()).not.toThrow();

    // HMAC must be verifiable by the auth-side route.
    const expectedHmac = createHmac("sha256", "test-key").update(calls[0].body).digest("hex");
    expect(calls[0].headers["X-Orchestra-Internal-HMAC"]).toBe(expectedHmac);

    controller.stop();
  });

  it("reflects current session-registry state in each tick (state can change between ticks)", async () => {
    const { calls, fetchImpl } = makeCapturingFetch();

    let active = 1;
    let connected = 1;
    const dynamicRegistry: HeartbeatSessionRegistry = {
      countActiveAgents: () => active,
      countConnectedClients: () => connected,
    };

    const controller = startHeartbeatLoop({
      authServiceBaseUrl: "https://auth.example.com",
      hmacKey: "k",
      workspaceId: "ws_x",
      daemonImageTag: "t",
      sessionRegistry: dynamicRegistry,
      logger,
      fetchImpl,
      initialJitterMaxMs: 0,
    });

    await vi.advanceTimersByTimeAsync(0);
    active = 3;
    connected = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.length).toBe(2);

    const t0 = JSON.parse(calls[0].body) as HeartbeatWireBody;
    const t1 = JSON.parse(calls[1].body) as HeartbeatWireBody;
    expect(t0.activeAgents).toBe(1);
    expect(t0.connectedClients).toBe(1);
    expect(t1.activeAgents).toBe(3);
    expect(t1.connectedClients).toBe(0);

    controller.stop();
  });

  it("continues ticking after a fetch rejection — logs at warn but does NOT crash", async () => {
    let failures = 0;
    let successes = 0;
    const fetchImpl = vi.fn(async () => {
      if (failures === 0) {
        failures += 1;
        throw new Error("ECONNREFUSED");
      }
      successes += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const controller = startHeartbeatLoop({
      authServiceBaseUrl: "https://auth.example.com",
      hmacKey: "k",
      workspaceId: "ws_y",
      daemonImageTag: "t",
      sessionRegistry: fakeRegistry(0, 0),
      logger,
      fetchImpl,
      initialJitterMaxMs: 0,
    });

    await vi.advanceTimersByTimeAsync(0);
    // First tick: fetch rejects. Loop must not throw.
    expect(failures).toBe(1);
    expect(successes).toBe(0);

    // Second tick (30s later) should succeed.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(successes).toBe(1);

    controller.stop();
  });

  it("respects the initial jitter delay — does not fire until jitter elapses", async () => {
    const { calls, fetchImpl } = makeCapturingFetch();

    const controller = startHeartbeatLoop({
      authServiceBaseUrl: "https://auth.example.com",
      hmacKey: "k",
      workspaceId: "ws_z",
      daemonImageTag: "t",
      sessionRegistry: fakeRegistry(0, 0),
      logger,
      fetchImpl,
      initialJitterMaxMs: 5_000,
      jitterPicker: () => 1_500,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBe(0);

    await vi.advanceTimersByTimeAsync(1_499);
    expect(calls.length).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.length).toBe(2);

    controller.stop();
  });

  it("stop() halts the loop immediately and cancels pending initial jitter", async () => {
    const { calls, fetchImpl } = makeCapturingFetch();

    const controller = startHeartbeatLoop({
      authServiceBaseUrl: "https://auth.example.com",
      hmacKey: "k",
      workspaceId: "ws_a",
      daemonImageTag: "t",
      sessionRegistry: fakeRegistry(0, 0),
      logger,
      fetchImpl,
      initialJitterMaxMs: 0,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBe(1);

    controller.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBe(1);
  });

  it("stop() before initial jitter elapses cancels any heartbeat at all", async () => {
    const { calls, fetchImpl } = makeCapturingFetch();

    const controller = startHeartbeatLoop({
      authServiceBaseUrl: "https://auth.example.com",
      hmacKey: "k",
      workspaceId: "ws_b",
      daemonImageTag: "t",
      sessionRegistry: fakeRegistry(0, 0),
      logger,
      fetchImpl,
      initialJitterMaxMs: 10_000,
      jitterPicker: () => 5_000,
    });

    controller.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBe(0);
  });

  it("strips trailing slash from authServiceBaseUrl", async () => {
    const { calls, fetchImpl } = makeCapturingFetch();

    const controller = startHeartbeatLoop({
      authServiceBaseUrl: "https://auth.example.com/",
      hmacKey: "k",
      workspaceId: "ws_c",
      daemonImageTag: "t",
      sessionRegistry: fakeRegistry(0, 0),
      logger,
      fetchImpl,
      initialJitterMaxMs: 0,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0].url).toBe("https://auth.example.com/api/auth-internal/heartbeat");

    controller.stop();
  });

  it("body carries NO accountId and NO repoUrl (F3 design-out)", async () => {
    const { calls, fetchImpl } = makeCapturingFetch();

    const controller = startHeartbeatLoop({
      authServiceBaseUrl: "https://auth.example.com",
      hmacKey: "k",
      workspaceId: "ws_d",
      daemonImageTag: "t",
      sessionRegistry: fakeRegistry(0, 0),
      logger,
      fetchImpl,
      initialJitterMaxMs: 0,
    });

    await vi.advanceTimersByTimeAsync(0);
    const parsed = JSON.parse(calls[0].body) as Record<string, unknown>;
    expect("accountId" in parsed).toBe(false);
    expect("repoUrl" in parsed).toBe(false);

    controller.stop();
  });
});
