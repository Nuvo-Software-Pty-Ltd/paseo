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

// ---------------------------------------------------------------------------
// D-3 T-8 — webhook catalogue expansion (open-core-architecture.md:56-60)
// ---------------------------------------------------------------------------
//
// COMPAT(workspace.created): payload locked by
// paseo-cloud-daemon/90-cloud-considerations/open-core-architecture.md
// § "Webhook-style outbound from the core". Synthesis A5 / OQ7 →
// operator decision B (2026-05-26): the auth service is the physical
// emitter. The AGPL daemon owns the schema (this file); the auth
// service imports (or duplicates with anti-drift) and emits after the
// metadata-and-state DDB write succeeds. The daemon does NOT fire
// workspace.created.
//
// COMPAT(agent.turn_completed) + COMPAT(agent.turn_failed): payload
// locked by open-core-architecture.md:59-60. Fired by the AGPL daemon
// from the agent-manager.ts turn-end hook. Payload includes raw token
// telemetry; the billing-side rate table (Day-N) computes spend from
// these counts (see T-18 OQ-C — daemon writes raw tokens, aggregator
// computes cents).
//
// Same dual-shape pattern (camelCase TS / snake_case wire) as the D-2
// workspace.hard_delete_imminent event. Anti-drift CI (deferred
// follow-up #8) covers these alongside the D-2 schema.

export const WorkspaceCreatedEventSchema = z
  .object({
    eventType: z.literal("workspace.created"),
    workspaceId: z.string().min(1),
    accountId: z.string().min(1),
    createdAt: z.string().datetime(),
    repoUrl: z.string().url().nullable(),
    displayName: z.string().min(1).nullable(),
  })
  .strict();

export type WorkspaceCreatedEvent = z.infer<typeof WorkspaceCreatedEventSchema>;

export const WorkspaceCreatedEventWireSchema = z
  .object({
    event_type: z.literal("workspace.created"),
    workspace_id: z.string().min(1),
    account_id: z.string().min(1),
    created_at: z.string().datetime(),
    repo_url: z.string().url().nullable(),
    display_name: z.string().min(1).nullable(),
  })
  .strict();

export type WorkspaceCreatedEventWire = z.infer<typeof WorkspaceCreatedEventWireSchema>;

export function toWireWorkspaceCreatedEvent(
  event: WorkspaceCreatedEvent,
): WorkspaceCreatedEventWire {
  return {
    event_type: event.eventType,
    workspace_id: event.workspaceId,
    account_id: event.accountId,
    created_at: event.createdAt,
    repo_url: event.repoUrl,
    display_name: event.displayName,
  };
}

export function fromWireWorkspaceCreatedEvent(
  wire: WorkspaceCreatedEventWire,
): WorkspaceCreatedEvent {
  return {
    eventType: wire.event_type,
    workspaceId: wire.workspace_id,
    accountId: wire.account_id,
    createdAt: wire.created_at,
    repoUrl: wire.repo_url,
    displayName: wire.display_name,
  };
}

// Token-usage shape. Mirrors AgentUsage from agent-sdk-types.ts but
// without optional-fields ambiguity — the webhook event carries either
// a number or 0 for each field. The aggregator (PLAN-lifecycle-worker
// D-3-3) handles per-model rate-table multiplication.
const TurnUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalCostUsd: z.number().nonnegative().nullable(),
  })
  .strict();

const TurnUsageWireSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    cached_input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    total_cost_usd: z.number().nonnegative().nullable(),
  })
  .strict();

type TurnUsage = z.infer<typeof TurnUsageSchema>;
type TurnUsageWire = z.infer<typeof TurnUsageWireSchema>;

function toWireUsage(u: TurnUsage): TurnUsageWire {
  return {
    input_tokens: u.inputTokens,
    cached_input_tokens: u.cachedInputTokens,
    output_tokens: u.outputTokens,
    total_cost_usd: u.totalCostUsd,
  };
}

function fromWireUsage(u: TurnUsageWire): TurnUsage {
  return {
    inputTokens: u.input_tokens,
    cachedInputTokens: u.cached_input_tokens,
    outputTokens: u.output_tokens,
    totalCostUsd: u.total_cost_usd,
  };
}

export const AgentTurnCompletedEventSchema = z
  .object({
    eventType: z.literal("agent.turn_completed"),
    workspaceId: z.string().min(1),
    accountId: z.string().min(1),
    agentId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1).nullable(),
    completedAt: z.string().datetime(),
    usage: TurnUsageSchema,
  })
  .strict();

export type AgentTurnCompletedEvent = z.infer<typeof AgentTurnCompletedEventSchema>;

export const AgentTurnCompletedEventWireSchema = z
  .object({
    event_type: z.literal("agent.turn_completed"),
    workspace_id: z.string().min(1),
    account_id: z.string().min(1),
    agent_id: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1).nullable(),
    completed_at: z.string().datetime(),
    usage: TurnUsageWireSchema,
  })
  .strict();

export type AgentTurnCompletedEventWire = z.infer<typeof AgentTurnCompletedEventWireSchema>;

export function toWireAgentTurnCompletedEvent(
  event: AgentTurnCompletedEvent,
): AgentTurnCompletedEventWire {
  return {
    event_type: event.eventType,
    workspace_id: event.workspaceId,
    account_id: event.accountId,
    agent_id: event.agentId,
    provider: event.provider,
    model: event.model,
    completed_at: event.completedAt,
    usage: toWireUsage(event.usage),
  };
}

export function fromWireAgentTurnCompletedEvent(
  wire: AgentTurnCompletedEventWire,
): AgentTurnCompletedEvent {
  return {
    eventType: wire.event_type,
    workspaceId: wire.workspace_id,
    accountId: wire.account_id,
    agentId: wire.agent_id,
    provider: wire.provider,
    model: wire.model,
    completedAt: wire.completed_at,
    usage: fromWireUsage(wire.usage),
  };
}

export const AgentTurnFailedEventSchema = z
  .object({
    eventType: z.literal("agent.turn_failed"),
    workspaceId: z.string().min(1),
    accountId: z.string().min(1),
    agentId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1).nullable(),
    failedAt: z.string().datetime(),
    error: z.string(),
    usage: TurnUsageSchema.nullable(),
  })
  .strict();

export type AgentTurnFailedEvent = z.infer<typeof AgentTurnFailedEventSchema>;

export const AgentTurnFailedEventWireSchema = z
  .object({
    event_type: z.literal("agent.turn_failed"),
    workspace_id: z.string().min(1),
    account_id: z.string().min(1),
    agent_id: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1).nullable(),
    failed_at: z.string().datetime(),
    error: z.string(),
    usage: TurnUsageWireSchema.nullable(),
  })
  .strict();

export type AgentTurnFailedEventWire = z.infer<typeof AgentTurnFailedEventWireSchema>;

export function toWireAgentTurnFailedEvent(event: AgentTurnFailedEvent): AgentTurnFailedEventWire {
  return {
    event_type: event.eventType,
    workspace_id: event.workspaceId,
    account_id: event.accountId,
    agent_id: event.agentId,
    provider: event.provider,
    model: event.model,
    failed_at: event.failedAt,
    error: event.error,
    usage: event.usage === null ? null : toWireUsage(event.usage),
  };
}

export function fromWireAgentTurnFailedEvent(wire: AgentTurnFailedEventWire): AgentTurnFailedEvent {
  return {
    eventType: wire.event_type,
    workspaceId: wire.workspace_id,
    accountId: wire.account_id,
    agentId: wire.agent_id,
    provider: wire.provider,
    model: wire.model,
    failedAt: wire.failed_at,
    error: wire.error,
    usage: wire.usage === null ? null : fromWireUsage(wire.usage),
  };
}

// Discriminated union of all D-3 + D-2 webhook events the AGPL fork
// defines. Used by cloud-webhook-emit.ts to type the union of payloads
// it can deliver.
export type CloudWebhookEvent =
  | WorkspaceHardDeleteImminentEvent
  | WorkspaceCreatedEvent
  | AgentTurnCompletedEvent
  | AgentTurnFailedEvent;
