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
});
