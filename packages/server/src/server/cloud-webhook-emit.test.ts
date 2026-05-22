import { createHmac } from "node:crypto";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { emitWebhookEvent } from "./cloud-webhook-emit.js";
import type { WorkspaceHardDeleteImminentEvent } from "./cloud-webhook-events.js";

const logger = pino({ level: "silent" });

const VALID_EVENT: WorkspaceHardDeleteImminentEvent = {
  eventType: "workspace.hard_delete_imminent",
  workspaceId: "ws_abc",
  accountId: "acc_1",
  archivedAt: "2026-05-22T00:00:00.000Z",
  scheduledPurgeAt: "2026-06-21T00:00:00.000Z",
};

describe("emitWebhookEvent", () => {
  it("POSTs to subscriberUrl with the snake_case wire body and HMAC header", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await emitWebhookEvent({
      subscriberUrl: "https://subscriber.example.com/hook",
      hmacKey: "test-key",
      event: VALID_EVENT,
      logger,
      fetchImpl,
    });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(capturedUrl).toBe("https://subscriber.example.com/hook");
    expect(capturedInit?.method).toBe("POST");

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Orchestra-Internal-HMAC"]).toMatch(/^[a-f0-9]{64}$/);

    const bodyString = String(capturedInit?.body);
    // Body MUST be the snake_case wire form — subscribers read
    // workspace-lifecycle.md, not our TS.
    expect(JSON.parse(bodyString)).toEqual({
      event_type: "workspace.hard_delete_imminent",
      workspace_id: "ws_abc",
      account_id: "acc_1",
      archived_at: "2026-05-22T00:00:00.000Z",
      scheduled_purge_at: "2026-06-21T00:00:00.000Z",
    });

    // HMAC computed over the JSON body bytes — verifiable by the subscriber.
    const expectedHmac = createHmac("sha256", "test-key").update(bodyString).digest("hex");
    expect(headers["X-Orchestra-Internal-HMAC"]).toBe(expectedHmac);
  });

  it("returns ok:false (does not throw) when fetch rejects, and logs at warn", async () => {
    const warn = vi.fn();
    const noisyLogger = { ...logger, warn, info: vi.fn() } as unknown as Parameters<
      typeof emitWebhookEvent
    >[0]["logger"];
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await emitWebhookEvent({
      subscriberUrl: "https://subscriber.example.com/hook",
      hmacKey: "k",
      event: VALID_EVENT,
      logger: noisyLogger,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("returns { ok:false, status } when the subscriber replies non-2xx", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("forbidden", { status: 403 }),
    ) as unknown as typeof fetch;

    const result = await emitWebhookEvent({
      subscriberUrl: "https://subscriber.example.com/hook",
      hmacKey: "k",
      event: VALID_EVENT,
      logger,
      fetchImpl,
    });

    expect(result).toEqual({ ok: false, status: 403 });
  });

  it("refuses to send an off-schema event (caller-supplied bad payload)", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    // Type-cast to bypass TS — the worker side may construct from JSON.
    const badEvent = { ...VALID_EVENT, workspaceId: "" } as WorkspaceHardDeleteImminentEvent;
    await expect(
      emitWebhookEvent({
        subscriberUrl: "https://subscriber.example.com/hook",
        hmacKey: "k",
        event: badEvent,
        logger,
        fetchImpl,
      }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
