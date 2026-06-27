import { z } from "zod";
import { AgentProviderSchema } from "@getpaseo/protocol/provider-manifest";

export const ScheduleStatusSchema = z.enum(["active", "paused", "completed"]);
export type ScheduleStatus = z.infer<typeof ScheduleStatusSchema>;

export const ScheduleCadenceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("every"),
    everyMs: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("cron"),
    expression: z.string().trim().min(1),
    timezone: z.string().trim().min(1).optional(),
  }),
]);
export type ScheduleCadence = z.infer<typeof ScheduleCadenceSchema>;

export const ScheduleTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent"),
    agentId: z.guid(),
  }),
  z.object({
    type: z.literal("new-agent"),
    config: z.object({
      provider: AgentProviderSchema,
      cwd: z.string().trim().min(1),
      modeId: z.string().trim().min(1).optional(),
      model: z.string().trim().min(1).optional(),
      thinkingOptionId: z.string().trim().min(1).optional(),
      title: z.string().trim().min(1).nullable().optional(),
      approvalPolicy: z.string().trim().min(1).optional(),
      sandboxMode: z.string().trim().min(1).optional(),
      networkAccess: z.boolean().optional(),
      webSearch: z.boolean().optional(),
      featureValues: z.record(z.string(), z.unknown()).optional(),
      extra: z
        .object({
          codex: z.record(z.string(), z.unknown()).optional(),
          claude: z.record(z.string(), z.unknown()).optional(),
        })
        .partial()
        .optional(),
      systemPrompt: z.string().optional(),
      mcpServers: z.record(z.string(), z.unknown()).optional(),
      // Where a scheduled/triggered new-agent runs:
      //  - "reuse" (default): run in `cwd`; if that workspace is archived the
      //    fire path auto-unarchives it (so the agent is reachable again).
      //  - "dedicated-worktree": ONE Paseo worktree per schedule, created on
      //    first fire and reused thereafter (cwd + workspaceId are written back
      //    onto this record).
      //  - "fresh-worktree-per-run": a NEW worktree each fire (bounded by
      //    maxRetainedRuns; older ones are archived).
      workspaceMode: z.enum(["reuse", "dedicated-worktree", "fresh-worktree-per-run"]).optional(),
      // Resolved workspace the spawn attaches to. For "dedicated-worktree" this
      // is daemon-written after first creation; for "reuse" it MAY be set by the
      // client to pin the exact workspace (precise auto-unarchive + attribution).
      // Optional so every pre-existing record parses unchanged.
      workspaceId: z.string().trim().min(1).optional(),
    }),
  }),
]);
export type ScheduleTarget = z.infer<typeof ScheduleTargetSchema>;

export const ScheduleRunSchema = z.object({
  id: z.string(),
  scheduledFor: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: z.enum(["running", "succeeded", "failed"]),
  agentId: z.guid().nullable(),
  output: z.string().nullable(),
  error: z.string().nullable(),
});
export type ScheduleRun = z.infer<typeof ScheduleRunSchema>;

// T-7 (synthesis carryover, 2026-05-26) — cloud-owner fields.
//
// In cloud mode the schedule's fire-time spawn site needs the workspace +
// account claims to bind workspaceAuthStorage before the agent run. The
// claims are sourced from getCurrentWorkspaceAuth() at create-time and
// persisted alongside the rest of the record (F3 design-out: NEVER from
// a caller; ALWAYS from the ALS at the create-call-site).
//
// On-host records have both fields null — the FileBackedScheduleStore
// continues to work unchanged for self-host operators (the ALS is empty
// outside cloud mode; service.ts:create writes null).
//
// Both fields are `.nullable().default(null)` so a pre-D-3 schedule
// file loaded after the upgrade parses cleanly (forward-compat with
// existing on-disk records). New writes always set both fields
// explicitly (null on-host; claims-derived in cloud).
export const StoredScheduleSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  prompt: z.string().min(1),
  cadence: ScheduleCadenceSchema,
  target: ScheduleTargetSchema,
  status: ScheduleStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  pausedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  maxRuns: z.number().int().positive().nullable(),
  // Retention cap for kept run-agents / per-run worktrees. Unset (null) keeps
  // every run's agent (the chosen default); for "fresh-worktree-per-run" the
  // reaper falls back to a sane cap when this is null so worktree dirs cannot
  // grow without bound. `.default(null)` keeps pre-upgrade records parseable.
  maxRetainedRuns: z.number().int().positive().nullable().default(null),
  runs: z.array(ScheduleRunSchema),
  // T-7 cloud-owner persisted claims.
  cloudOwnerWorkspaceId: z.string().nullable().default(null),
  cloudOwnerAccountId: z.string().nullable().default(null),
});
export type StoredSchedule = z.infer<typeof StoredScheduleSchema>;

export const ScheduleSummarySchema = StoredScheduleSchema.omit({
  runs: true,
});
export type ScheduleSummary = z.infer<typeof ScheduleSummarySchema>;

export interface CreateScheduleInput {
  name?: string | null;
  prompt: string;
  cadence: ScheduleCadence;
  target: ScheduleTarget;
  maxRuns?: number | null;
  maxRetainedRuns?: number | null;
  expiresAt?: string | null;
  runOnCreate?: boolean | null;
}

export interface UpdateScheduleNewAgentConfig {
  provider?: string;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  cwd?: string;
  workspaceMode?: "reuse" | "dedicated-worktree" | "fresh-worktree-per-run";
  // Daemon write-back target after a dedicated worktree is created; also lets a
  // client pin the reuse-mode workspace. `null` clears a previously-pinned id.
  workspaceId?: string | null;
}

export interface UpdateScheduleInput {
  id: string;
  name?: string | null;
  prompt?: string;
  cadence?: ScheduleCadence;
  newAgentConfig?: UpdateScheduleNewAgentConfig;
  maxRuns?: number | null;
  maxRetainedRuns?: number | null;
  expiresAt?: string | null;
}

export interface ScheduleExecutionResult {
  agentId: string | null;
  output: string | null;
}
