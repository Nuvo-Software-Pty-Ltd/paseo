import type { AddressInfo } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import express from "express";
import { type CryptoKey, generateKeyPair, SignJWT } from "jose";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createRequireWorkspaceMiddleware } from "./auth.js";
import { createJwksWorkspaceAuthCallback } from "./cloud-auth.js";

// T-10 / T-11 (synthesis carryover): a regression suite asserting that
// the daemon's `requireWorkspaceAuth` middleware rejects cross-workspace
// JWTs at every HTTP route the cloud exposes. The D-2 ACCEPTANCE post-
// mortem (LEARNINGS.md 2026-05-25 (later)) caught a missed workspace_id
// binding via probe 7 on `/api/status`; PR #5 added the binding. This
// suite extends the coverage to:
//
//   - /api/status (probe 7 baseline — already validated in D-2)
//   - /api/files/download (T-10 acceptance criterion — D-3's file
//     download surface)
//   - /api/files/download/internal (T-16 surface)
//   - /mcp/agents POST + GET + DELETE (T-10 acceptance — the spawned
//     agent MCP callback route)
//   - /api/internal/schedule-fire (T-15 surface)
//
// The WS-upgrade variant of probe 7 lives in cloud-auth.test.ts which
// directly tests the JWT callback. The middleware test here is the
// HTTP-side complement — both layers must reject cross-tenant traffic.

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
  app.get("/api/files/download/internal/:tokenId", (req, res) => {
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
  app.post("/api/internal/schedule-fire", (_req, res) => {
    res.status(200).json({ ok: true });
  });

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

  test("/api/files/download/internal/:tokenId — cross-tenant JWT rejected (T-16 surface)", async () => {
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

  test("/api/internal/schedule-fire (T-15) — cross-tenant JWT rejected with 401", async () => {
    // T-15 mounts under /api/internal/* which is HMAC-validated in
    // production; this test asserts the workspace-binding layer
    // additionally rejects any JWT-bearing request whose workspace_id
    // claim does not match the daemon's binding (defense-in-depth).
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
      body: JSON.stringify({ workspaceId: SELF_WORKSPACE }),
    });
    expect(response.status).toBe(401);
  });

  test("requests without an Authorization header are rejected with 401", async () => {
    const response = await fetch(`${fixture.url}/mcp/agents`);
    expect(response.status).toBe(401);
  });
});
