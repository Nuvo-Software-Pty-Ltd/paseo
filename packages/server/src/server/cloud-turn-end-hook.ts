import type { Logger } from "pino";
import { getCurrentWorkspaceAuth } from "./cloud-auth.js";
import type { AgentTurnEndCallback, AgentTurnEndContext } from "./agent/agent-manager.js";
import { emitWebhookEvent } from "./cloud-webhook-emit.js";
import type { AgentTurnCompletedEvent, AgentTurnFailedEvent } from "./cloud-webhook-events.js";
import { isPaseoCloudMode } from "./paseo-env.js";

// T-8 (synthesis A5 / OQ7 / A8) — cloud-mode turn-end hook factory.
//
// Composes the AGPL daemon's per-turn fan-out: (a) the agent.turn_*
// webhook emit to ORCHESTRA_AUTH_WEBHOOK_SINK_URL (synthesis A8 — env
// var renamed from ORCHESTRA_WEBHOOK_SINK_URL); (b) T-18's spend-row
// writer (wired separately when the cloud-shared key builder lands —
// see TODO below).
//
// Open-core boundary: the AGPL daemon is the physical emitter for
// agent.turn_completed + agent.turn_failed (per
// open-core-architecture.md:56-60). The synthesis-A5 decision keeps
// the AGPL fork as the schema owner; this hook is the live emit site.
//
// F3 design-out: workspace_id + account_id come from the ALS
// (getCurrentWorkspaceAuth) — never from a caller's parameters. The
// hook is wired only in cloud mode (isPaseoCloudMode); on-host mode
// gets no hook (the callback is undefined and AgentManager skips the
// fan-out entirely).
//
// Day-1 retry posture: NONE. agent.turn_* events are fire-and-forget;
// if the auth sink is down, the event is lost. PLAN-daemon § O-5
// recommendation A — billing module (D-4) is the layer that cares
// about exactly-once.

export interface CreateCloudTurnEndHookParams {
  /**
   * Target URL for the webhook emit (auth's HMAC sink, per synthesis
   * A8 — env var ORCHESTRA_AUTH_WEBHOOK_SINK_URL). If unset, the hook
   * is a no-op (Day-1 posture per ROADMAP § Phase D-3).
   */
  webhookSinkUrl: string | undefined;
  /**
   * HMAC key for the outbound POST. Sourced from
   * ORCHESTRA_INTERNAL_HMAC_KEY at the call site. If unset alongside a
   * configured webhookSinkUrl, the hook warns once and no-ops (the
   * URL without a key cannot be authenticated).
   */
  hmacKey: string | undefined;
  /**
   * Daemon-side logger. Hook errors warn-and-continue here.
   */
  logger: Logger;
  /**
   * Test seam: replace global fetch. Production omits.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Returns a callback suitable for AgentManagerOptions.onAgentTurnEnd
 * in cloud mode, OR undefined when the daemon is on-host (no cloud
 * mode) or the webhook sink is not configured.
 *
 * The callback fires both the agent.turn_completed/failed webhook and
 * (Day-N, when the spend writer is wired) the spend-row update. Both
 * are warn-and-continue on failure; the agent's own turn outcome is
 * unaffected.
 */
export function createCloudTurnEndHook(
  params: CreateCloudTurnEndHookParams,
): AgentTurnEndCallback | undefined {
  if (!isPaseoCloudMode()) return undefined;
  const { webhookSinkUrl, hmacKey, logger } = params;
  if (!webhookSinkUrl) {
    logger.debug("ORCHESTRA_AUTH_WEBHOOK_SINK_URL not set — agent.turn_* webhook fan-out disabled");
    return undefined;
  }
  if (!hmacKey) {
    logger.warn(
      "ORCHESTRA_AUTH_WEBHOOK_SINK_URL is set but ORCHESTRA_INTERNAL_HMAC_KEY is not — webhook emit disabled",
    );
    return undefined;
  }

  return (context: AgentTurnEndContext): void => {
    const claims = getCurrentWorkspaceAuth();
    if (!claims) {
      // The turn-end hook fired outside an ALS-bound execution path.
      // This is the same "workspace auth context" condition the
      // cloud-credentials fail-loud branch protects against; T-7 closes
      // it for scheduled/loop/persistent-resume by restoring the ALS at
      // fire time. Until T-7's persisted records ship, log + skip.
      logger.debug(
        { agentId: context.agentId, outcome: context.outcome },
        "Turn-end hook fired outside workspaceAuthStorage — skipping webhook emit",
      );
      return;
    }

    void (async () => {
      try {
        if (context.outcome === "completed") {
          const event: AgentTurnCompletedEvent = {
            eventType: "agent.turn_completed",
            workspaceId: claims.workspaceId,
            accountId: claims.accountId,
            agentId: context.agentId,
            provider: context.provider,
            model: context.model,
            completedAt: context.endedAt,
            usage: context.usage ?? {
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              totalCostUsd: null,
            },
          };
          await emitWebhookEvent({
            subscriberUrl: webhookSinkUrl,
            hmacKey,
            event,
            logger,
            ...(params.fetchImpl !== undefined ? { fetchImpl: params.fetchImpl } : {}),
          });
        } else {
          const event: AgentTurnFailedEvent = {
            eventType: "agent.turn_failed",
            workspaceId: claims.workspaceId,
            accountId: claims.accountId,
            agentId: context.agentId,
            provider: context.provider,
            model: context.model,
            failedAt: context.endedAt,
            error: context.error,
            usage: context.usage,
          };
          await emitWebhookEvent({
            subscriberUrl: webhookSinkUrl,
            hmacKey,
            event,
            logger,
            ...(params.fetchImpl !== undefined ? { fetchImpl: params.fetchImpl } : {}),
          });
        }
      } catch (err) {
        logger.warn(
          { err, agentId: context.agentId, outcome: context.outcome },
          "Cloud turn-end webhook emit failed",
        );
      }
    })();
  };
}
