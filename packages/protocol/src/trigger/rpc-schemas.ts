import { z } from "zod";
import { ScheduleCreateTargetSchema } from "../schedule/rpc-schemas.js";
import { ScheduleRunSchema } from "../schedule/types.js";
import { WebhookTriggerSchema, WebhookTriggerSummarySchema } from "./types.js";

// D-3.5d — webhook-trigger WS RPC family. Separate from the schedule
// family (see types.ts) to preserve the `schedule/list` discriminatedUnion
// back-compat. Response envelopes mirror the schedule ones
// (`{requestId, …, error: string|null}`).

export const TriggerCreateRequestSchema = z.object({
  type: z.literal("trigger/create"),
  requestId: z.string(),
  prompt: z.string().min(1),
  name: z.string().nullable().optional(),
  target: ScheduleCreateTargetSchema,
  payloadTemplate: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

export const TriggerListRequestSchema = z.object({
  type: z.literal("trigger/list"),
  requestId: z.string(),
});

export const TriggerInspectRequestSchema = z.object({
  type: z.literal("trigger/inspect"),
  requestId: z.string(),
  triggerId: z.string(),
});

export const TriggerLogsRequestSchema = z.object({
  type: z.literal("trigger/logs"),
  requestId: z.string(),
  triggerId: z.string(),
});

export const TriggerUpdateRequestSchema = z.object({
  type: z.literal("trigger/update"),
  requestId: z.string(),
  triggerId: z.string(),
  name: z.string().nullable().optional(),
  prompt: z.string().min(1).optional(),
  target: ScheduleCreateTargetSchema.optional(),
  payloadTemplate: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

export const TriggerDeleteRequestSchema = z.object({
  type: z.literal("trigger/delete"),
  requestId: z.string(),
  triggerId: z.string(),
});

export const TriggerRunOnceRequestSchema = z.object({
  type: z.literal("trigger/run-once"),
  requestId: z.string(),
  triggerId: z.string(),
  // Optional sample payload for the manual test fire.
  payload: z.unknown().optional(),
});

export const TriggerRotateSecretRequestSchema = z.object({
  type: z.literal("trigger/rotate-secret"),
  requestId: z.string(),
  triggerId: z.string(),
});

// ---- Responses --------------------------------------------------------

export const TriggerCreateResponseSchema = z.object({
  type: z.literal("trigger/create/response"),
  payload: z.object({
    requestId: z.string(),
    trigger: WebhookTriggerSummarySchema.nullable(),
    // One-time secret + ingress URL — present only on success, surfaced
    // to the GUI once and never re-served.
    secret: z.string().nullable(),
    ingressUrl: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const TriggerListResponseSchema = z.object({
  type: z.literal("trigger/list/response"),
  payload: z.object({
    requestId: z.string(),
    triggers: z.array(WebhookTriggerSummarySchema),
    error: z.string().nullable(),
  }),
});

export const TriggerInspectResponseSchema = z.object({
  type: z.literal("trigger/inspect/response"),
  payload: z.object({
    requestId: z.string(),
    trigger: WebhookTriggerSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TriggerLogsResponseSchema = z.object({
  type: z.literal("trigger/logs/response"),
  payload: z.object({
    requestId: z.string(),
    runs: z.array(ScheduleRunSchema),
    error: z.string().nullable(),
  }),
});

export const TriggerUpdateResponseSchema = z.object({
  type: z.literal("trigger/update/response"),
  payload: z.object({
    requestId: z.string(),
    trigger: WebhookTriggerSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TriggerDeleteResponseSchema = z.object({
  type: z.literal("trigger/delete/response"),
  payload: z.object({
    requestId: z.string(),
    triggerId: z.string(),
    error: z.string().nullable(),
  }),
});

export const TriggerRunOnceResponseSchema = z.object({
  type: z.literal("trigger/run-once/response"),
  payload: z.object({
    requestId: z.string(),
    trigger: WebhookTriggerSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TriggerRotateSecretResponseSchema = z.object({
  type: z.literal("trigger/rotate-secret/response"),
  payload: z.object({
    requestId: z.string(),
    trigger: WebhookTriggerSummarySchema.nullable(),
    secret: z.string().nullable(),
    ingressUrl: z.string().nullable(),
    error: z.string().nullable(),
  }),
});
