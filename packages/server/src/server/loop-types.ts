import { z } from "zod";

export const LoopVerifyPromptSchema = z.object({
  passed: z.boolean(),
  reason: z.string().min(1),
});

export const LoopLogEntrySchema = z.object({
  seq: z.number().int().positive(),
  timestamp: z.string(),
  iteration: z.number().int().positive().nullable(),
  source: z.enum(["loop", "worker", "verifier", "verify-check"]),
  level: z.enum(["info", "error"]),
  text: z.string(),
});

export const LoopVerifyCheckResultSchema = z.object({
  command: z.string(),
  exitCode: z.number().int(),
  passed: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
});

export const LoopVerifyPromptResultSchema = z.object({
  passed: z.boolean(),
  reason: z.string(),
  verifierAgentId: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string(),
});

export const LoopIterationRecordSchema = z.object({
  index: z.number().int().positive(),
  workerAgentId: z.string().nullable(),
  workerStartedAt: z.string(),
  workerCompletedAt: z.string().nullable(),
  verifierAgentId: z.string().nullable(),
  status: z.enum(["running", "succeeded", "failed", "stopped"]),
  workerOutcome: z.enum(["completed", "failed", "canceled"]).nullable(),
  failureReason: z.string().nullable(),
  verifyChecks: z.array(LoopVerifyCheckResultSchema),
  verifyPrompt: LoopVerifyPromptResultSchema.nullable(),
});

export const LoopRecordSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  prompt: z.string(),
  cwd: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  modeId: z.string().nullable().default(null),
  workerProvider: z.string().nullable(),
  workerModel: z.string().nullable(),
  verifierProvider: z.string().nullable(),
  verifierModel: z.string().nullable(),
  verifierModeId: z.string().nullable().default(null),
  verifyPrompt: z.string().nullable(),
  verifyChecks: z.array(z.string()),
  archive: z.boolean(),
  sleepMs: z.number().int().nonnegative(),
  maxIterations: z.number().int().positive().nullable(),
  maxTimeMs: z.number().int().positive().nullable(),
  status: z.enum(["running", "succeeded", "failed", "stopped"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  stopRequestedAt: z.string().nullable(),
  iterations: z.array(LoopIterationRecordSchema),
  logs: z.array(LoopLogEntrySchema),
  nextLogSeq: z.number().int().positive(),
  activeIteration: z.number().int().positive().nullable(),
  activeWorkerAgentId: z.string().nullable(),
  activeVerifierAgentId: z.string().nullable(),
});

export const StoredLoopsSchema = z.array(LoopRecordSchema);

export type LoopStatus = z.infer<typeof LoopRecordSchema>["status"];
export type LoopLogEntry = z.infer<typeof LoopLogEntrySchema>;
export type LoopVerifyCheckResult = z.infer<typeof LoopVerifyCheckResultSchema>;
export type LoopVerifyPromptResult = z.infer<typeof LoopVerifyPromptResultSchema>;
export type LoopIterationRecord = z.infer<typeof LoopIterationRecordSchema>;
export type LoopRecord = z.infer<typeof LoopRecordSchema>;
