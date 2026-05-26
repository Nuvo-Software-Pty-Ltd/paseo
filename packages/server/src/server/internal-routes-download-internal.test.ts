import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createInternalRoutes } from "./internal-routes.js";

// T-16 — `/api/files/download/internal/:tokenId` daemon route. Auth's
// public `GET /api/files/download/:tokenId` 302-redirects to this
// route on the per-workspace daemon's ALB target.

const logger = pino({ level: "silent" });

interface Fixture {
  url: string;
  close: () => Promise<void>;
  hmacKey: string;
  workspaceRoot: string;
  authCalls: { url: string; body: string }[];
}

async function buildFixture(opts: {
  expectedWorkspaceId: string;
  checkTokenImpl?: (body: { tokenId: string; expectedWorkspaceId: string }) => {
    status: number;
    body: unknown;
  };
}): Promise<Fixture> {
  const hmacKey = "test-hmac";
  const workspaceRoot = mkdtempSync(join(tmpdir(), "dl-internal-test-"));
  // Default check stub: validate + return filePath relative to workspaceRoot.
  const authCalls: { url: string; body: string }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    authCalls.push({ url, body });
    if (opts.checkTokenImpl) {
      const parsed = JSON.parse(body);
      const result = opts.checkTokenImpl(parsed);
      return new Response(JSON.stringify(result.body), { status: result.status });
    }
    // Default: validate + return relative path to "file.txt".
    return new Response(
      JSON.stringify({
        valid: true,
        workspaceId: opts.expectedWorkspaceId,
        filePath: "file.txt",
        expiresAt: "2026-12-31T23:59:59.000Z",
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const app = express();
  app.use(
    createInternalRoutes({
      hmacKey,
      logger,
      authInternalUrl: "https://auth.example.com",
      expectedWorkspaceId: opts.expectedWorkspaceId,
      workspaceRoot,
      fetchImpl,
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
    workspaceRoot,
    authCalls,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        rmSync(workspaceRoot, { recursive: true, force: true });
      }),
  };
}

function signEmpty(key: string): string {
  return createHmac("sha256", key).update("").digest("hex");
}

describe("GET /api/files/download/internal/:tokenId (T-16)", () => {
  let fixture: Fixture;
  afterEach(async () => {
    if (fixture) await fixture.close();
  });

  test("happy path: HMAC + auth-revalidate + stream file", async () => {
    fixture = await buildFixture({ expectedWorkspaceId: "ws_self" });
    writeFileSync(join(fixture.workspaceRoot, "file.txt"), "hello, downloaded!");
    const res = await fetch(`${fixture.url}/api/files/download/internal/tok-1`, {
      headers: {
        "X-Orchestra-Internal-HMAC": signEmpty(fixture.hmacKey),
      },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("hello, downloaded!");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain("file.txt");
  });

  test("HMAC-invalid → 401, no auth-revalidate hop", async () => {
    fixture = await buildFixture({ expectedWorkspaceId: "ws_self" });
    const res = await fetch(`${fixture.url}/api/files/download/internal/tok-1`, {
      headers: {
        "X-Orchestra-Internal-HMAC": "deadbeef".repeat(8),
      },
    });
    expect(res.status).toBe(401);
    // Auth was not contacted.
    expect(fixture.authCalls).toEqual([]);
  });

  test("auth says token invalid → 403", async () => {
    fixture = await buildFixture({
      expectedWorkspaceId: "ws_self",
      checkTokenImpl: () => ({ status: 200, body: { valid: false, reason: "expired" } }),
    });
    const res = await fetch(`${fixture.url}/api/files/download/internal/tok-1`, {
      headers: {
        "X-Orchestra-Internal-HMAC": signEmpty(fixture.hmacKey),
      },
    });
    expect(res.status).toBe(403);
  });

  test("auth returns workspaceId mismatch → 403 (defense-in-depth)", async () => {
    fixture = await buildFixture({
      expectedWorkspaceId: "ws_self",
      checkTokenImpl: () => ({
        status: 200,
        body: {
          valid: true,
          workspaceId: "ws_other",
          filePath: "file.txt",
        },
      }),
    });
    writeFileSync(join(fixture.workspaceRoot, "file.txt"), "x");
    const res = await fetch(`${fixture.url}/api/files/download/internal/tok-1`, {
      headers: {
        "X-Orchestra-Internal-HMAC": signEmpty(fixture.hmacKey),
      },
    });
    expect(res.status).toBe(403);
  });

  test("auth says filePath escapes workspace root → 400 (path traversal)", async () => {
    fixture = await buildFixture({
      expectedWorkspaceId: "ws_self",
      checkTokenImpl: () => ({
        status: 200,
        body: {
          valid: true,
          workspaceId: "ws_self",
          filePath: "../../etc/passwd",
        },
      }),
    });
    const res = await fetch(`${fixture.url}/api/files/download/internal/tok-1`, {
      headers: {
        "X-Orchestra-Internal-HMAC": signEmpty(fixture.hmacKey),
      },
    });
    expect(res.status).toBe(400);
  });

  test("file not found → 404", async () => {
    fixture = await buildFixture({
      expectedWorkspaceId: "ws_self",
      checkTokenImpl: () => ({
        status: 200,
        body: {
          valid: true,
          workspaceId: "ws_self",
          filePath: "missing.txt",
        },
      }),
    });
    const res = await fetch(`${fixture.url}/api/files/download/internal/tok-1`, {
      headers: {
        "X-Orchestra-Internal-HMAC": signEmpty(fixture.hmacKey),
      },
    });
    expect(res.status).toBe(404);
  });

  test("missing tokenId → 400", async () => {
    fixture = await buildFixture({ expectedWorkspaceId: "ws_self" });
    // Express treats `/api/files/download/internal/` as 404 (no
    // matching route). Test we don't crash on an empty path param —
    // there is no realistic way to invoke the route with empty
    // tokenId, so this scenario simply verifies the 404 path.
    const res = await fetch(`${fixture.url}/api/files/download/internal/`, {
      headers: {
        "X-Orchestra-Internal-HMAC": signEmpty(fixture.hmacKey),
      },
    });
    expect([404, 400]).toContain(res.status);
  });
});
