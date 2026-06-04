import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import express from "express";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createInternalRoutes } from "./internal-routes.js";
import type { TriggerService } from "./trigger/service.js";
import type { WebhookTriggerStore } from "./trigger/store.js";
import type { WebhookTrigger } from "./trigger/types.js";

// D-3.5d — `/api/internal/webhook-fire`. The cloud ingress forwards the
// INTERNAL triggerId (FIX VERIFY-3.5d #2); the daemon does a direct
// store.get(triggerId), re-checks the workspace (defense in depth), and
// fires through TriggerService.

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

async function buildFixture(opts: {
  triggerByGetId: Record<string, WebhookTrigger | null>;
  expectedWorkspaceId?: string;
}): Promise<Fixture> {
  const hmacKey = "test-hmac-key";
  const fire = vi.fn(async () => undefined);
  const triggerStore: WebhookTriggerStore = {
    list: async () => [],
    get: async (id: string) => opts.triggerByGetId[id] ?? null,
    getByWebhookId: async () => null,
    create: async () => makeTrigger(),
    put: async () => {},
    delete: async () => {},
  };
  const triggerService = { fire } as unknown as TriggerService;

  const app = express();
  app.use(
    createInternalRoutes({
      hmacKey,
      logger,
      triggerService,
      triggerStore,
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
    fire,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

function signBody(key: string, body: string): string {
  return createHmac("sha256", key).update(body).digest("hex");
}

async function post(fixture: Fixture, body: string, hmac: string): Promise<Response> {
  return fetch(`${fixture.url}/api/internal/webhook-fire`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Orchestra-Internal-HMAC": hmac },
    body,
  });
}

describe("POST /api/internal/webhook-fire (D-3.5d)", () => {
  let fixture: Fixture;
  afterEach(async () => {
    if (fixture) await fixture.close();
  });

  test("HMAC-valid + matching workspace → 200 and fire invoked with the resolved trigger", async () => {
    fixture = await buildFixture({
      triggerByGetId: { abc12345: makeTrigger() },
      expectedWorkspaceId: "ws_self",
    });
    const body = JSON.stringify({ triggerId: "abc12345", payload: { ping: 1 } });
    const res = await post(fixture, body, signBody(fixture.hmacKey, body));
    expect(res.status).toBe(200);
    expect(fixture.fire).toHaveBeenCalledTimes(1);
    expect(fixture.fire.mock.calls[0][0]).toMatchObject({ id: "abc12345" });
    expect(fixture.fire.mock.calls[0][1]).toEqual({ ping: 1 });
  });

  test("HMAC-invalid → 401, no fire", async () => {
    fixture = await buildFixture({ triggerByGetId: { abc12345: makeTrigger() } });
    const body = JSON.stringify({ triggerId: "abc12345" });
    const res = await post(fixture, body, "deadbeef".repeat(8));
    expect(res.status).toBe(401);
    expect(fixture.fire).not.toHaveBeenCalled();
  });

  test("cross-workspace trigger → 403 (defense-in-depth)", async () => {
    fixture = await buildFixture({
      triggerByGetId: { abc12345: makeTrigger({ cloudOwnerWorkspaceId: "ws_other" }) },
      expectedWorkspaceId: "ws_self",
    });
    const body = JSON.stringify({ triggerId: "abc12345" });
    const res = await post(fixture, body, signBody(fixture.hmacKey, body));
    expect(res.status).toBe(403);
    expect(fixture.fire).not.toHaveBeenCalled();
  });

  test("unknown triggerId → 404", async () => {
    fixture = await buildFixture({ triggerByGetId: {}, expectedWorkspaceId: "ws_self" });
    const body = JSON.stringify({ triggerId: "missing" });
    const res = await post(fixture, body, signBody(fixture.hmacKey, body));
    expect(res.status).toBe(404);
    expect(fixture.fire).not.toHaveBeenCalled();
  });

  test("body carrying webhookId instead of triggerId → 400 (strict contract)", async () => {
    fixture = await buildFixture({ triggerByGetId: {} });
    const body = JSON.stringify({ webhookId: "wh_public" });
    const res = await post(fixture, body, signBody(fixture.hmacKey, body));
    expect(res.status).toBe(400);
  });
});
