import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { cloudHmacFetch, type CloudHmacFetchResult } from "./cloud-hmac-fetch.js";
import {
  AgentTurnCompletedEventSchema,
  AgentTurnFailedEventSchema,
  toWireAgentTurnCompletedEvent,
  toWireAgentTurnFailedEvent,
  toWireWorkspaceCreatedEvent,
  toWireWorkspaceHardDeleteImminentEvent,
  WorkspaceCreatedEventSchema,
  WorkspaceHardDeleteImminentEventSchema,
  type CloudWebhookEvent,
} from "./cloud-webhook-events.js";

// Outbound webhook delivery primitive for the AGPL-core's webhook event
// catalogue. Single-purpose: validate → wire-shape → HMAC POST → log.
//
// HMAC envelope is shared via cloudHmacFetch (cloud-hmac-fetch.ts); see
// that module for the wire-level convention (header name, algorithm).
//
// Retry policy Day-1: NONE. workspace-lifecycle.md § Forward-compatibility
// hooks: "EventBridge Scheduler retries failed subscriber deliveries with
// exponential backoff." The scheduler is the retry surface, not the emit
// primitive. If delivery fails, the schedule fires again and we re-emit
// from the proprietary lifecycle worker (O-1 → Architecture B). When a
// real subscriber lands (per-account long-term agent memory feature),
// revisit this — at-most-once semantics may need an at-least-once layer.
// For agent.turn_completed (T-8, fired directly from the daemon's turn-
// end hook), the loss-on-subscriber-down posture is the Day-1 default
// (per O-5 in PLAN-daemon — billing module is the layer that cares
// about exactly-once and lands at D-4).
//
// F3 design-out: the caller passes a fully-formed event; this primitive
// derives nothing from request context (no ALS, no JWT, no workspace
// lookup). The proprietary worker is the single physical caller for
// workspace.hard_delete_imminent; the AGPL daemon is the caller for
// agent.turn_completed / agent.turn_failed; the auth service is the
// caller for workspace.created (synthesis A5 / OQ7 — operator decision
// B; the daemon does NOT emit workspace.created).
//
// Open-core boundary: no @orchestra/* imports; the schemas live next
// door (cloud-webhook-events.ts) and are duplicated against the worker
// + auth sides via the deferred anti-drift guard.

export type WebhookEmitResult = CloudHmacFetchResult;

export interface EmitWebhookEventParams {
  subscriberUrl: string;
  hmacKey: string;
  event: CloudWebhookEvent;
  logger: Logger;
  // Test seam: inject a fetch impl instead of using the global. Production
  // callers omit; tests pass a vi.fn().
  fetchImpl?: typeof fetch;
}

// INTEGRATION (2026-05-26): auth's POST /api/webhooks/sink expects
// the envelope shape below (verified against
// `orchestra-cloud-private:d-3-plan-auth-and-shared/packages/auth/src/routes/webhooks.ts`,
// SinkBody schema lines 26-33):
//
//   { eventId, eventType, payload, emittedAt, workspaceId?, accountId? }
//
// The `payload` field is the snake_case wire-body produced by the
// toWire*Event helpers; the outer envelope carries the audit metadata
// (eventId for idempotent ack, emittedAt for wall-clock, workspaceId/
// accountId for partition-key selection on the sink's DDB write).
//
// Original D-3 T-8 emit shipped the wire body directly as the POST
// body — this was the integration mismatch surfaced at the resumed-
// run audit. Fixed here.

interface SinkEnvelope {
  body: string;
  eventType: string;
  workspaceId: string;
  accountId: string;
  eventId: string;
}

function validateAndSerialize(event: CloudWebhookEvent): SinkEnvelope {
  // Re-validate + project to wire shape based on the discriminator. The
  // caller may have built the payload manually (proprietary worker /
  // daemon emit site); catching a bad shape here keeps subscribers from
  // receiving anything off-schema.
  let eventType: string;
  let workspaceId: string;
  let accountId: string;
  let payload: unknown;
  switch (event.eventType) {
    case "workspace.hard_delete_imminent": {
      const parsed = WorkspaceHardDeleteImminentEventSchema.parse(event);
      eventType = parsed.eventType;
      workspaceId = parsed.workspaceId;
      accountId = parsed.accountId;
      payload = toWireWorkspaceHardDeleteImminentEvent(parsed);
      break;
    }
    case "workspace.created": {
      const parsed = WorkspaceCreatedEventSchema.parse(event);
      eventType = parsed.eventType;
      workspaceId = parsed.workspaceId;
      accountId = parsed.accountId;
      payload = toWireWorkspaceCreatedEvent(parsed);
      break;
    }
    case "agent.turn_completed": {
      const parsed = AgentTurnCompletedEventSchema.parse(event);
      eventType = parsed.eventType;
      workspaceId = parsed.workspaceId;
      accountId = parsed.accountId;
      payload = toWireAgentTurnCompletedEvent(parsed);
      break;
    }
    case "agent.turn_failed": {
      const parsed = AgentTurnFailedEventSchema.parse(event);
      eventType = parsed.eventType;
      workspaceId = parsed.workspaceId;
      accountId = parsed.accountId;
      payload = toWireAgentTurnFailedEvent(parsed);
      break;
    }
  }
  const eventId = randomUUID();
  const envelope = {
    eventId,
    eventType,
    payload,
    emittedAt: new Date().toISOString(),
    workspaceId,
    accountId,
  };
  return {
    body: JSON.stringify(envelope),
    eventType,
    workspaceId,
    accountId,
    eventId,
  };
}

export async function emitWebhookEvent(params: EmitWebhookEventParams): Promise<WebhookEmitResult> {
  const { subscriberUrl, hmacKey, event, logger } = params;
  const { body, eventType, workspaceId, eventId } = validateAndSerialize(event);

  const result = await cloudHmacFetch({
    url: subscriberUrl,
    hmacKey,
    body,
    logger,
    ...(params.fetchImpl !== undefined ? { fetchImpl: params.fetchImpl } : {}),
    logContext: { eventType, workspaceId, eventId },
    failureLogLabel: "Webhook emit",
  });

  if (result.ok) {
    logger.info(
      {
        status: result.status,
        subscriberUrl,
        eventType,
        workspaceId,
        eventId,
      },
      "Webhook emit delivered",
    );
  }
  return result;
}
