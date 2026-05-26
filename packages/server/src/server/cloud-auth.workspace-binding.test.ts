import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type CryptoKey, generateKeyPair, SignJWT } from "jose";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { extractWsWorkspaceProtocol, extractWsWorkspaceToken } from "./auth.js";
import { createJwksWorkspaceAuthCallback } from "./cloud-auth.js";

// T-11 — probe 7 WebSocket variant (D-2 ACCEPTANCE carry-in).
//
// LEARNINGS.md 2026-05-25 "What's still uncertain / deferred for D-3+"
// flagged that D-2's probe 7 only hit HTTP /api/status; the rubric also
// mentions a WS-upgrade variant. cloud-auth.test.ts proves that
// validateWorkspaceToken rejects a cross-workspace JWT at the callback
// level. This file adds the integration capture: a WS upgrade with a
// cross-workspace token is rejected with close code 4401, the same
// WS_CLOSE_DAEMON_AUTH_FAILED constant the production
// websocket-server.ts uses (line 70 / 646 / 655).
//
// Capture artifact: D-3-plans/probe-7-ws-results.md.

const WS_CLOSE_DAEMON_AUTH_FAILED = 4401;
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

interface WsFixture {
  url: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  close: () => Promise<void>;
}

const SELF_WORKSPACE = "ws_self";
const SELF_ACCOUNT = "acc_self";
const OTHER_WORKSPACE = "ws_other";

async function buildWsFixture(): Promise<WsFixture> {
  const { privateKey, publicKey } = await makeKeypair();
  const callback = createJwksWorkspaceAuthCallback({
    jwksUrl: "http://unused.example/jwks",
    logger: silentLogger,
    expectedWorkspaceId: SELF_WORKSPACE,
    expectedAccountId: SELF_ACCOUNT,
    getKey: async () => publicKey,
  });

  const httpServer = createHttpServer();
  // Mirror the production WS-upgrade auth path from
  // websocket-server.ts:630-680 — same constant (4401), same close
  // semantics, same callback. The test exercises the integration of
  // (a) subprotocol parsing, (b) token extraction, (c) callback
  // validation, (d) close-code emission.
  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", async (ws, request) => {
    const protocol = extractWsWorkspaceProtocol(request.headers["sec-websocket-protocol"]);
    const token = extractWsWorkspaceToken(protocol);
    if (token === null) {
      ws.close(WS_CLOSE_DAEMON_AUTH_FAILED, "Workspace token required");
      return;
    }
    const claims = await callback.validateWorkspaceToken(token);
    if (!claims) {
      ws.close(WS_CLOSE_DAEMON_AUTH_FAILED, "Invalid workspace token");
      return;
    }
    // Authenticated — keep the socket open for the test to observe.
    ws.send(JSON.stringify({ ok: true, workspaceId: claims.workspaceId }));
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const address = httpServer.address() as AddressInfo;
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const close = async () => {
    wss.close();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      httpServer.close((err) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      });
    });
  };
  return { url, privateKey, publicKey, close };
}

function openSocketAndCaptureClose(
  url: string,
  subprotocol: string | undefined,
): Promise<{ code: number; reason: string; opened: boolean; firstMessage: string | null }> {
  return new Promise((resolve, reject) => {
    const ws = subprotocol ? new WebSocket(url, subprotocol) : new WebSocket(url);
    let opened = false;
    let firstMessage: string | null = null;
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("WS test timed out (5s)"));
    }, 5_000);
    ws.on("open", () => {
      opened = true;
    });
    ws.on("message", (data) => {
      firstMessage = data.toString();
      ws.close();
    });
    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString(), opened, firstMessage });
    });
    ws.on("error", () => {
      // Suppress error-then-close races; close event still fires.
    });
  });
}

describe("WS upgrade — cross-workspace token rejection (T-11, probe 7 WebSocket variant)", () => {
  let fixture: WsFixture;

  beforeEach(async () => {
    fixture = await buildWsFixture();
  });

  afterEach(async () => {
    await fixture.close();
  });

  test("own-tenant WS upgrade succeeds; server emits a welcome message", async () => {
    const token = await signWorkspaceJwt(fixture.privateKey, {
      account_id: SELF_ACCOUNT,
      workspace_id: SELF_WORKSPACE,
    });
    const result = await openSocketAndCaptureClose(fixture.url, `paseo.workspace.${token}`);
    expect(result.opened).toBe(true);
    expect(result.firstMessage).not.toBeNull();
    const parsed = JSON.parse(result.firstMessage!) as { ok: boolean; workspaceId: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.workspaceId).toBe(SELF_WORKSPACE);
  });

  test("cross-tenant WS upgrade is rejected with close code 4401", async () => {
    const crossTenant = await signWorkspaceJwt(fixture.privateKey, {
      account_id: SELF_ACCOUNT,
      workspace_id: OTHER_WORKSPACE,
    });
    const result = await openSocketAndCaptureClose(fixture.url, `paseo.workspace.${crossTenant}`);
    // Per lifecycle.md / observability.md:72, close code 4401 is the
    // canonical "Auth-failure" signal. The ws library opens the socket
    // before the server's first message — what matters is the close
    // code on the rejection.
    expect(result.code).toBe(WS_CLOSE_DAEMON_AUTH_FAILED);
    expect(result.reason).toBe("Invalid workspace token");
    expect(result.firstMessage).toBeNull();
  });

  test("WS upgrade without paseo.workspace.<jwt> subprotocol is rejected with 4401", async () => {
    const result = await openSocketAndCaptureClose(fixture.url, undefined);
    expect(result.code).toBe(WS_CLOSE_DAEMON_AUTH_FAILED);
    expect(result.reason).toBe("Workspace token required");
  });

  test("WS upgrade with a malformed subprotocol is rejected with 4401", async () => {
    const result = await openSocketAndCaptureClose(fixture.url, "paseo.bearer.something");
    expect(result.code).toBe(WS_CLOSE_DAEMON_AUTH_FAILED);
    expect(result.reason).toBe("Workspace token required");
  });

  test("WS upgrade with a wrong-account JWT is rejected with 4401 (mirrors HTTP probe 7)", async () => {
    const wrongAccount = await signWorkspaceJwt(fixture.privateKey, {
      account_id: "acc_other",
      workspace_id: SELF_WORKSPACE,
    });
    const result = await openSocketAndCaptureClose(fixture.url, `paseo.workspace.${wrongAccount}`);
    expect(result.code).toBe(WS_CLOSE_DAEMON_AUTH_FAILED);
    expect(result.reason).toBe("Invalid workspace token");
  });
});
