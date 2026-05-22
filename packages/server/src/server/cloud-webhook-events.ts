import { z } from "zod";

// Webhook event schemas for the AGPL core's externally-observable event
// catalogue. Subscribers are external systems (per-account long-term agent
// memory, third-party automations) that read the wire-shape body and act on
// it. The schemas here are the source of truth for the wire format.
//
// COMPAT(workspace.hard_delete_imminent): payload locked by
// paseo-cloud-daemon/90-cloud-considerations/workspace-lifecycle.md
// § Forward-compatibility hooks. Do not extend without doc update;
// subscribers depend on the stable shape. Field additions must be
// `.optional()` (backwards-compatible); removals and renames are NOT.
//
// Open-core boundary: the proprietary lifecycle worker is the physical
// caller that emits this event at T-24h pre-purge (resolution O-1
// "Architecture B" — worker imports / duplicates this schema). The AGPL
// fork is the source of truth; if the worker duplicates rather than
// imports, both sides carry the anti-drift annotation (filed at D-1.5
// deferred follow-up #3 — single sweep, not in this PR).
//
// camelCase vs snake_case: the daemon code is uniformly camelCase, so the
// in-TS shape (`WorkspaceHardDeleteImminentEventSchema`) is camelCase. The
// wire shape (`WorkspaceHardDeleteImminentEventWireSchema`) is snake_case
// to match the workspace-lifecycle.md doc verbatim — subscribers read the
// doc, not our TS. The transforms below bridge the two; conversion happens
// at the HTTP delivery boundary in cloud-webhook-emit.ts.

export const WorkspaceHardDeleteImminentEventSchema = z
  .object({
    eventType: z.literal("workspace.hard_delete_imminent"),
    workspaceId: z.string().min(1),
    accountId: z.string().min(1),
    archivedAt: z.string().datetime(),
    scheduledPurgeAt: z.string().datetime(),
  })
  .strict();

export type WorkspaceHardDeleteImminentEvent = z.infer<
  typeof WorkspaceHardDeleteImminentEventSchema
>;

export const WorkspaceHardDeleteImminentEventWireSchema = z
  .object({
    event_type: z.literal("workspace.hard_delete_imminent"),
    workspace_id: z.string().min(1),
    account_id: z.string().min(1),
    archived_at: z.string().datetime(),
    scheduled_purge_at: z.string().datetime(),
  })
  .strict();

export type WorkspaceHardDeleteImminentEventWire = z.infer<
  typeof WorkspaceHardDeleteImminentEventWireSchema
>;

export function toWireWorkspaceHardDeleteImminentEvent(
  event: WorkspaceHardDeleteImminentEvent,
): WorkspaceHardDeleteImminentEventWire {
  return {
    event_type: event.eventType,
    workspace_id: event.workspaceId,
    account_id: event.accountId,
    archived_at: event.archivedAt,
    scheduled_purge_at: event.scheduledPurgeAt,
  };
}

export function fromWireWorkspaceHardDeleteImminentEvent(
  wire: WorkspaceHardDeleteImminentEventWire,
): WorkspaceHardDeleteImminentEvent {
  return {
    eventType: wire.event_type,
    workspaceId: wire.workspace_id,
    accountId: wire.account_id,
    archivedAt: wire.archived_at,
    scheduledPurgeAt: wire.scheduled_purge_at,
  };
}
