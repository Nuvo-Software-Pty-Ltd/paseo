import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentTurnEndContext } from "./agent/agent-manager.js";
import { workspaceAuthStorage } from "./cloud-auth.js";
import { createCloudTurnEndHook } from "./cloud-turn-end-hook.js";

const logger = pino({ level: "silent" });

describe("createCloudTurnEndHook (T-8 / synthesis A5)", () => {
  const originalCloudMode = process.env.PASEO_CLOUD_MODE;

  beforeEach(() => {
    process.env.PASEO_CLOUD_MODE = "1";
  });

  afterEach(() => {
    if (originalCloudMode === undefined) {
      delete process.env.PASEO_CLOUD_MODE;
    } else {
      process.env.PASEO_CLOUD_MODE = originalCloudMode;
    }
  });

  function buildCompletedContext(): AgentTurnEndContext {
    return {
      agentId: "agent_uuid_1",
      provider: "claude",
      model: "claude-sonnet-4-6",
      outcome: "completed",
      usage: {
        inputTokens: 100,
        cachedInputTokens: 50,
        outputTokens: 30,
        totalCostUsd: 0.001,
      },
      error: "",
      endedAt: "2026-05-26T03:00:00.000Z",
    };
  }

  it("returns undefined when PASEO_CLOUD_MODE=0", () => {
    process.env.PASEO_CLOUD_MODE = "0";
    const hook = createCloudTurnEndHook({
      webhookSinkUrl: "https://sink.example.com",
      hmacKey: "k",
      authInternalUrl: undefined,
      logger,
    });
    expect(hook).toBeUndefined();
  });

  it("returns undefined when both webhookSinkUrl and authInternalUrl are unset", () => {
    const hook = createCloudTurnEndHook({
      webhookSinkUrl: undefined,
      hmacKey: "k",
      authInternalUrl: undefined,
      logger,
    });
    expect(hook).toBeUndefined();
  });

  it("returns undefined when hmacKey is unset (cannot authenticate)", () => {
    const hook = createCloudTurnEndHook({
      webhookSinkUrl: "https://sink.example.com",
      hmacKey: undefined,
      authInternalUrl: undefined,
      logger,
    });
    expect(hook).toBeUndefined();
  });

  it("fires agent.turn_completed with workspace claims from the ALS", async () => {
    let captured: { url: string; body: string } | null = null;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      captured = { url, body: String(init?.body) };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const hook = createCloudTurnEndHook({
      webhookSinkUrl: "https://sink.example.com/hook",
      hmacKey: "k",
      authInternalUrl: undefined,
      logger,
      fetchImpl,
    });
    expect(hook).toBeDefined();

    await workspaceAuthStorage.run(
      { workspaceId: "ws_self", accountId: "acc_1", expiresAt: 999_999_999_999 },
      async () => {
        hook!(buildCompletedContext());
        // Allow the void-promise inside the hook to flush.
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    );

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://sink.example.com/hook");
    // Auth's canonical SinkBody (round-3 re-alignment):
    // { eventId, eventType, eventTime, eventSchemaVersion: "1",
    //   workspaceId, accountId, data }
    // The snake_case wire body lives under `data`.
    const envelope = JSON.parse(captured!.body);
    expect(envelope.eventType).toBe("agent.turn_completed");
    expect(envelope.workspaceId).toBe("ws_self");
    expect(envelope.accountId).toBe("acc_1");
    expect(typeof envelope.eventId).toBe("string");
    expect(typeof envelope.eventTime).toBe("string");
    expect(envelope.eventSchemaVersion).toBe("1");
    const body = envelope.data;
    expect(body.event_type).toBe("agent.turn_completed");
    expect(body.workspace_id).toBe("ws_self");
    expect(body.account_id).toBe("acc_1");
    expect(body.agent_id).toBe("agent_uuid_1");
    expect(body.usage.input_tokens).toBe(100);
    expect(body.usage.output_tokens).toBe(30);
  });

  it("fires agent.turn_failed with the error string and nullable usage", async () => {
    let capturedBody: string | null = null;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = String(init?.body);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const hook = createCloudTurnEndHook({
      webhookSinkUrl: "https://sink.example.com/hook",
      hmacKey: "k",
      authInternalUrl: undefined,
      logger,
      fetchImpl,
    });

    await workspaceAuthStorage.run(
      { workspaceId: "ws_self", accountId: "acc_1", expiresAt: 999_999_999_999 },
      async () => {
        hook!({
          agentId: "agent_uuid_2",
          provider: "claude",
          model: null,
          outcome: "failed",
          usage: null,
          error: "Provider 500",
          endedAt: "2026-05-26T04:00:00.000Z",
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    );

    expect(capturedBody).not.toBeNull();
    const envelope = JSON.parse(capturedBody!);
    expect(envelope.eventType).toBe("agent.turn_failed");
    expect(envelope.workspaceId).toBe("ws_self");
    expect(envelope.accountId).toBe("acc_1");
    expect(envelope.eventSchemaVersion).toBe("1");
    const body = envelope.data;
    expect(body.event_type).toBe("agent.turn_failed");
    expect(body.error).toBe("Provider 500");
    expect(body.model).toBeNull();
    expect(body.usage).toBeNull();
  });

  it("skips the emit when called outside workspaceAuthStorage (T-7 will close this hole)", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const hook = createCloudTurnEndHook({
      webhookSinkUrl: "https://sink.example.com/hook",
      hmacKey: "k",
      authInternalUrl: undefined,
      logger,
      fetchImpl,
    });
    // No workspaceAuthStorage.run() wrapping — the hook fires from a
    // schedule/loop spawn that has not yet been wired to restore the
    // ALS context (T-7 closes this).
    hook!(buildCompletedContext());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("warn-and-continue on subscriber failure — does not throw to the agent-manager", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const hook = createCloudTurnEndHook({
      webhookSinkUrl: "https://sink.example.com/hook",
      hmacKey: "k",
      authInternalUrl: undefined,
      logger,
      fetchImpl,
    });

    const invoke = () => hook!(buildCompletedContext());
    await workspaceAuthStorage.run(
      { workspaceId: "ws_self", accountId: "acc_1", expiresAt: 999_999_999_999 },
      async () => {
        // The hook itself is sync (returns void); the fetch promise
        // lives inside void(async()=>…). If the fetch promise had
        // bubbled, the test would observe an unhandled rejection.
        expect(invoke).not.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    );
  });

  // ----- T-18 (synthesis A7) — spend-row writer ----------------------------

  it("writes a spend row to /api/auth-internal/spend with the UTC day key + raw token counts", async () => {
    const captures: { url: string; body: string }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      captures.push({ url, body: String(init?.body) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const hook = createCloudTurnEndHook({
      webhookSinkUrl: undefined,
      hmacKey: "k",
      authInternalUrl: "https://auth.example.com",
      logger,
      fetchImpl,
    });
    expect(hook).toBeDefined();

    await workspaceAuthStorage.run(
      { workspaceId: "ws_self", accountId: "acc_1", expiresAt: 999_999_999_999 },
      async () => {
        hook!(buildCompletedContext());
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    );

    expect(captures.length).toBe(1);
    expect(captures[0].url).toBe("https://auth.example.com/api/auth-internal/spend");
    const body = JSON.parse(captures[0].body);
    expect(body.workspaceId).toBe("ws_self");
    // Raw token counts per OQ-C (daemon writes raw; aggregator
    // computes cents from rate table).
    expect(body.turnCount).toBe(1);
    expect(body.inputTokens).toBe(100);
    expect(body.cachedInputTokens).toBe(50);
    expect(body.outputTokens).toBe(30);
    // UTC day-key from endedAt:"2026-05-26T03:00:00.000Z"
    expect(body.dayKey).toBe("2026-05-26");
  });

  it("fires both webhook + spend write when both URLs are configured", async () => {
    const captures: { url: string }[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      captures.push({ url });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const hook = createCloudTurnEndHook({
      webhookSinkUrl: "https://sink.example.com/hook",
      hmacKey: "k",
      authInternalUrl: "https://auth.example.com",
      logger,
      fetchImpl,
    });

    await workspaceAuthStorage.run(
      { workspaceId: "ws_self", accountId: "acc_1", expiresAt: 999_999_999_999 },
      async () => {
        hook!(buildCompletedContext());
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    );

    const urls = captures.map((c) => c.url).sort();
    expect(urls).toEqual([
      "https://auth.example.com/api/auth-internal/spend",
      "https://sink.example.com/hook",
    ]);
  });

  it("skips the spend write when the turn has no usage block", async () => {
    const captures: { url: string }[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      captures.push({ url });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const hook = createCloudTurnEndHook({
      webhookSinkUrl: undefined,
      hmacKey: "k",
      authInternalUrl: "https://auth.example.com",
      logger,
      fetchImpl,
    });

    await workspaceAuthStorage.run(
      { workspaceId: "ws_self", accountId: "acc_1", expiresAt: 999_999_999_999 },
      async () => {
        hook!({
          agentId: "agent_uuid_3",
          provider: "claude",
          model: null,
          outcome: "failed",
          usage: null, // provider returned no usage block
          error: "no usage",
          endedAt: "2026-05-26T05:00:00.000Z",
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
    );

    expect(captures.length).toBe(0);
  });
});
