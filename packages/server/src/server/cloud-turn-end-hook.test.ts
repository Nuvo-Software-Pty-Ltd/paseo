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
      logger,
    });
    expect(hook).toBeUndefined();
  });

  it("returns undefined when webhookSinkUrl is unset (no-op sink)", () => {
    const hook = createCloudTurnEndHook({
      webhookSinkUrl: undefined,
      hmacKey: "k",
      logger,
    });
    expect(hook).toBeUndefined();
  });

  it("returns undefined when hmacKey is unset (cannot authenticate)", () => {
    const hook = createCloudTurnEndHook({
      webhookSinkUrl: "https://sink.example.com",
      hmacKey: undefined,
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
    const body = JSON.parse(captured!.body);
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
    const body = JSON.parse(capturedBody!);
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
});
