import type { Logger } from "pino";
import { cloudHmacFetch, type CloudHmacFetchResult } from "./cloud-hmac-fetch.js";
import {
  toWireWorkspaceHardDeleteImminentEvent,
  WorkspaceHardDeleteImminentEventSchema,
  type WorkspaceHardDeleteImminentEvent,
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
//
// F3 design-out: the caller passes a fully-formed event; this primitive
// derives nothing from request context (no ALS, no JWT, no workspace
// lookup). The proprietary worker is the single physical caller (O-1
// resolution) and constructs the payload from DDB before invoking.
//
// Open-core boundary: no @orchestra/* imports; the schema lives next door
// (cloud-webhook-events.ts) and is duplicated against the worker side via
// the deferred anti-drift guard.

export type WebhookEmitResult = CloudHmacFetchResult;

export interface EmitWebhookEventParams {
  subscriberUrl: string;
  hmacKey: string;
  event: WorkspaceHardDeleteImminentEvent;
  logger: Logger;
  // Test seam: inject a fetch impl instead of using the global. Production
  // callers omit; tests pass a vi.fn().
  fetchImpl?: typeof fetch;
}

export async function emitWebhookEvent(params: EmitWebhookEventParams): Promise<WebhookEmitResult> {
  const { subscriberUrl, hmacKey, event, logger } = params;

  // Re-validate before sending — the caller is in another package
  // (proprietary worker) and may have built the payload manually. Catching
  // a bad shape here keeps subscribers from receiving anything off-schema.
  const parsed = WorkspaceHardDeleteImminentEventSchema.parse(event);
  const wire = toWireWorkspaceHardDeleteImminentEvent(parsed);
  const bodyString = JSON.stringify(wire);

  const result = await cloudHmacFetch({
    url: subscriberUrl,
    hmacKey,
    body: bodyString,
    logger,
    ...(params.fetchImpl !== undefined ? { fetchImpl: params.fetchImpl } : {}),
    logContext: { eventType: parsed.eventType, workspaceId: parsed.workspaceId },
    failureLogLabel: "Webhook emit",
  });

  if (result.ok) {
    logger.info(
      {
        status: result.status,
        subscriberUrl,
        eventType: parsed.eventType,
        workspaceId: parsed.workspaceId,
      },
      "Webhook emit delivered",
    );
  }
  return result;
}
