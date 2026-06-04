import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import express from "express";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createSelfHostWebhookReceiver } from "./self-host-receiver.js";
import type { TriggerService } from "./service.js";
import type { TriggerSecretStore } from "./secret-store.js";
import type { WebhookTrigger } from "./types.js";

const logger = pino({ level: "silent" });
const SECRET = "self-host-secret";
const WEBHOOK_ID = "wh_public";

function makeTrigger(): WebhookTrigger {
  return {
    id: "abc12345",
    webhookId: WEBHOOK_ID,
    name: null,
    prompt: "prompt",
    target: { type: "new-agent", config: { provider: "claude", cwd: "/repo" } },
    payloadTemplate: null,
    enabled: true,
    ingressUrl: `http://host/hooks/${WEBHOOK_ID}`,
    secretFingerprint: "secret",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    lastFiredAt: null,
    runs: [],
    cloudOwnerWorkspaceId: null,
    cloudOwnerAccountId: null,
  };
}

interface Fixture {
  url: string;
  close: () => Promise<void>;
  fire: ReturnType<typeof vi.fn>;
}

async function buildFixture(): Promise<Fixture> {
  const fire = vi.fn(async () => undefined);
  const triggerService = {
    getByWebhookId: async (id: string) => (id === WEBHOOK_ID ? makeTrigger() : null),
    fire,
  } as unknown as TriggerService;
  const secretStore: TriggerSecretStore = {
    get: async (id: string) => (id === WEBHOOK_ID ? SECRET : null),
    put: async () => {},
    delete: async () => {},
  };
  const app = express();
  app.use(
    createSelfHostWebhookReceiver({
      triggerService,
      secretStore,
      logger,
      now: () => new Date("2026-06-01T00:00:00.000Z"),
    }),
  );
  const httpServer = await new Promise<Server>((resolve) => {
    const s = createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    fire,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

function sign(rawBody: string, t: number, secret = SECRET): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

const NOW_S = Math.floor(new Date("2026-06-01T00:00:00.000Z").getTime() / 1000);

describe("self-host webhook receiver", () => {
  let fixture: Fixture;
  afterEach(async () => {
    if (fixture) await fixture.close();
  });

  test("valid signature → 200 and fire invoked with parsed payload", async () => {
    fixture = await buildFixture();
    const body = JSON.stringify({ action: "deploy" });
    const res = await fetch(`${fixture.url}/hooks/${WEBHOOK_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Paseo-Signature": sign(body, NOW_S) },
      body,
    });
    expect(res.status).toBe(200);
    expect(fixture.fire).toHaveBeenCalledTimes(1);
    expect(fixture.fire.mock.calls[0][1]).toEqual({ action: "deploy" });
  });

  test("bad signature → 401 with no spawn", async () => {
    fixture = await buildFixture();
    const body = JSON.stringify({ action: "deploy" });
    const res = await fetch(`${fixture.url}/hooks/${WEBHOOK_ID}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Paseo-Signature": `t=${NOW_S},v1=deadbeef`,
      },
      body,
    });
    expect(res.status).toBe(401);
    expect(fixture.fire).not.toHaveBeenCalled();
  });

  test("stale timestamp (replay) → 401", async () => {
    fixture = await buildFixture();
    const body = JSON.stringify({ action: "deploy" });
    const staleT = NOW_S - 3600;
    const res = await fetch(`${fixture.url}/hooks/${WEBHOOK_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Paseo-Signature": sign(body, staleT) },
      body,
    });
    expect(res.status).toBe(401);
    expect(fixture.fire).not.toHaveBeenCalled();
  });

  test("unknown webhookId → 401 (fails closed, no info leak)", async () => {
    fixture = await buildFixture();
    const body = "{}";
    const res = await fetch(`${fixture.url}/hooks/wh_unknown`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Paseo-Signature": sign(body, NOW_S) },
      body,
    });
    expect(res.status).toBe(401);
    expect(fixture.fire).not.toHaveBeenCalled();
  });
});
