import { compare, compareSync, hashSync } from "bcryptjs";
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

export function shouldBypassBearerAuth(method: string, path: string): boolean {
  if (method === "OPTIONS") {
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
  return path === "/api/health";
}

declare module "express-serve-static-core" {
  interface Request {
    workspaceAuth?: WorkspaceAuthClaims;
  }
}

export function createRequireWorkspaceMiddleware(
  authCallback: WorkspaceAuthCallback,
  onReject?: (context: BearerAuthRejectContext) => void,
): RequestHandler {
  return (req, res, next) => {
    if (shouldBypassBearerAuth(req.method, req.path)) {
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
