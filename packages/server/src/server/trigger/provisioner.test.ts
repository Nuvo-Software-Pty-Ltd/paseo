import { describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { CloudTriggerProvisioner, SelfHostTriggerProvisioner } from "./provisioner.js";
import type { TriggerSecretStore } from "./secret-store.js";

// VERIFY-3.5d #4 — the daemon's webhook provisioner must speak the SAME
// contract the cloud auth service exposes (packages/auth/src/routes/
// webhook-register.ts): the `/api/auth-internal/*` namespace (NOT the
// original `/api/lifecycle-internal/*` placeholder), an `accountId` in the
// register body, and a `{secret}`-only rotate response. These tests pin
// that contract so the two repos can't drift again.

interface CapturedCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

function recordingFetch(responder: (call: CapturedCall) => Response): {
  fetchImpl: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) headers[k] = v;
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    const call: CapturedCall = {
      url: String(input),
      method: init?.method,
      headers,
      body: rawBody ? JSON.parse(rawBody) : undefined,
    };
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BASE = "https://auth-internal.dev.orchestra.nuvo.software";

function makeCloud(fetchImpl: typeof fetch): CloudTriggerProvisioner {
  return new CloudTriggerProvisioner({
    internalUrl: BASE,
    hmacKey: "test-hmac-key",
    workspaceId: "ws_test",
    accountId: "acct_test",
    logger: createTestLogger(),
    fetchImpl,
  });
}

describe("CloudTriggerProvisioner — auth-internal contract (VERIFY-3.5d #4)", () => {
  test("provision POSTs to /api/auth-internal/register-webhook with workspaceId + accountId + triggerId", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({ webhookId: "wh_pub", ingressUrl: `${BASE}/t/wh_pub`, secret: "s3cr3t" }),
    );

    const result = await makeCloud(fetchImpl).provision("trg_123");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/api/auth-internal/register-webhook`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["X-Orchestra-Internal-HMAC"]).toBeTruthy();
    expect(calls[0].body).toEqual({
      workspaceId: "ws_test",
      accountId: "acct_test",
      triggerId: "trg_123",
    });
    expect(result).toEqual({
      webhookId: "wh_pub",
      ingressUrl: `${BASE}/t/wh_pub`,
      secret: "s3cr3t",
    });
  });

  test("rotate POSTs to /api/auth-internal/rotate-webhook-secret and returns the secret-only response", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ secret: "rotated-secret" }));

    const result = await makeCloud(fetchImpl).rotate("trg_123", "wh_pub");

    expect(calls[0].url).toBe(`${BASE}/api/auth-internal/rotate-webhook-secret`);
    expect(calls[0].body).toEqual({
      workspaceId: "ws_test",
      triggerId: "trg_123",
      webhookId: "wh_pub",
    });
    expect(result).toEqual({ secret: "rotated-secret" });
  });

  test("deprovision POSTs to /api/auth-internal/deregister-webhook", async () => {
    const { fetchImpl, calls } = recordingFetch(() => jsonResponse({ ok: true }));

    await makeCloud(fetchImpl).deprovision("trg_123", "wh_pub");

    expect(calls[0].url).toBe(`${BASE}/api/auth-internal/deregister-webhook`);
    expect(calls[0].body).toMatchObject({
      workspaceId: "ws_test",
      triggerId: "trg_123",
      webhookId: "wh_pub",
    });
  });

  test("provision surfaces a non-2xx register failure as an error", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ error: "nope" }, 500));

    await expect(makeCloud(fetchImpl).provision("trg_123")).rejects.toThrow(/register-webhook/);
  });
});

describe("SelfHostTriggerProvisioner.rotate", () => {
  test("returns a fresh secret-only result and persists it for the local receiver", async () => {
    const stored = new Map<string, string>();
    const secretStore: TriggerSecretStore = {
      put: vi.fn(async (webhookId: string, secret: string) => {
        stored.set(webhookId, secret);
      }),
      get: vi.fn(async (webhookId: string) => stored.get(webhookId) ?? null),
      delete: vi.fn(async (webhookId: string) => {
        stored.delete(webhookId);
      }),
    };

    const provisioner = new SelfHostTriggerProvisioner("http://localhost:6767", secretStore);
    const result = await provisioner.rotate("trg_1", "wh_local");

    expect(Object.keys(result)).toEqual(["secret"]);
    expect(typeof result.secret).toBe("string");
    expect(result.secret.length).toBeGreaterThan(0);
    expect(stored.get("wh_local")).toBe(result.secret);
  });
});
