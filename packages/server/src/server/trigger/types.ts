import { z } from "zod";
import { ScheduleRunSchema, ScheduleTargetSchema } from "../schedule/types.js";

// D-3.5d — webhook triggers: an automation that spawns an agent on an
// inbound webhook rather than on a timer. The agent-spawn payload is
// identical to a schedule (prompt + target), so `target` and the run
// record (`ScheduleRun`) are reused verbatim — the spawn semantics and
// run-record shape are intentionally the same as schedules.
//
// Webhook triggers are a SEPARATE record type + store + RPC family, NOT
// a new `ScheduleCadence` variant: adding a `{type:"webhook"}` arm to the
// schedule cadence discriminatedUnion would make an old client's
// `schedule/list` Zod parser throw on the new arm. The unified
// "Automations" surface is a client-side merge of the two lists.
//
// `cloudOwnerWorkspaceId/AccountId` mirror the schedule fields (F3:
// derived from the ALS at create-time, never from the wire) so the
// fire-time spawn can restore `workspaceAuthStorage` before the run.
// Both `.nullable().default(null)` so an on-host record (no ALS) parses
// cleanly.
export const WebhookTriggerSchema = z.object({
  id: z.string(), // internal 8-char hex (randomBytes(4)) — same scheme as schedules
  webhookId: z.string(), // unguessable public id used in the ingress URL path
  name: z.string().nullable(),
  prompt: z.string().min(1),
  target: ScheduleTargetSchema, // reused verbatim from schedule/types.ts
  // optional template; "{{payload}}" is substituted with the (capped,
  // sanitized) inbound body at fire time. null → schedule-identical body.
  payloadTemplate: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
  // Populated by the provisioning seam (Task 3): cloud register hook or
  // the self-host local receiver URL.
  ingressUrl: z.string().nullable().default(null),
  // Last 6 hex of the signing secret, surfaced to the GUI. The full
  // secret is returned exactly once (create / rotate) and never re-served.
  secretFingerprint: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastFiredAt: z.string().nullable(),
  runs: z.array(ScheduleRunSchema), // reuse ScheduleRun verbatim
  cloudOwnerWorkspaceId: z.string().nullable().default(null),
  cloudOwnerAccountId: z.string().nullable().default(null),
});
export type WebhookTrigger = z.infer<typeof WebhookTriggerSchema>;

// List shape — runs elided, plus the secret never appears in summaries.
export const WebhookTriggerSummarySchema = WebhookTriggerSchema.omit({
  runs: true,
});
export type WebhookTriggerSummary = z.infer<typeof WebhookTriggerSummarySchema>;

export interface CreateWebhookTriggerInput {
  name?: string | null;
  prompt: string;
  target: z.infer<typeof ScheduleTargetSchema>;
  payloadTemplate?: string | null;
  enabled?: boolean | null;
}

export interface UpdateWebhookTriggerInput {
  id: string;
  name?: string | null;
  prompt?: string;
  target?: z.infer<typeof ScheduleTargetSchema>;
  payloadTemplate?: string | null;
  enabled?: boolean;
}

/**
 * Result of provisioning a trigger's public ingress. The `secret` is the
 * raw signing secret returned to the caller exactly once; the daemon
 * persists only its fingerprint.
 */
export interface TriggerProvisionResult {
  webhookId: string;
  ingressUrl: string;
  secret: string;
}
