import { describe, it, expect, vi } from "vitest";
import express from "express";
import crypto from "node:crypto";
import http from "node:http";
import pino from "pino";
import { createInternalRoutes } from "./internal-routes.js";

const TEST_HMAC_KEY = "test-internal-hmac-key";
const logger = pino({ level: "silent" });

function signBody(body: string): string {
  return crypto.createHmac("sha256", TEST_HMAC_KEY).update(body).digest("hex");
}

function createTestApp(overrides?: { hmacKey?: string; smClient?: unknown }) {
  const app = express();
  const mockSmClient = {
    send: vi.fn(async () => ({
      SecretString: "gho_test_github_token",
    })),
  };
  app.use(
    createInternalRoutes({
      hmacKey: overrides?.hmacKey ?? TEST_HMAC_KEY,
      logger,
      smClient: (overrides?.smClient ?? mockSmClient) as never,
    }),
  );
  return { app, mockSmClient };
}

async function makeRequest(
  app: express.Application,
  options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: addr.port,
          path: options.path,
          method: options.method ?? "POST",
          headers: {
            "Content-Type": "application/json",
            ...options.headers,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            server.close();
            try {
              resolve({ status: res.statusCode!, body: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode!, body: { raw: data } });
            }
          });
        },
      );
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
      if (options.body) req.write(options.body);
      req.end();
    });
  });
}

describe("POST /api/internal/clone-repo", () => {
  it("rejects requests with missing HMAC header", async () => {
    const { app } = createTestApp();
    const body = JSON.stringify({
      accountId: "acct_1",
      workspaceId: "ws_1",
      repoUrl: "https://github.com/user/repo",
    });

    const res = await makeRequest(app, {
      path: "/api/internal/clone-repo",
      body,
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/HMAC/i);
  });

  it("rejects requests with invalid HMAC signature", async () => {
    const { app } = createTestApp();
    const body = JSON.stringify({
      accountId: "acct_1",
      workspaceId: "ws_1",
      repoUrl: "https://github.com/user/repo",
    });

    const res = await makeRequest(app, {
      path: "/api/internal/clone-repo",
      headers: {
        "X-Orchestra-Internal-HMAC":
          "0000000000000000000000000000000000000000000000000000000000000000",
      },
      body,
    });

    expect(res.status).toBe(401);
  });

  it("rejects requests with invalid body schema", async () => {
    const { app } = createTestApp();
    const body = JSON.stringify({ accountId: "", workspaceId: "ws_1" });
    const hmac = signBody(body);

    const res = await makeRequest(app, {
      path: "/api/internal/clone-repo",
      headers: { "X-Orchestra-Internal-HMAC": hmac },
      body,
    });

    expect(res.status).toBe(400);
  });

  it("rejects non-GitHub repo URLs", async () => {
    const { app } = createTestApp();
    const body = JSON.stringify({
      accountId: "acct_1",
      workspaceId: "ws_1",
      repoUrl: "https://gitlab.com/user/repo",
    });
    const hmac = signBody(body);

    const res = await makeRequest(app, {
      path: "/api/internal/clone-repo",
      headers: { "X-Orchestra-Internal-HMAC": hmac },
      body,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/GitHub/i);
  });

  it("returns 500 when GitHub token fetch fails", async () => {
    const failingSmClient = {
      send: vi.fn(async () => {
        throw new Error("Secret not found");
      }),
    };

    const { app } = createTestApp({ smClient: failingSmClient });
    const body = JSON.stringify({
      accountId: "acct_1",
      workspaceId: "ws_1",
      repoUrl: "https://github.com/user/repo",
    });
    const hmac = signBody(body);

    const res = await makeRequest(app, {
      path: "/api/internal/clone-repo",
      headers: { "X-Orchestra-Internal-HMAC": hmac },
      body,
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/GitHub credentials/i);
  });

  it("fetches the GitHub token using the correct secret path", async () => {
    const { app, mockSmClient } = createTestApp();
    const body = JSON.stringify({
      accountId: "acct_42",
      workspaceId: "ws_test",
      repoUrl: "https://github.com/user/repo",
    });
    const hmac = signBody(body);

    await makeRequest(app, {
      path: "/api/internal/clone-repo",
      headers: { "X-Orchestra-Internal-HMAC": hmac },
      body,
    });

    expect(mockSmClient.send).toHaveBeenCalled();
    const callArg = mockSmClient.send.mock.calls[0][0] as { input: { SecretId: string } };
    expect(callArg.input.SecretId).toBe("orchestra/dev/account/acct_42/github-token");
  });

  it("attempts git clone after successful auth and token fetch", async () => {
    const { app } = createTestApp();
    const body = JSON.stringify({
      accountId: "acct_1",
      workspaceId: "ws_clone1",
      repoUrl: "https://github.com/user/repo",
    });
    const hmac = signBody(body);

    const res = await makeRequest(app, {
      path: "/api/internal/clone-repo",
      headers: { "X-Orchestra-Internal-HMAC": hmac },
      body,
    });

    // Clone will fail in test env (no real git target), but status should be
    // 500 from clone failure, not 401/400 — proves auth + parsing succeeded
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/clone/i);
  });
});

describe("module boundary", () => {
  it("createInternalRoutes is a function export", async () => {
    const mod = await import("./internal-routes.js");
    expect(typeof mod.createInternalRoutes).toBe("function");
  });
});
