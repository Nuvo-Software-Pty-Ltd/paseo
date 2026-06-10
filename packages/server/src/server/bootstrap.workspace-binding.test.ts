import type { AddressInfo } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import express from "express";
import { type CryptoKey, generateKeyPair, SignJWT } from "jose";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createRequireWorkspaceMiddleware } from "./auth.js";
import { createJwksWorkspaceAuthCallback } from "./cloud-auth.js";
import { createInternalRoutes } from "./internal-routes.js";
import type { ScheduleService } from "./schedule/service.js";
import type { ScheduleStore } from "./schedule/store.js";

// T-10 / T-11 (synthesis carryover): a regression suite asserting that
// the daemon's `requireWorkspaceAuth` middleware rejects cross-workspace
// JWTs at every JWT-authed HTTP route the cloud exposes. The D-2 ACCEPTANCE
// post-mortem (LEARNINGS.md 2026-05-25 (later)) caught a missed workspace_id
// binding via probe 7 on `/api/status`; PR #5 added the binding. This
// suite covers:
//
//   - /api/status (probe 7 baseline — already validated in D-2)
//   - /api/files/download (T-10 acceptance criterion — D-3's file
//     download surface)
//   - /mcp/agents POST + GET + DELETE (T-10 acceptance — the spawned
//     agent MCP callback route)
//
// The WS-upgrade variant of probe 7 lives in cloud-auth.test.ts which
// directly tests the JWT callback. The middleware test here is the
// HTTP-side complement — both layers must reject cross-tenant traffic.
//
// D-3.5d — the HMAC-authed internal routes (`/api/internal/*` and
// `/api/files/download/internal/*`) are DELIBERATELY exempt from the
// workspace-token gate (shouldBypassBearerAuth bypasses them), because their
// real auth boundary is the per-request internal HMAC, not a workspace JWT —
// the legitimate cloud caller forwards an HMAC and NO JWT. The two tests for
// those surfaces below therefore mount the REAL internal-routes HMAC layer and
// assert it rejects any request lacking a valid internal HMAC (401), regardless
// of the JWT it carries. Their cross-tenant defense-in-depth — the in-handler
// expectedWorkspaceId check once a valid HMAC IS present — is covered by
// internal-routes-schedule-fire.test.ts and internal-routes-webhook-fire.test.ts
// ("cross-workspace … → 403"), and the bypass-reachability path by
// internal-routes-auth-bypass.e2e.test.ts.

const silentLogger = pino({ level: "silent" });

async function makeKeypair(): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
  const pair = await generateKeyPair("RS256");
  return pair as { privateKey: CryptoKey; publicKey: CryptoKey };
}

async function signWorkspaceJwt(
  privateKey: CryptoKey,
  claims: { account_id: string; workspace_id: string },
): Promise<string> {
  return new SignJWT({
    account_id: claims.account_id,
    workspace_id: claims.workspace_id,
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

interface TestFixture {
  url: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  close: () => Promise<void>;
}

const SELF_WORKSPACE = "ws_self";
const SELF_ACCOUNT = "acc_self";
const OTHER_WORKSPACE = "ws_other";

async function buildFixture(): Promise<TestFixture> {
  const { privateKey, publicKey } = await makeKeypair();
  const callback = createJwksWorkspaceAuthCallback({
    jwksUrl: "http://unused.example/jwks",
    logger: silentLogger,
    expectedWorkspaceId: SELF_WORKSPACE,
    expectedAccountId: SELF_ACCOUNT,
    getKey: async () => publicKey,
  });
  const app = express();
  app.use(express.json());
  // COMPAT(workspace-jwt-binding): daemon-side workspace_id binding;
  // defense-in-depth alongside PLAN-cdk-infra's SG/PrivateLink
  // isolation. Both layers must reject cross-tenant traffic; if either
  // is bypassed, the other still denies.
  app.use(createRequireWorkspaceMiddleware(callback));

  // Stub handlers for every cloud HTTP route the daemon exposes.
  app.get("/api/status", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.get("/api/files/download/:tokenId", (req, res) => {
    res.status(200).json({ tokenId: req.params.tokenId });
  });
  app.get("/mcp/agents", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.post("/mcp/agents", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.delete("/mcp/agents", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // D-3.5d — the HMAC-authed internal routes bypass the workspace gate, so we
  // mount the REAL internal-routes layer here (mirroring bootstrap's late
  // mount). A request reaching these handlers without a valid internal HMAC is
  // rejected by `verifyHmac` (401), which is the actual auth boundary. The
  // service/dep stubs only matter once the HMAC passes — never reached for the
  // no-HMAC cross-tenant probes below.
  app.use(
    createInternalRoutes({
      hmacKey: "test-internal-hmac-key",
      logger: silentLogger,
      scheduleService: {} as unknown as ScheduleService,
      scheduleStore: {} as unknown as ScheduleStore,
      expectedWorkspaceId: SELF_WORKSPACE,
      authInternalUrl: "http://unused.example",
      workspaceRoot: "/workspace/ws_self",
    }),
  );

  const server = await new Promise<HttpServer>((resolve) => {
    const s = createHttpServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  const close = async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
  return { url, privateKey, publicKey, close };
}

describe("workspace-binding middleware — defense-in-depth at every HTTP route", () => {
  let fixture: TestFixture;

  beforeEach(async () => {
    fixture = await buildFixture();
  });

  afterEach(async () => {
    await fixture.close();
  });

  test("/api/status — own-tenant JWT accepted (probe 7 baseline; D-2 ACCEPTANCE)", async () => {
    const token = await signWorkspaceJwt(fixture.privateKey, {
      account_id: SELF_ACCOUNT,
      workspace_id: SELF_WORKSPACE,
    });
    const response = await fetch(`${fixture.url}/api/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
  });

  test("/api/status — cross-tenant JWT rejected with 401", async () => {
    const crossTenant = await signWorkspaceJwt(fixture.privateKey, {
      account_id: SELF_ACCOUNT,
      workspace_id: OTHER_WORKSPACE,
    });
    const response = await fetch(`${fixture.url}/api/status`, {
      headers: { Authorization: `Bearer ${crossTenant}` },
    });
    expect(response.status).toBe(401);
  });

  test("/api/files/download/:tokenId — cross-tenant JWT rejected (T-10 D-3 surface)", async () => {
    const crossTenant = await signWorkspaceJwt(fixture.privateKey, {
      account_id: SELF_ACCOUNT,
      workspace_id: OTHER_WORKSPACE,
    });
    const response = await fetch(`${fixture.url}/api/files/download/some-token`, {
      headers: { Authorization: `Bearer ${crossTenant}` },
    });
    expect(response.status).toBe(401);
  });

  test("/api/files/download/internal/:tokenId — gated by internal HMAC, not the JWT (T-16 surface)", async () => {
    // This route bypasses the workspace-token gate (D-3.5d): a JWT alone — even
    // a cross-tenant one — cannot reach the file stream. With no internal HMAC
    // header, the route's own `verifyHmac` rejects with 401. The JWT is
    // irrelevant; the HMAC is the boundary.
    const crossTenant = await signWorkspaceJwt(fixture.privateKey, {
      account_id: SELF_ACCOUNT,
      workspace_id: OTHER_WORKSPACE,
    });
    const response = await fetch(`${fixture.url}/api/files/download/internal/some-token`, {
      headers: { Authorization: `Bearer ${crossTenant}` },
    });
    expect(response.status).toBe(401);
  });

  test("/mcp/agents POST — cross-tenant JWT rejected (T-10 acceptance)", async () => {
    const crossTenant = await signWorkspaceJwt(fixture.privateKey, {
      account_id: SELF_ACCOUNT,
      workspace_id: OTHER_WORKSPACE,
    });
    const response = await fetch(`${fixture.url}/mcp/agents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${crossTenant}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(response.status).toBe(401);
  });

  test("/mcp/agents GET — cross-tenant JWT rejected (T-10 acceptance)", async () => {
    const crossTenant = await signWorkspaceJwt(fixture.privateKey, {
      account_id: SELF_ACCOUNT,
      workspace_id: OTHER_WORKSPACE,
    });
    const response = await fetch(`${fixture.url}/mcp/agents`, {
      headers: { Authorization: `Bearer ${crossTenant}` },
    });
    expect(response.status).toBe(401);
  });

  test("/mcp/agents DELETE — cross-tenant JWT rejected (T-10 acceptance)", async () => {
    const crossTenant = await signWorkspaceJwt(fixture.privateKey, {
      account_id: SELF_ACCOUNT,
      workspace_id: OTHER_WORKSPACE,
    });
    const response = await fetch(`${fixture.url}/mcp/agents`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${crossTenant}` },
    });
    expect(response.status).toBe(401);
  });

  test("/mcp/agents POST — own-tenant JWT accepted (regression control)", async () => {
    const token = await signWorkspaceJwt(fixture.privateKey, {
      account_id: SELF_ACCOUNT,
      workspace_id: SELF_WORKSPACE,
    });
    const response = await fetch(`${fixture.url}/mcp/agents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(response.status).toBe(200);
  });

  test("/api/internal/schedule-fire (T-15) — gated by internal HMAC, not the JWT", async () => {
    // T-15 mounts under /api/internal/*, which is HMAC-validated and
    // DELIBERATELY exempt from the workspace-token gate (D-3.5d) — the
    // legitimate lifecycle-worker caller forwards an internal HMAC and no JWT.
    // A JWT-bearing request (even cross-tenant) with no internal HMAC is
    // rejected 401 by the route's own `verifyHmac`. Cross-tenant defense once a
    // valid HMAC is present (the in-handler expectedWorkspaceId check) is
    // covered in internal-routes-schedule-fire.test.ts.
    const crossTenant = await signWorkspaceJwt(fixture.privateKey, {
      account_id: SELF_ACCOUNT,
      workspace_id: OTHER_WORKSPACE,
    });
    const response = await fetch(`${fixture.url}/api/internal/schedule-fire`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${crossTenant}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ scheduleId: "sched_x" }),
    });
    expect(response.status).toBe(401);
  });

  test("requests without an Authorization header are rejected with 401", async () => {
    const response = await fetch(`${fixture.url}/mcp/agents`);
    expect(response.status).toBe(401);
  });
});
