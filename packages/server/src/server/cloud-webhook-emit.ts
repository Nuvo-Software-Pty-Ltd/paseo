import { createHmac } from "node:crypto";
import type { Logger } from "pino";
import {
  toWireWorkspaceHardDeleteImminentEvent,
  WorkspaceHardDeleteImminentEventSchema,
  type WorkspaceHardDeleteImminentEvent,
} from "./cloud-webhook-events.js";

// Outbound webhook delivery primitive for the AGPL-core's webhook event
// catalogue. Single-purpose: validate → HMAC sign → POST → log.
//
// Mirrors cloud-version-beacon.ts's HMAC envelope (createHmac sha256 over
// the JSON body, X-Orchestra-Internal-HMAC header). The two could share a
// helper, but the call-site count is still small (2) and the inputs/outputs
// differ enough that premature extraction would obscure each call.
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

export interface WebhookEmitResult {
  ok: boolean;
  status?: number;
}

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
  const doFetch = params.fetchImpl ?? fetch;

  // Re-validate before sending — the caller is in another package
  // (proprietary worker) and may have built the payload manually. Catching
  // a bad shape here keeps subscribers from receiving anything off-schema.
  const parsed = WorkspaceHardDeleteImminentEventSchema.parse(event);
  const wire = toWireWorkspaceHardDeleteImminentEvent(parsed);
  const bodyString = JSON.stringify(wire);
  const hmac = createHmac("sha256", hmacKey).update(bodyString).digest("hex");

  let response: Response;
  try {
    response = await doFetch(subscriberUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Orchestra-Internal-HMAC": hmac,
      },
      body: bodyString,
    });
  } catch (err) {
    logger.warn(
      { err, subscriberUrl, eventType: parsed.eventType, workspaceId: parsed.workspaceId },
      "Webhook emit network failure",
    );
    return { ok: false };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    logger.warn(
      {
        status: response.status,
        responseBody: text,
        subscriberUrl,
        eventType: parsed.eventType,
        workspaceId: parsed.workspaceId,
      },
      "Webhook emit returned non-2xx",
    );
    return { ok: false, status: response.status };
  }

  logger.info(
    {
      status: response.status,
      subscriberUrl,
      eventType: parsed.eventType,
      workspaceId: parsed.workspaceId,
    },
    "Webhook emit delivered",
  );
  return { ok: true, status: response.status };
}
