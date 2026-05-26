import { createHmac } from "node:crypto";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { cloudHmacFetch } from "./cloud-hmac-fetch.js";

const logger = pino({ level: "silent" });

describe("cloudHmacFetch", () => {
  it("POSTs the body with Content-Type JSON + X-Orchestra-Internal-HMAC header signed over the body", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await cloudHmacFetch({
      url: "https://target.example.com/route",
      hmacKey: "test-key",
      body: '{"hello":"world"}',
      logger,
      fetchImpl,
    });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(capturedUrl).toBe("https://target.example.com/route");
    expect(capturedInit?.method).toBe("POST");

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    const expected = createHmac("sha256", "test-key").update('{"hello":"world"}').digest("hex");
    expect(headers["X-Orchestra-Internal-HMAC"]).toBe(expected);
    expect(String(capturedInit?.body)).toBe('{"hello":"world"}');
  });

  it("returns { ok:false } and warns when fetch rejects", async () => {
    const warn = vi.fn();
    const noisyLogger = { ...logger, warn, info: vi.fn() } as unknown as Parameters<
      typeof cloudHmacFetch
    >[0]["logger"];
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await cloudHmacFetch({
      url: "https://target.example.com",
      hmacKey: "k",
      body: "{}",
      logger: noisyLogger,
      fetchImpl,
      logContext: { workspaceId: "ws_1" },
      failureLogLabel: "Test",
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const arg = warn.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(arg?.workspaceId).toBe("ws_1");
  });

  it("returns { ok:false, status } when the response is non-2xx", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 500 }),
    ) as unknown as typeof fetch;

    const result = await cloudHmacFetch({
      url: "https://target.example.com",
      hmacKey: "k",
      body: "{}",
      logger,
      fetchImpl,
    });

    expect(result).toEqual({ ok: false, status: 500 });
  });

  // T-12 (synthesis A8) — 429 body + rate-limit headers parsing.

  it("parses a 429 body into quotaPayload when the wire shape matches", async () => {
    const body429 = JSON.stringify({
      code: "quota_exceeded",
      quota_class: "agent_count",
      current: 10,
      cap: 10,
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(body429, {
          status: 429,
          headers: {
            "Retry-After": "30",
            "X-RateLimit-Limit": "10",
            "X-RateLimit-Remaining": "0",
          },
        }),
    ) as unknown as typeof fetch;

    const result = await cloudHmacFetch({
      url: "https://target.example.com",
      hmacKey: "k",
      body: "{}",
      logger,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(result.quotaPayload).toEqual({
      code: "quota_exceeded",
      quotaClass: "agent_count",
      current: 10,
      cap: 10,
    });
    expect(result.rateLimitHeaders).toEqual({
      retryAfterSeconds: 30,
      rateLimitLimit: 10,
      rateLimitRemaining: 0,
    });
  });

  it("omits quotaPayload on a 429 with a non-matching body", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("rate limited", { status: 429 }),
    ) as unknown as typeof fetch;

    const result = await cloudHmacFetch({
      url: "https://target.example.com",
      hmacKey: "k",
      body: "{}",
      logger,
      fetchImpl,
    });

    expect(result.status).toBe(429);
    expect(result.quotaPayload).toBeUndefined();
  });

  it("omits quotaPayload on non-429 errors even if the body is quota-shaped", async () => {
    const body = JSON.stringify({
      code: "quota_exceeded",
      quota_class: "x",
      current: 1,
      cap: 1,
    });
    const fetchImpl = vi.fn(
      async () => new Response(body, { status: 500 }),
    ) as unknown as typeof fetch;

    const result = await cloudHmacFetch({
      url: "https://target.example.com",
      hmacKey: "k",
      body: "{}",
      logger,
      fetchImpl,
    });

    expect(result.status).toBe(500);
    expect(result.quotaPayload).toBeUndefined();
  });
});
