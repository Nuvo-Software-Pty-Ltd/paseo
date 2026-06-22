import { createHmac } from "node:crypto";
import type { Logger } from "pino";
import { isPaseoCloudMode } from "./paseo-env.js";

// Daemon-side provider of a FRESH GitHub access token. It asks the auth service's
// HMAC-signed internal route (which owns the client_secret + refresh_token and
// refreshes server-side) rather than reading Secrets Manager directly, so a
// token that expired since daemon boot is recovered on the next access. Caches
// with the token's own expiry so spawns don't hammer auth, but re-fetches before
// expiry (and always while needsReauth is latched). Never throws — a refresh
// outage must not block git/agent/terminal work (mirrors the
// maybeExposeGithubTokenToEnv "never throws" contract).

// Re-fetch this far before the access token actually expires, so an in-flight
// git op never races the boundary.
const DAEMON_SKEW_MS = 60_000;
// For legacy non-expiring tokens (expiresAt = null) there is no expiry to key
// off, so re-check auth on this cadence to pick up a re-auth / needsReauth flip.
const SOFT_TTL_MS = 60_000;

export interface GithubTokenProviderDeps {
  authServiceBaseUrl: string;
  hmacKey: string;
  accountId: string;
  logger: Logger;
  // Test seams.
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

export interface GithubToken {
  token: string | null;
  needsReauth: boolean;
}

interface AuthGithubTokenResponse {
  token: string | null;
  expiresAt: string | null;
  needsReauth: boolean;
}

interface CacheEntry {
  token: string | null;
  expiresAtMs: number | null;
  needsReauth: boolean;
  fetchedAtMs: number;
}

export class GithubTokenProvider {
  private cache: CacheEntry | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;

  constructor(private readonly deps: GithubTokenProviderDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.nowMs = deps.nowMs ?? Date.now;
  }

  async getToken(): Promise<GithubToken> {
    const now = this.nowMs();
    const c = this.cache;
    // A latched needsReauth must NOT serve from cache — re-check so a fresh
    // sign-in is honored promptly.
    if (c && !c.needsReauth) {
      const valid =
        c.expiresAtMs !== null
          ? now < c.expiresAtMs - DAEMON_SKEW_MS
          : now - c.fetchedAtMs < SOFT_TTL_MS;
      if (valid) return { token: c.token, needsReauth: c.needsReauth };
    }

    const fresh = await this.fetchFromAuth();
    if (fresh === null) {
      // Auth unreachable — serve the last known token rather than blocking work.
      if (c) return { token: c.token, needsReauth: c.needsReauth };
      return { token: null, needsReauth: false };
    }

    this.cache = {
      token: fresh.token,
      expiresAtMs: fresh.expiresAt ? Date.parse(fresh.expiresAt) : null,
      needsReauth: fresh.needsReauth,
      fetchedAtMs: now,
    };
    return { token: fresh.token, needsReauth: fresh.needsReauth };
  }

  private async fetchFromAuth(): Promise<AuthGithubTokenResponse | null> {
    const url = `${this.deps.authServiceBaseUrl.replace(/\/$/, "")}/api/auth-internal/github-token`;
    const body = JSON.stringify({ accountId: this.deps.accountId });
    const hmac = createHmac("sha256", this.deps.hmacKey).update(body).digest("hex");

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Orchestra-Internal-HMAC": hmac },
        body,
      });
    } catch (err) {
      this.deps.logger.warn({ err }, "github-token provider: auth fetch failed");
      return null;
    }
    if (!res.ok) {
      this.deps.logger.warn({ status: res.status }, "github-token provider: auth returned non-2xx");
      return null;
    }
    try {
      const json = (await res.json()) as Partial<AuthGithubTokenResponse>;
      return {
        token: typeof json.token === "string" ? json.token : null,
        expiresAt: typeof json.expiresAt === "string" ? json.expiresAt : null,
        needsReauth: json.needsReauth === true,
      };
    } catch (err) {
      this.deps.logger.warn({ err }, "github-token provider: bad auth response body");
      return null;
    }
  }
}

// Lazy module-level singleton bound to the daemon's cloud env. Returns null when
// the internal wiring isn't present (self-host / on-host) so callers no-op.
let singleton: GithubTokenProvider | null = null;

export function getGithubTokenProvider(logger: Logger): GithubTokenProvider | null {
  if (singleton) return singleton;
  const authServiceBaseUrl = process.env.ORCHESTRA_AUTH_INTERNAL_URL?.trim();
  const hmacKey = process.env.ORCHESTRA_INTERNAL_HMAC_KEY?.trim();
  const accountId = process.env.PASEO_ACCOUNT_ID?.trim();
  if (!authServiceBaseUrl || !hmacKey || !accountId) return null;
  singleton = new GithubTokenProvider({ authServiceBaseUrl, hmacKey, accountId, logger });
  return singleton;
}

export function _resetGithubTokenProviderForTest(): void {
  singleton = null;
}

// Env-channel overlay for createScopedEnvResolver: a `() => Promise<env>` that
// yields a FRESH GITHUB_TOKEN/GH_TOKEN per spawn so `gh`/toolchain managers in
// agents + terminals get a refreshed token. Gated identically to
// maybeExposeGithubTokenToEnv (cloud mode + ORCHESTRA_EXPOSE_GITHUB_TOKEN=1);
// returns {} otherwise, on needsReauth, or on any failure (never throws — a
// re-auth/outage must not block a spawn).
export function buildGithubTokenEnvDefaults(logger: Logger): () => Promise<Record<string, string>> {
  return async (): Promise<Record<string, string>> => {
    if (!isPaseoCloudMode()) return {};
    if (process.env.ORCHESTRA_EXPOSE_GITHUB_TOKEN?.trim() !== "1") return {};
    const provider = getGithubTokenProvider(logger);
    if (!provider) return {};
    try {
      const { token, needsReauth } = await provider.getToken();
      if (!token || needsReauth) return {};
      return { GITHUB_TOKEN: token, GH_TOKEN: token };
    } catch (err) {
      logger.warn({ err }, "github token env overlay: getToken failed");
      return {};
    }
  };
}
