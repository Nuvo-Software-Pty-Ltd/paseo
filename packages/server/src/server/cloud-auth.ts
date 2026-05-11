import { AsyncLocalStorage } from "node:async_hooks";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type pino from "pino";
import { z } from "zod";
import type { WorkspaceAuthCallback, WorkspaceAuthClaims } from "./auth.js";

// Wire contract for the workspace JWT claims emitted by the Orchestra auth
// service. Intentionally LOCAL to the daemon — the AGPL fork must not import
// from `@orchestra/cloud-shared`, so this Zod schema is duplicated by design
// (open-core boundary). Keep the shape in sync with the auth service's
// `WorkspaceTokenClaimsSchema`.
const WorkspaceTokenClaimsSchema = z.object({
  account_id: z.string().min(1),
  workspace_id: z.string().min(1),
  iat: z.number(),
  exp: z.number(),
});

type WorkspaceTokenClaims = z.infer<typeof WorkspaceTokenClaimsSchema>;

export interface CreateJwksWorkspaceAuthCallbackOptions {
  jwksUrl: string;
  logger: pino.Logger;
  // Test seam: inject a key-resolver function instead of fetching JWKS over
  // the network. Production callers omit this; tests pass a key resolved from
  // a locally-generated keypair.
  getKey?: JWTVerifyGetKey;
}

export function createJwksWorkspaceAuthCallback(
  options: CreateJwksWorkspaceAuthCallbackOptions,
): WorkspaceAuthCallback {
  const logger = options.logger.child({ component: "cloud-auth" });
  const getKey =
    options.getKey ??
    createRemoteJWKSet(new URL(options.jwksUrl), {
      cacheMaxAge: 10 * 60 * 1000,
      cooldownDuration: 30_000,
    });

  return {
    async validateWorkspaceToken(token: string): Promise<WorkspaceAuthClaims | null> {
      if (!token) {
        return null;
      }
      let payload: WorkspaceTokenClaims;
      try {
        const verified = await jwtVerify(token, getKey, {
          algorithms: ["RS256"],
        });
        payload = WorkspaceTokenClaimsSchema.parse(verified.payload);
      } catch (error) {
        logger.warn({ err: error }, "Rejected workspace token");
        return null;
      }
      return {
        accountId: payload.account_id,
        workspaceId: payload.workspace_id,
        expiresAt: payload.exp,
      };
    },
  };
}

// AsyncLocalStorage-backed propagation for the validated workspace context.
//
// WHY: the agent provider's spawn site needs the workspace id to fetch the
// per-workspace Anthropic credential from Secrets Manager, but the call chain
// from the WS handler down into the Claude SDK invocation is many layers
// deep, and threading a parameter through every intermediate API
// (`AgentManager.createAgent`, `runAgent`, the LoopService, the
// ScheduleService) would touch the full server in a way that the seam refactor
// in Wave A explicitly avoided. AsyncLocalStorage propagates the context
// across `await` boundaries within a single inbound-request call chain — the
// WS handler wraps each inbound message in `workspaceAuthStorage.run(claims,
// () => …)` and any code path triggered by that handler observes the same
// context. This matches the design-out "workspace identity inferred from
// auth, never on the wire": the value is sourced from the validated JWT at
// the WS upgrade and never travels through any RPC payload.
//
// NB: scheduled / loop / persistent-agent-resume runs triggered outside an
// active WS handler will see `getStore() === undefined`. Cloud-mode spawn
// sites fail-loud in that case. D-1's hands-on gate is a single direct
// session flow, so this limitation is acceptable; later phases (D-3) will
// persist workspace ownership with the schedule/loop records and restore
// context at fire time.
export const workspaceAuthStorage = new AsyncLocalStorage<WorkspaceAuthClaims>();

export function getCurrentWorkspaceAuth(): WorkspaceAuthClaims | undefined {
  return workspaceAuthStorage.getStore();
}
