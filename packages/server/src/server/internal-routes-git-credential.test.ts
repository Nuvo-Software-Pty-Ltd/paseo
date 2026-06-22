import { describe, it, expect } from "vitest";
import express from "express";
import http from "node:http";
import pino from "pino";
import { createInternalRoutes } from "./internal-routes.js";

const logger = pino({ level: "silent" });
const NONCE = "nonce-abc-123";

function appWith(opts: {
  nonce?: string;
  getter?: () => Promise<{ token: string | null; needsReauth: boolean }>;
}): express.Application {
  const app = express();
  app.use(
    createInternalRoutes({
      hmacKey: "hmac-not-used-by-this-route",
      logger,
      credentialNonce: opts.nonce,
      githubTokenGetter: opts.getter,
    }),
  );
  return app;
}

function getCred(
  app: express.Application,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: addr.port,
          path: "/api/internal/git-credential",
          method: "GET",
          headers,
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode!, text: data });
          });
        },
      );
      req.on("error", (e) => {
        server.close();
        reject(e);
      });
      req.end();
    });
  });
}

describe("GET /api/internal/git-credential (nonce-gated, NOT HMAC)", () => {
  it("401 when the nonce header is missing", async () => {
    const app = appWith({
      nonce: NONCE,
      getter: async () => ({ token: "gho_x", needsReauth: false }),
    });
    expect((await getCred(app)).status).toBe(401);
  });

  it("401 when the nonce is wrong", async () => {
    const app = appWith({
      nonce: NONCE,
      getter: async () => ({ token: "gho_x", needsReauth: false }),
    });
    expect((await getCred(app, { "X-Paseo-Cred-Nonce": "wrong" })).status).toBe(401);
  });

  it("returns git credential output for a correct nonce (no HMAC header required)", async () => {
    const app = appWith({
      nonce: NONCE,
      getter: async () => ({ token: "gho_fresh", needsReauth: false }),
    });
    const res = await getCred(app, { "X-Paseo-Cred-Nonce": NONCE });
    expect(res.status).toBe(200);
    expect(res.text).toBe("username=x-access-token\npassword=gho_fresh\n");
  });

  it("returns EMPTY creds when a re-auth is required (git fails visibly, not with a dead token)", async () => {
    const app = appWith({
      nonce: NONCE,
      getter: async () => ({ token: "gho_stale", needsReauth: true }),
    });
    const res = await getCred(app, { "X-Paseo-Cred-Nonce": NONCE });
    expect(res.status).toBe(200);
    expect(res.text).toBe("");
  });

  it("is NOT registered when no nonce is configured (404 — opt-in, on-host/self-host no-op)", async () => {
    const app = appWith({});
    expect((await getCred(app, { "X-Paseo-Cred-Nonce": NONCE })).status).toBe(404);
  });
});
