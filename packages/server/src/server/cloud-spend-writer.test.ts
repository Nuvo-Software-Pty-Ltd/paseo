import { createHmac } from "node:crypto";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { toUtcDayKey, writeSpendRow } from "./cloud-spend-writer.js";

const logger = pino({ level: "silent" });

describe("cloud-spend-writer — T-18 (synthesis A7)", () => {
  it("toUtcDayKey produces YYYY-MM-DD in UTC", () => {
    // 2026-05-26T03:00:00.000Z → 2026-05-26 regardless of local TZ.
    expect(toUtcDayKey(new Date("2026-05-26T03:00:00.000Z"))).toBe("2026-05-26");
    // Cross-midnight: 2026-05-26T23:30:00.000Z → 2026-05-26 (still
    // same UTC day even though local TZ may be 2026-05-27).
    expect(toUtcDayKey(new Date("2026-05-26T23:30:00.000Z"))).toBe("2026-05-26");
    // 2026-12-31T23:59:59.000Z → 2026-12-31.
    expect(toUtcDayKey(new Date("2026-12-31T23:59:59.000Z"))).toBe("2026-12-31");
  });

  it("POSTs the spend body + HMAC over the body to /api/auth-internal/spend", async () => {
    let captured: { url: string; body: string; headers: Record<string, string> } | null = null;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      captured = {
        url,
        body: String(init?.body),
        headers: (init?.headers ?? {}) as Record<string, string>,
      };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await writeSpendRow({
      url: "https://auth.example.com/api/auth-internal/spend",
      hmacKey: "key-1",
      workspaceId: "ws_self",
      dayKey: "2026-05-26",
      turn: {
        inputTokens: 100,
        cachedInputTokens: 50,
        outputTokens: 30,
      },
      logger,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://auth.example.com/api/auth-internal/spend");
    const body = JSON.parse(captured!.body);
    expect(body).toEqual({
      workspaceId: "ws_self",
      dayKey: "2026-05-26",
      turnCount: 1,
      inputTokens: 100,
      cachedInputTokens: 50,
      outputTokens: 30,
    });
    const expectedHmac = createHmac("sha256", "key-1").update(captured!.body).digest("hex");
    expect(captured!.headers["X-Orchestra-Internal-HMAC"]).toBe(expectedHmac);
  });

  it("returns ok:false (does not throw) on a non-2xx response — warn-and-continue posture", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("internal error", { status: 500 }),
    ) as unknown as typeof fetch;

    const result = await writeSpendRow({
      url: "https://auth.example.com/api/auth-internal/spend",
      hmacKey: "key-1",
      workspaceId: "ws_self",
      dayKey: "2026-05-26",
      turn: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 },
      logger,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
  });

  it("surfaces 429 + quotaPayload via cloudHmacFetch when auth returns a quota body", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: "quota_exceeded",
            quota_class: "outbound_api_spend",
            current: 500,
            cap: 500,
          }),
          { status: 429 },
        ),
    ) as unknown as typeof fetch;

    const result = await writeSpendRow({
      url: "https://auth.example.com/api/auth-internal/spend",
      hmacKey: "key-1",
      workspaceId: "ws_self",
      dayKey: "2026-05-26",
      turn: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 },
      logger,
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
    expect(result.quotaPayload).toEqual({
      code: "quota_exceeded",
      quotaClass: "outbound_api_spend",
      current: 500,
      cap: 500,
    });
  });
});
