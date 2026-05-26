import { z } from "zod";

// Open-core duplication-by-design — mirror of the key builders and row
// schemas the daemon consumes from `@orchestra/cloud-shared`. The AGPL
// fork MUST NOT import the proprietary package; the canonical source
// is `orchestra-cloud-private:packages/cloud-shared/src/keys.ts` +
// `schemas.ts`. Anti-drift CI (deferred follow-up #8 from D-1.5 / D-2)
// covers this mirror alongside `cloud-clone.ts`, `cloud-webhook-events.ts`,
// `cloud-provider-snapshot.ts`, `cloud-quota.ts`.
//
// Single-source-of-truth for pk/sk strings (F12 design-out): every
// DDB key construction the daemon performs goes through these
// builders. No inline string concat anywhere else in the codebase.
//
// COMPAT(cloud-shared-mirror): keys + record shapes pinned by
// orchestra-cloud-private/packages/cloud-shared/src/{keys,schemas}.ts
// HEAD `c9f804c` (auth-and-shared landed 2026-05-26). Update both
// sides together; CI will flag drift.

export interface DdbKey {
  pk: string;
  sk: string;
}

// ---- DDB key builders --------------------------------------------------

const LOOP_STEP_SEQ_WIDTH = 12;

export interface CloudSharedKeys {
  workspaceMetadata(workspaceId: string): DdbKey;
  workspaceChatRoom(workspaceId: string, roomId: string): DdbKey;
  workspaceChatMessage(workspaceId: string, roomId: string, messageId: string): DdbKey;
  workspaceSchedule(workspaceId: string, scheduleId: string): DdbKey;
  workspaceScheduleRun(workspaceId: string, scheduleId: string, runId: string): DdbKey;
  workspaceLoop(workspaceId: string, loopId: string): DdbKey;
  workspaceLoopStep(workspaceId: string, loopId: string, seq: number): DdbKey;
  workspacePermission(workspaceId: string, permissionId: string): DdbKey;
  workspaceDownloadToken(workspaceId: string, tokenId: string): DdbKey;
  spendDaily(workspaceId: string, yyyyMmDd: string): DdbKey;
  // NOT in cloud-shared yet (resumed-run integration mismatch): the
  // agent-timeline key builder is owned by the daemon for T-6. Filed
  // as INTEGRATION-NOTE in STATUS-daemon.md so cloud-shared can adopt
  // it post-D-3.
  workspaceAgentTimeline(workspaceId: string, agentId: string, epoch: string, seq: number): DdbKey;
}

const TIMELINE_SEQ_WIDTH = 16;

export function createCloudSharedKeys(): CloudSharedKeys {
  return {
    workspaceMetadata(workspaceId: string): DdbKey {
      return { pk: `${workspaceId}#metadata`, sk: "meta" };
    },
    workspaceChatRoom(workspaceId: string, roomId: string): DdbKey {
      return { pk: `${workspaceId}#chat`, sk: `${roomId}#meta` };
    },
    workspaceChatMessage(workspaceId: string, roomId: string, messageId: string): DdbKey {
      return { pk: `${workspaceId}#chat`, sk: `${roomId}#msg#${messageId}` };
    },
    workspaceSchedule(workspaceId: string, scheduleId: string): DdbKey {
      return { pk: `${workspaceId}#schedule`, sk: `${scheduleId}#meta` };
    },
    workspaceScheduleRun(workspaceId: string, scheduleId: string, runId: string): DdbKey {
      return { pk: `${workspaceId}#schedule`, sk: `${scheduleId}#run#${runId}` };
    },
    workspaceLoop(workspaceId: string, loopId: string): DdbKey {
      return { pk: `${workspaceId}#loop`, sk: `${loopId}#meta` };
    },
    workspaceLoopStep(workspaceId: string, loopId: string, seq: number): DdbKey {
      const padded = String(seq).padStart(LOOP_STEP_SEQ_WIDTH, "0");
      return { pk: `${workspaceId}#loop`, sk: `${loopId}#step#${padded}` };
    },
    workspacePermission(workspaceId: string, permissionId: string): DdbKey {
      return { pk: `${workspaceId}#permission`, sk: permissionId };
    },
    workspaceDownloadToken(workspaceId: string, tokenId: string): DdbKey {
      return { pk: `${workspaceId}#download-token`, sk: tokenId };
    },
    spendDaily(workspaceId: string, yyyyMmDd: string): DdbKey {
      return { pk: `${workspaceId}#spend`, sk: yyyyMmDd };
    },
    workspaceAgentTimeline(
      workspaceId: string,
      agentId: string,
      epoch: string,
      seq: number,
    ): DdbKey {
      const padded = String(seq).padStart(TIMELINE_SEQ_WIDTH, "0");
      return {
        pk: `${workspaceId}#agent#timeline`,
        sk: `${agentId}#${epoch}#${padded}`,
      };
    },
  };
}

// ---- Record body schemas ----------------------------------------------

export const ChatRoomRowSchema = z
  .object({
    roomId: z.string(),
    purpose: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export type ChatRoomRow = z.infer<typeof ChatRoomRowSchema>;

export const ChatMessageRowSchema = z
  .object({
    roomId: z.string(),
    messageId: z.string(),
    role: z.enum(["user", "assistant", "system", "tool"]),
    content: z.string(),
    createdAt: z.string(),
  })
  .passthrough();

export type ChatMessageRow = z.infer<typeof ChatMessageRowSchema>;

export const ScheduleRowSchema = z
  .object({
    scheduleId: z.string(),
    cron: z.string(),
    enabled: z.boolean(),
    agentTemplate: z.unknown(),
    eventBridgeScheduleArn: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export type ScheduleRow = z.infer<typeof ScheduleRowSchema>;

export const ScheduleRunRowSchema = z
  .object({
    runId: z.string(),
    scheduledFor: z.string(),
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    status: z.enum(["pending", "running", "succeeded", "failed"]),
    agentId: z.string().nullable(),
    output: z.unknown().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export type ScheduleRunRow = z.infer<typeof ScheduleRunRowSchema>;

export const LoopRowSchema = z
  .object({
    loopId: z.string(),
    maxIterations: z.number().int().positive().nullable(),
    maxTimeMs: z.number().int().positive().nullable(),
    state: z.enum(["pending", "running", "paused", "completed", "failed"]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();

export type LoopRow = z.infer<typeof LoopRowSchema>;

// A `LoopStepRow` is one row per (iteration, seq) pair — collapses the
// PLAN-daemon `LoopIterationRecord` and `LoopLogEntry` from `loop-types.ts`
// into one DDB row type. Source of truth is cloud-shared's
// `LoopStepRecord`.
export const LoopStepRowSchema = z
  .object({
    loopId: z.string(),
    iteration: z.number().int(),
    seq: z.number().int(),
    source: z.string(),
    level: z.enum(["debug", "info", "warn", "error"]),
    text: z.string(),
    ts: z.string(),
  })
  .passthrough();

export type LoopStepRow = z.infer<typeof LoopStepRowSchema>;

export const PermissionRowSchema = z
  .object({
    permissionId: z.string(),
    agentId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    state: z.enum(["pending", "granted", "denied", "expired"]),
    interrupt: z.boolean(),
    createdAt: z.string(),
    decidedAt: z.string().nullable(),
  })
  .passthrough();

export type PermissionRow = z.infer<typeof PermissionRowSchema>;

// Agent timeline row body — daemon-owned shape (cloud-shared does NOT
// yet ship this; filed as INTEGRATION-NOTE).
export const AgentTimelineRowSchema = z
  .object({
    agentId: z.string(),
    epoch: z.string(),
    seq: z.number().int().nonnegative(),
    timestamp: z.string(),
    // Item payload is the AgentTimelineItem from agent-sdk-types.ts;
    // we treat it as opaque here (the row serializer doesn't need
    // to know the shape).
    item: z.unknown(),
  })
  .passthrough();

export type AgentTimelineRow = z.infer<typeof AgentTimelineRowSchema>;
