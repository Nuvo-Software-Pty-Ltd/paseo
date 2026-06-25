import { compare, compareSync, hashSync } from "bcryptjs";
import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

export const DAEMON_PASSWORD_BCRYPT_COST = 12;

export interface DaemonAuthConfig {
  password?: string;
}

export interface BearerAuthRejectContext {
  path: string;
  method: string;
  hasToken: boolean;
}

interface BearerValidationInput {
  password: string | undefined;
  token: string | null;
}

export function isBearerTokenValid(input: BearerValidationInput): boolean {
  return isBearerTokenValidSync(input);
}

export async function isBearerTokenValidAsync(input: BearerValidationInput): Promise<boolean> {
  if (!input.password) {
    return true;
  }
  if (input.token === null) {
    return false;
  }

  return compare(input.token, input.password);
}

export function isBearerTokenValidSync(input: BearerValidationInput): boolean {
  if (!input.password) {
    return true;
  }
  if (input.token === null) {
    return false;
  }

  return compareSync(input.token, input.password);
}

export function hashDaemonPassword(password: string): string {
  return hashSync(password, DAEMON_PASSWORD_BCRYPT_COST);
}

export function extractHttpBearerToken(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const [scheme, ...tokenParts] = value.trim().split(/\s+/);
  if (scheme !== "Bearer" || tokenParts.length !== 1) {
    return null;
  }
  return tokenParts[0] ?? null;
}

export function extractWsBearerProtocol(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  for (const protocol of value.split(",")) {
    const trimmed = protocol.trim();
    const segments = trimmed.split(".");
    if (segments[0] === "paseo" && segments[1] === "bearer" && segments.length >= 3) {
      return trimmed;
    }
  }

  return null;
}

export function extractWsBearerToken(protocol: string | null): string | null {
  if (!protocol) {
    return null;
  }
  const segments = protocol.split(".");
  if (segments[0] !== "paseo" || segments[1] !== "bearer" || segments.length < 3) {
    return null;
  }
  return segments.slice(2).join(".");
}

// Cloud-mode WS subprotocol — `paseo.workspace.<jwt>`. Mirrors the bearer
// parsers above; the JWT itself contains dots so we re-join the tail after
// stripping the two-segment prefix.
export function extractWsWorkspaceProtocol(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  for (const protocol of value.split(",")) {
    const trimmed = protocol.trim();
    const segments = trimmed.split(".");
    if (segments[0] === "paseo" && segments[1] === "workspace" && segments.length >= 3) {
      return trimmed;
    }
  }

  return null;
}

export function extractWsWorkspaceToken(protocol: string | null): string | null {
  if (!protocol) {
    return null;
  }
  const segments = protocol.split(".");
  if (segments[0] !== "paseo" || segments[1] !== "workspace" || segments.length < 3) {
    return null;
  }
  return segments.slice(2).join(".");
}

export interface WorkspaceAuthClaims {
  accountId: string;
  workspaceId: string;
  expiresAt: number;
}

export interface WorkspaceAuthCallback {
  validateWorkspaceToken(token: string): Promise<WorkspaceAuthClaims | null>;
}

export function createRequireBearerMiddleware(
  auth: DaemonAuthConfig | undefined,
  onReject?: (context: BearerAuthRejectContext) => void,
): RequestHandler {
  const password = auth?.password;
  return (req, res, next) => {
    if (!password || shouldBypassBearerAuth(req.method, req.path)) {
      next();
      return;
    }

    void (async () => {
      try {
        const token = extractHttpBearerToken(req.header("authorization"));
        if (!(await isBearerTokenValidAsync({ password, token }))) {
          onReject?.({
            path: req.path,
            method: req.method,
            hasToken: token !== null,
          });
          res.status(401).json({ error: "Unauthorized" });
          return;
        }

        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

// Routes that authenticate via their own capability and therefore must not be
// gated a second time behind the DAEMON PASSWORD. These are bypassed only by
// the daemon-password gate (createRequireBearerMiddleware) — NOT by the
// workspace-token gate. A capability/download token replaces the password, but
// it does NOT replace the per-tenant workspace_id binding: in cloud mode these
// routes still must reject a validly-signed but cross-tenant JWT (T-10). See
// shouldBypassWorkspaceAuth below, which deliberately omits these.
const BEARER_AUTH_BYPASS_PATHS = new Set([
  // Guarded by a single-use download token (crypto-random UUID, 60s TTL,
  // consumed on first use) that is only ever issued over the
  // already-authenticated WebSocket. The token IS the capability for this
  // route. Requiring the daemon password on top of it breaks browser and
  // Electron downloads: those trigger the download via an anchor navigation,
  // which cannot attach an `Authorization` header. The download endpoint still
  // rejects requests without a valid token (400/403), so dropping the bearer
  // here does not make the route unauthenticated.
  "/api/files/download",
  // The daemon injects its own agents' Paseo MCP connections at this endpoint
  // (and connects its own per-client MCP client here). Those connections cannot
  // carry the daemon password — it is only known in plaintext when set via env,
  // never when set via the app — so the route authenticates them with a
  // per-daemon-run capability token instead (see isAgentMcpRequestAuthorized).
  // The token is injected only into local agent configs/sessions and never sent
  // to remote clients, and the route still rejects callers presenting neither
  // the token nor a valid daemon password, so dropping the global bearer here
  // does not make the endpoint unauthenticated.
  "/mcp/agents",
]);

// Bypass predicate shared by BOTH the daemon-password gate and the
// workspace-token (cross-tenant) gate: OPTIONS preflight, the self-host
// webhook receiver, the HMAC-authed internal routes, and the liveness probe.
// These authenticate by something OTHER than a workspace JWT (HMAC / nothing),
// so the workspace gate is the wrong boundary for them. Everything here was
// bypassed by the pre-merge workspace middleware too.
function shouldBypassAllBearerAuth(method: string, path: string): boolean {
  if (method === "OPTIONS") {
    return true;
  }
  // Unauthenticated liveness probe.
  if (path === "/api/health") {
    return true;
  }
  // D-3.5d — the self-host webhook receiver authenticates each request by
  // a per-trigger HMAC signature (not the daemon password), so it must
  // bypass the Bearer/workspace-token gate. The receiver itself fails
  // closed on a bad/missing signature. In cloud mode /hooks is not mounted
  // (the proprietary ingress handles inbound webhooks), so this is a
  // harmless 404 there.
  if (path.startsWith("/hooks/")) {
    return true;
  }
  // D-3.5d — internal service routes each verify their OWN per-request internal
  // HMAC signature (`X-Orchestra-Internal-HMAC`) and re-check the bound
  // PASEO_WORKSPACE_ID as defense-in-depth — see internal-routes.ts. They carry
  // an internal HMAC, NOT a daemon password or workspace-token JWT, so the
  // Bearer/workspace-token gate is the wrong boundary for them and must be
  // bypassed: the HMAC is the real auth boundary. Without this, the LATE
  // internal-routes mount (bootstrap.ts) — which sits BEHIND the auth
  // middleware — 401s every webhook-fire/schedule-fire/download with "invalid
  // workspace token". The early clone-repo mount escaped only by accident of
  // being mounted before the middleware; this makes the bypass explicit and
  // mount-order-independent. In cloud mode the proprietary ingress fails closed
  // on a bad signature before forwarding; the daemon handlers fail closed too.
  //
  // Two prefixes cover the four HMAC-authed routes: clone-repo, schedule-fire
  // and webhook-fire live under `/api/internal/`; the T-16 download redemption
  // route is mounted at `/api/files/download/internal/:tokenId`. The latter
  // prefix is deliberately specific so it does NOT match the workspace-token-
  // authed `/api/files/download` query-param route (bootstrap.ts), which stays
  // gated.
  if (path.startsWith("/api/internal/") || path.startsWith("/api/files/download/internal/")) {
    return true;
  }
  return false;
}

// Daemon-PASSWORD gate bypass: the shared set PLUS the capability-token /
// download-token routes that replace the password but NOT the workspace
// binding.
export function shouldBypassBearerAuth(method: string, path: string): boolean {
  if (shouldBypassAllBearerAuth(method, path)) {
    return true;
  }
  return BEARER_AUTH_BYPASS_PATHS.has(path);
}

// WORKSPACE-TOKEN (cross-tenant) gate bypass: ONLY the shared set. The
// capability-token routes in BEARER_AUTH_BYPASS_PATHS (`/mcp/agents`,
// `/api/files/download`) are deliberately NOT bypassed here — they must still
// reject a cross-tenant workspace JWT in cloud mode (T-10). Restoring this
// distinction (the merge collapsed both gates onto shouldBypassBearerAuth)
// reinstates the pre-merge workspace_id binding on the agent MCP control plane.
export function shouldBypassWorkspaceAuth(method: string, path: string): boolean {
  return shouldBypassAllBearerAuth(method, path);
}

/**
 * Constant-time check that the request's `Authorization: Bearer …` token equals
 * the per-daemon-run agent MCP capability token. Length-guarded first because
 * `timingSafeEqual` throws on differing buffer lengths. Returns false when no
 * capability token is configured or no bearer is present.
 */
export function bearerMatchesCapabilityToken(
  authorizationHeader: string | undefined,
  capabilityToken: string | null,
): boolean {
  if (capabilityToken === null) {
    return false;
  }
  const token = extractHttpBearerToken(authorizationHeader);
  if (token === null) {
    return false;
  }
  const provided = Buffer.from(token);
  const expected = Buffer.from(capabilityToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * Authorizes a request to the Agent MCP endpoint (/mcp/agents), which is exempt
 * from the global daemon-password middleware. Accepts either the per-daemon-run
 * capability token the daemon injects into its own agents' configs and MCP
 * client, or a valid daemon-password bearer (so existing password-authenticated
 * callers keep working). When no daemon password is configured the endpoint is
 * open, matching the global middleware's behavior.
 */
export async function isAgentMcpRequestAuthorized(input: {
  password: string | undefined;
  capabilityToken: string | null;
  authorizationHeader: string | undefined;
}): Promise<boolean> {
  if (!input.password) {
    return true;
  }
  if (bearerMatchesCapabilityToken(input.authorizationHeader, input.capabilityToken)) {
    return true;
  }
  const token = extractHttpBearerToken(input.authorizationHeader);
  return isBearerTokenValidAsync({ password: input.password, token });
}

declare module "express-serve-static-core" {
  interface Request {
    workspaceAuth?: WorkspaceAuthClaims;
  }
}

export interface RequireWorkspaceMiddlewareOptions {
  onReject?: (context: BearerAuthRejectContext) => void;
  /**
   * Capability-credential escape hatch for the agent MCP control plane
   * (`/mcp/agents`). In cloud mode this gate is the ONLY HTTP auth boundary,
   * and `/mcp/agents` must reject a validly-signed but cross-tenant workspace
   * JWT (T-10) — so it cannot be globally bypassed. But the daemon's own
   * agents connect to that route over loopback carrying a per-daemon-run
   * capability token (a UUID, NOT a workspace JWT). This predicate lets such
   * trusted self-connections through to the route handler (which performs its
   * own `isAgentMcpRequestAuthorized` check); a cross-tenant attacker has no
   * capability token, so the JWT path below still denies them. Returns true to
   * admit the request without a workspace JWT.
   */
  isCapabilityAuthorized?: (req: Parameters<RequestHandler>[0]) => boolean;
}

export function createRequireWorkspaceMiddleware(
  authCallback: WorkspaceAuthCallback,
  onRejectOrOptions?:
    | ((context: BearerAuthRejectContext) => void)
    | RequireWorkspaceMiddlewareOptions,
): RequestHandler {
  const options: RequireWorkspaceMiddlewareOptions =
    typeof onRejectOrOptions === "function"
      ? { onReject: onRejectOrOptions }
      : (onRejectOrOptions ?? {});
  const { onReject, isCapabilityAuthorized } = options;
  return (req, res, next) => {
    if (shouldBypassWorkspaceAuth(req.method, req.path)) {
      next();
      return;
    }

    // Trusted capability-token self-connection (see
    // RequireWorkspaceMiddlewareOptions.isCapabilityAuthorized). The route
    // handler still authorizes; we only decline to require a workspace JWT.
    if (isCapabilityAuthorized?.(req)) {
      next();
      return;
    }

    void (async () => {
      try {
        const token = extractHttpBearerToken(req.header("authorization"));
        if (token === null) {
          onReject?.({ path: req.path, method: req.method, hasToken: false });
          res.status(401).json({ error: "Unauthorized" });
          return;
        }
        const claims = await authCallback.validateWorkspaceToken(token);
        if (!claims) {
          onReject?.({ path: req.path, method: req.method, hasToken: true });
          res.status(401).json({ error: "Unauthorized" });
          return;
        }
        req.workspaceAuth = claims;
        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}
