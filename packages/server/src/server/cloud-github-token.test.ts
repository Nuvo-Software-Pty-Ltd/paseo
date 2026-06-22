import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import pino from "pino";
import {
  GithubTokenProvider,
  buildGithubTokenEnvDefaults,
  _resetGithubTokenProviderForTest,
} from "./cloud-github-token.js";

const logger = pino({ level: "silent" });
const BASE = "https://auth.internal.example";
const HMAC = "test-internal-hmac-key";
const ACCOUNT = "acct_42";
const NOW = Date.parse("2026-06-22T00:00:00.000Z");

function makeProvider(opts: {
  fetchImpl: typeof fetch;
  clock?: () => number;
}) {
  return new GithubTokenProvider({
    authServiceBaseUrl: BASE,
    hmacKey: HMAC,
    accountId: ACCOUNT,
    logger,
    fetchImpl: opts.fetchImpl,
    nowMs: opts.clock ?? (() => NOW),
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GithubTokenProvider", () => {
  it("caches a fresh token — two getToken() calls hit auth only once", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ token: "gho_x", expiresAt: new Date(NOW + 3600_000).toISOString(), needsReauth: false }),
    ) as unknown as typeof fetch;
    const p = makeProvider({ fetchImpl });

    const a = await p.getToken();
    const b = await p.getToken();

    expect(a).toEqual({ token: "gho_x", needsReauth: false });
    expect(b).toEqual({ token: "gho_x", needsReauth: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the cached token nears expiry", async () => {
    let clock = NOW;
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ token: "gho_x", expiresAt: new Date(clock + 120_000).toISOString(), needsReauth: false }),
    ) as unknown as typeof fetch;
    const p = makeProvider({ fetchImpl, clock: () => clock });

    await p.getToken(); // caches; valid ~until NOW + 120s - skew
    clock = NOW + 110_000; // now within the skew window → must refetch
    await p.getToken();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("signs the body with HMAC and POSTs accountId to the github-token route", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ token: "gho_x", expiresAt: null, needsReauth: false }),
    ) as unknown as typeof fetch;
    const p = makeProvider({ fetchImpl });

    await p.getToken();

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`${BASE}/api/auth-internal/github-token`);
    expect((init as RequestInit).method).toBe("POST");
    const body = String((init as RequestInit).body);
    expect(JSON.parse(body)).toEqual({ accountId: ACCOUNT });
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["X-Orchestra-Internal-HMAC"]).toBe(
      createHmac("sha256", HMAC).update(body).digest("hex"),
    );
  });

  it("returns {token:null, needsReauth:false} and never throws when auth is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const p = makeProvider({ fetchImpl });

    await expect(p.getToken()).resolves.toEqual({ token: null, needsReauth: false });
  });

  it("serves the stale cached token when a later auth call fails", async () => {
    let fail = false;
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new Error("network");
      return jsonResponse({ token: "gho_cached", expiresAt: new Date(NOW + 1000).toISOString(), needsReauth: false });
    }) as unknown as typeof fetch;
    let clock = NOW;
    const p = makeProvider({ fetchImpl, clock: () => clock });

    await p.getToken(); // cache "gho_cached"
    fail = true;
    clock = NOW + 10_000; // force the cache to be considered stale → refetch → fails
    const res = await p.getToken();

    expect(res.token).toBe("gho_cached"); // falls back to the last known token
  });

  it("propagates needsReauth and keeps re-fetching while latched (no cache short-circuit)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ token: "gho_stale", expiresAt: new Date(NOW + 3600_000).toISOString(), needsReauth: true }),
    ) as unknown as typeof fetch;
    const p = makeProvider({ fetchImpl });

    const a = await p.getToken();
    const b = await p.getToken();

    expect(a).toEqual({ token: "gho_stale", needsReauth: true });
    expect(b.needsReauth).toBe(true);
    // needsReauth must not be cached as "fresh" — re-check every call so a
    // re-auth is picked up promptly.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("buildGithubTokenEnvDefaults (env-channel gating)", () => {
  const savedCloud = process.env.PASEO_CLOUD_MODE;
  const savedExpose = process.env.ORCHESTRA_EXPOSE_GITHUB_TOKEN;
  afterEach(() => {
    if (savedCloud === undefined) delete process.env.PASEO_CLOUD_MODE;
    else process.env.PASEO_CLOUD_MODE = savedCloud;
    if (savedExpose === undefined) delete process.env.ORCHESTRA_EXPOSE_GITHUB_TOKEN;
    else process.env.ORCHESTRA_EXPOSE_GITHUB_TOKEN = savedExpose;
    _resetGithubTokenProviderForTest();
  });

  it("returns {} when not in cloud mode", async () => {
    delete process.env.PASEO_CLOUD_MODE;
    expect(await buildGithubTokenEnvDefaults(logger)()).toEqual({});
  });

  it("returns {} in cloud mode when ORCHESTRA_EXPOSE_GITHUB_TOKEN is not 1", async () => {
    process.env.PASEO_CLOUD_MODE = "1";
    delete process.env.ORCHESTRA_EXPOSE_GITHUB_TOKEN;
    expect(await buildGithubTokenEnvDefaults(logger)()).toEqual({});
  });
});
