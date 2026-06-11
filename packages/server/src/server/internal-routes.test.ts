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

// Reproduces the bootstrap double-mount: an EARLY clone-repo-only mount
// (no services) followed by a LATE service-equipped mount on the SAME app.
// Before the fix the early mount registered schedule-fire/webhook-fire
// unconditionally and won Express's matcher, returning its 503 "not
// configured" guard and shadowing the late handler. After the fix the early
// mount no longer registers the gated routes, so the late, service-equipped
// handler is reached.
function createDoubleMountedApp(services: {
  scheduleService?: unknown;
  scheduleStore?: unknown;
  triggerService?: unknown;
  triggerStore?: unknown;
}) {
  const app = express();
  // EARLY mount — clone-repo only, as bootstrap does pre-service.
  app.use(createInternalRoutes({ hmacKey: TEST_HMAC_KEY, logger }));
  // LATE mount — services injected, as bootstrap's mountLateInternalRoutes does.
  app.use(
    createInternalRoutes({
      hmacKey: TEST_HMAC_KEY,
      logger,
      ...(services as object),
    } as never),
  );
  return app;
}

describe("early/late double-mount shadow — webhook-fire", () => {
  it("valid HMAC + known trigger reaches the real handler and fires (not 503)", async () => {
    const fire = vi.fn(async () => ({ runId: "run-1", done: Promise.resolve() }));
    const trigger = { id: "trg_1", cloudOwnerWorkspaceId: null, cloudOwnerAccountId: null };
    const app = createDoubleMountedApp({
      triggerService: { fire },
      triggerStore: { get: vi.fn(async () => trigger) },
    });
    const body = JSON.stringify({ triggerId: "trg_1", payload: { hello: "world" } });

    const res = await makeRequest(app, {
      path: "/api/internal/webhook-fire",
      headers: { "X-Orchestra-Internal-HMAC": signBody(body) },
      body,
    });

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("bad HMAC returns 401 (past the 503 'not configured' shadow)", async () => {
    const fire = vi.fn(async () => {});
    const app = createDoubleMountedApp({
      triggerService: { fire },
      triggerStore: { get: vi.fn(async () => ({ id: "trg_1" })) },
    });
    const body = JSON.stringify({ triggerId: "trg_1" });

    const res = await makeRequest(app, {
      path: "/api/internal/webhook-fire",
      headers: {
        "X-Orchestra-Internal-HMAC":
          "0000000000000000000000000000000000000000000000000000000000000000",
      },
      body,
    });

    expect(res.status).toBe(401);
    expect(fire).not.toHaveBeenCalled();
  });
});

describe("early/late double-mount shadow — schedule-fire", () => {
  it("valid HMAC + known active schedule reaches the real handler and fires (not 503)", async () => {
    const fireOnceDetached = vi.fn(async () => ({ runId: "run-1", done: Promise.resolve() }));
    const schedule = { status: "active", cloudOwnerWorkspaceId: null, cloudOwnerAccountId: null };
    const app = createDoubleMountedApp({
      scheduleService: { fireOnceDetached },
      scheduleStore: { get: vi.fn(async () => schedule) },
    });
    const body = JSON.stringify({ scheduleId: "sch_1" });

    const res = await makeRequest(app, {
      path: "/api/internal/schedule-fire",
      headers: { "X-Orchestra-Internal-HMAC": signBody(body) },
      body,
    });

    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    expect(fireOnceDetached).toHaveBeenCalledTimes(1);
  });

  it("bad HMAC returns 401 (past the 503 'not configured' shadow)", async () => {
    const fireOnceDetached = vi.fn(async () => ({ runId: "run-1", done: Promise.resolve() }));
    const app = createDoubleMountedApp({
      scheduleService: { fireOnceDetached },
      scheduleStore: { get: vi.fn(async () => ({ status: "active" })) },
    });
    const body = JSON.stringify({ scheduleId: "sch_1" });

    const res = await makeRequest(app, {
      path: "/api/internal/schedule-fire",
      headers: {
        "X-Orchestra-Internal-HMAC":
          "0000000000000000000000000000000000000000000000000000000000000000",
      },
      body,
    });

    expect(res.status).toBe(401);
    expect(fireOnceDetached).not.toHaveBeenCalled();
  });
});

describe("module boundary", () => {
  it("createInternalRoutes is a function export", async () => {
    const mod = await import("./internal-routes.js");
    expect(typeof mod.createInternalRoutes).toBe("function");
  });
});
