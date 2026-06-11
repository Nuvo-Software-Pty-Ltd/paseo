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
  // Workspace identity this daemon is bound to. Sourced from the per-task
  // env vars the cloud control plane injects at boot. After signature
  // verification we assert the token's claims match BOTH of these — the
  // signature alone is not sufficient because every workspace's token is
  // signed by the same auth-service keypair, so without claim binding a
  // valid token from workspace A would be accepted by workspace B's daemon.
  // We check account_id AND workspace_id (not just workspace_id) so that a
  // future workspace_id collision across accounts cannot defeat the binding.
  expectedWorkspaceId: string;
  expectedAccountId: string;
  // Test seam: inject a key-resolver function instead of fetching JWKS over
  // the network. Production callers omit this; tests pass a key resolved from
  // a locally-generated keypair.
  getKey?: JWTVerifyGetKey;
}

export type JwksWorkspaceAuthCallback = WorkspaceAuthCallback & {
  /**
   * Fire-and-forget hint to trigger the JWKS fetch before the first inbound
   * WS upgrade. Logs and swallows any error — pre-warm is best-effort and
   * must never block daemon startup or fail the container.
   */
  prewarm(): Promise<void>;
};

export function createJwksWorkspaceAuthCallback(
  options: CreateJwksWorkspaceAuthCallbackOptions,
): JwksWorkspaceAuthCallback {
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
      if (payload.workspace_id !== options.expectedWorkspaceId) {
        logger.warn(
          {
            expectedWorkspaceId: options.expectedWorkspaceId,
            receivedWorkspaceId: payload.workspace_id,
          },
          "workspace token mismatched daemon binding",
        );
        return null;
      }
      if (payload.account_id !== options.expectedAccountId) {
        logger.warn(
          {
            expectedAccountId: options.expectedAccountId,
            receivedAccountId: payload.account_id,
          },
          "workspace token mismatched daemon binding",
        );
        return null;
      }
      return {
        accountId: payload.account_id,
        workspaceId: payload.workspace_id,
        expiresAt: payload.exp,
      };
    },
    async prewarm(): Promise<void> {
      try {
        // Invoke the key resolver once with a minimal RS256 header. For the
        // `createRemoteJWKSet` resolver, this triggers the JWKS HTTP fetch
        // and populates the in-memory cache; subsequent `jwtVerify` calls
        // hit the cache and pay no network latency. Result is discarded.
        await getKey({ alg: "RS256" }, { payload: "", signature: "" } as never);
        logger.info("JWKS pre-warm completed");
      } catch (error) {
        logger.warn({ err: error }, "JWKS pre-warm failed");
      }
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

/**
 * Run `fn` inside the cloud workspace ALS so a per-spawn ~/.claude
 * credential resolves. When both owner claims are present (a cloud-owned
 * schedule/trigger) the context is restored with a far-future `expiresAt`
 * — the automation's authority comes from the workspace's existence, not
 * the original JWT's lifetime. On-host records (both claims null) run `fn`
 * directly with no ALS, identical to today's self-host behavior.
 *
 * Used for both the foreground create-phase and the detached background
 * turn of an automation fire, so the agent run still observes the workspace
 * context after the foreground callback returns (the ALS would otherwise
 * exit at ack time).
 */
export function runWithWorkspaceAuth<T>(
  owner: { workspaceId: string | null; accountId: string | null },
  fn: () => Promise<T>,
): Promise<T> {
  if (owner.workspaceId && owner.accountId) {
    return workspaceAuthStorage.run(
      {
        workspaceId: owner.workspaceId,
        accountId: owner.accountId,
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
      fn,
    );
  }
  return fn();
}
