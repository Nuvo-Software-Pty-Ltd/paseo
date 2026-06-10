import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import express from "express";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createRequireWorkspaceMiddleware, type WorkspaceAuthCallback } from "./auth.js";
import { createInternalRoutes } from "./internal-routes.js";
import type { TriggerService } from "./trigger/service.js";
import type { WebhookTriggerStore } from "./trigger/store.js";
import type { WebhookTrigger } from "./trigger/types.js";

// D-3.5d regression — the internal HMAC routes must reach their handlers even
// though they are mounted BEHIND the cloud workspace-token middleware.
//
// This mirrors bootstrap.ts in cloud mode:
//   1. EARLY internal routes (clone-repo only, no services)   — bootstrap ~442
//   2. workspace-token middleware (rejects tokenless requests) — bootstrap ~502
//   3. LATE internal routes (webhook-fire, with triggerService) — bootstrap ~1414
//
// Before the fix, step 2 401'd `/api/internal/webhook-fire` with "invalid
// workspace token" because shouldBypassBearerAuth did not skip `/api/internal/`.
// The route carries an internal HMAC, never a workspace JWT, so the gate was
// the wrong boundary. This proves the bypass lets a VALID-HMAC + NO-token
// request reach the real handler, that a BAD HMAC is rejected by the route's
// OWN HMAC check (not the workspace gate), and — as a control — that the
// workspace middleware really does block a tokenless non-internal route.

const logger = pino({ level: "silent" });

function makeTrigger(overrides: Partial<WebhookTrigger> = {}): WebhookTrigger {
  return {
    id: "abc12345",
    webhookId: "wh_public",
    name: null,
    prompt: "prompt",
    target: { type: "new-agent", config: { provider: "claude", cwd: "/repo" } },
    payloadTemplate: null,
    enabled: true,
    ingressUrl: "https://host/hooks/wh_public",
    secretFingerprint: "abc123",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    lastFiredAt: null,
    runs: [],
    cloudOwnerWorkspaceId: "ws_self",
    cloudOwnerAccountId: "acc_self",
    ...overrides,
  };
}

interface Fixture {
  url: string;
  close: () => Promise<void>;
  hmacKey: string;
  fire: ReturnType<typeof vi.fn>;
}

async function buildFixture(): Promise<Fixture> {
  const hmacKey = "test-hmac-key";
  const fire = vi.fn(async () => undefined);
  const triggerStore: WebhookTriggerStore = {
    list: async () => [],
    get: async (id: string) => (id === "abc12345" ? makeTrigger() : null),
    getByWebhookId: async () => null,
    create: async () => makeTrigger(),
    put: async () => {},
    delete: async () => {},
  };
  const triggerService = { fire } as unknown as TriggerService;

  // Stub workspace-token auth that rejects every request lacking a valid token.
  // validateWorkspaceToken is never reached for bypassed routes; for a
  // tokenless request the middleware 401s before calling it.
  const workspaceAuthCallback: WorkspaceAuthCallback = {
    validateWorkspaceToken: async () => null,
  };

  const app = express();

  // (1) EARLY mount — clone-repo only, no service deps (mirrors bootstrap ~442).
  app.use(createInternalRoutes({ hmacKey, logger }));

  // (2) workspace-token middleware (mirrors bootstrap ~502).
  app.use(
    createRequireWorkspaceMiddleware(workspaceAuthCallback, (ctx) => {
      logger.warn(ctx, "Rejected HTTP request with invalid workspace token");
    }),
  );

  // (3) LATE mount — service-equipped, registers webhook-fire (mirrors ~1414).
  app.use(
    createInternalRoutes({
      hmacKey,
      logger,
      triggerService,
      triggerStore,
      expectedWorkspaceId: "ws_self",
    }),
  );

  // A normal API route registered AFTER the middleware — the control that
  // proves the workspace gate is actually active and blocks tokenless traffic.
  app.get("/api/agents", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  const httpServer = await new Promise<Server>((resolve) => {
    const s = createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    hmacKey,
    fire,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

function signBody(key: string, body: string): string {
  return createHmac("sha256", key).update(body).digest("hex");
}

async function postWebhookFire(fixture: Fixture, body: string, hmac: string): Promise<Response> {
  return fetch(`${fixture.url}/api/internal/webhook-fire`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Orchestra-Internal-HMAC": hmac },
    body,
  });
}

describe("internal routes bypass the workspace-token middleware (D-3.5d)", () => {
  let fixture: Fixture;
  afterEach(async () => {
    if (fixture) await fixture.close();
  });

  test("control: a tokenless NORMAL route is blocked by the workspace gate (401)", async () => {
    fixture = await buildFixture();
    const res = await fetch(`${fixture.url}/api/agents`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  test("VALID HMAC + NO workspace token reaches the late handler and fires (200)", async () => {
    fixture = await buildFixture();
    // Nested payload — proves the daemon's `JSON.stringify(req.body)` round-trip
    // reproduces the exact bytes the caller signed, so HMAC verification over a
    // nested body matches what the auth ingress signs.
    const body = JSON.stringify({
      triggerId: "abc12345",
      payload: { event: "push", repo: { name: "paseo", private: true }, commits: [1, 2, 3] },
    });
    const res = await postWebhookFire(fixture, body, signBody(fixture.hmacKey, body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, triggerId: "abc12345" });
    expect(fixture.fire).toHaveBeenCalledTimes(1);
    expect(fixture.fire.mock.calls[0][0]).toMatchObject({ id: "abc12345" });
    expect(fixture.fire.mock.calls[0][1]).toEqual({
      event: "push",
      repo: { name: "paseo", private: true },
      commits: [1, 2, 3],
    });
  });

  test("BAD HMAC + NO token is rejected by the route's OWN HMAC check, not the workspace gate", async () => {
    fixture = await buildFixture();
    const body = JSON.stringify({ triggerId: "abc12345", payload: { ping: 1 } });
    const res = await postWebhookFire(fixture, body, "deadbeef".repeat(8));
    expect(res.status).toBe(401);
    // The HMAC check owns this rejection — distinct body from the workspace
    // gate's `{ error: "Unauthorized" }`. This proves the request passed the
    // bypass and was gated by the internal HMAC, the real auth boundary.
    expect(await res.json()).toEqual({ error: "Unauthorized: invalid HMAC signature" });
    expect(fixture.fire).not.toHaveBeenCalled();
  });
});
