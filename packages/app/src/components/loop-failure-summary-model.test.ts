import { describe, expect, it } from "vitest";
import type { LoopRecord } from "@getpaseo/protocol/loop/rpc-schemas";
import { buildLoopFailureSummaryModel } from "./loop-failure-summary-model";

// Round-19 fixture verbatim, captured at:
// paseo-cloud-daemon/examples/loop-record/round-19-loop-maxTimeMs-cap.json
const ROUND_19_CAP_LOOP: LoopRecord = {
  id: "1e443c30",
  name: "r19-mt-cap",
  prompt: "Reply with DONE.",
  cwd: "/tmp/paseo-spec-r19-cwd",
  provider: "claude",
  model: null,
  modeId: null,
  workerProvider: "claude",
  workerModel: "claude-sonnet-4-5",
  verifierProvider: "claude",
  verifierModel: "claude-sonnet-4-5",
  verifierModeId: null,
  verifyPrompt: null,
  verifyChecks: ["false"],
  archive: false,
  sleepMs: 0,
  maxIterations: 10,
  maxTimeMs: 1000,
  status: "failed",
  createdAt: "2026-05-09T02:55:48.139Z",
  updatedAt: "2026-05-09T02:55:57.601Z",
  startedAt: "2026-05-09T02:55:48.139Z",
  completedAt: "2026-05-09T02:55:57.601Z",
  stopRequestedAt: null,
  iterations: [
    {
      index: 1,
      workerAgentId: "18b22b99-09bb-4837-99c4-0d0838fdea77",
      workerStartedAt: "2026-05-09T02:55:48.153Z",
      workerCompletedAt: "2026-05-09T02:55:57.587Z",
      verifierAgentId: null,
      status: "failed",
      workerOutcome: "completed",
      failureReason: "Verify check failed: false",
      verifyChecks: [
        {
          command: "false",
          exitCode: 1,
          passed: false,
          stdout: "",
          stderr: "",
          startedAt: "2026-05-09T02:55:57.588Z",
          completedAt: "2026-05-09T02:55:57.600Z",
        },
      ],
      verifyPrompt: null,
    },
  ],
  logs: [
    {
      seq: 1,
      timestamp: "2026-05-09T02:55:48.139Z",
      iteration: null,
      source: "loop",
      level: "info",
      text: "Loop created in /tmp/paseo-spec-r19-cwd",
    },
    {
      seq: 2,
      timestamp: "2026-05-09T02:55:48.153Z",
      iteration: 1,
      source: "loop",
      level: "info",
      text: "Starting iteration 1.",
    },
    {
      seq: 9,
      timestamp: "2026-05-09T02:55:57.588Z",
      iteration: 1,
      source: "verify-check",
      level: "info",
      text: "$ false",
    },
    {
      seq: 10,
      timestamp: "2026-05-09T02:55:57.600Z",
      iteration: 1,
      source: "verify-check",
      level: "error",
      text: "exit 1",
    },
    {
      seq: 11,
      timestamp: "2026-05-09T02:55:57.601Z",
      iteration: null,
      source: "loop",
      level: "error",
      text: "Reached max time (1000ms).",
    },
  ],
  nextLogSeq: 12,
  activeIteration: null,
  activeWorkerAgentId: null,
  activeVerifierAgentId: null,
};

describe("buildLoopFailureSummaryModel", () => {
  it("returns not_failed for a running loop", () => {
    const loop: LoopRecord = { ...ROUND_19_CAP_LOOP, status: "running" };
    expect(buildLoopFailureSummaryModel(loop)).toEqual({ kind: "not_failed" });
  });

  it("returns not_failed for a succeeded loop", () => {
    const loop: LoopRecord = { ...ROUND_19_CAP_LOOP, status: "succeeded" };
    expect(buildLoopFailureSummaryModel(loop)).toEqual({ kind: "not_failed" });
  });

  it("extracts the round-19 maxTime cap message verbatim from the trailing loop-source error log", () => {
    const model = buildLoopFailureSummaryModel(ROUND_19_CAP_LOOP);
    expect(model.kind).toBe("cap");
    if (model.kind !== "cap") throw new Error("expected cap");
    expect(model.capMessage).toBe("Reached max time (1000ms).");
  });

  it("surfaces the failed iteration's failureReason (distinct from the cap message)", () => {
    const model = buildLoopFailureSummaryModel(ROUND_19_CAP_LOOP);
    if (model.kind !== "cap") throw new Error("expected cap");
    expect(model.failedIterations).toEqual([
      { index: 1, failureReason: "Verify check failed: false" },
    ]);
  });

  it("renders a fabricated maxIterations cap correctly (round-19 wording pattern)", () => {
    const loop: LoopRecord = {
      ...ROUND_19_CAP_LOOP,
      maxTimeMs: null,
      maxIterations: 10,
      logs: [
        ...ROUND_19_CAP_LOOP.logs.slice(0, -1),
        {
          seq: 11,
          timestamp: "2026-05-09T02:55:57.601Z",
          iteration: null,
          source: "loop",
          level: "error",
          text: "Reached max iterations.",
        },
      ],
    };
    const model = buildLoopFailureSummaryModel(loop);
    if (model.kind !== "cap") throw new Error("expected cap");
    expect(model.capMessage).toBe("Reached max iterations.");
  });

  it("falls back to the last log entry when no loop-source error log exists (worker-crash class)", () => {
    const loop: LoopRecord = {
      ...ROUND_19_CAP_LOOP,
      logs: [
        {
          seq: 1,
          timestamp: "2026-05-09T02:55:48.139Z",
          iteration: null,
          source: "loop",
          level: "info",
          text: "Loop created in /tmp/paseo-spec-r19-cwd",
        },
        {
          seq: 2,
          timestamp: "2026-05-09T02:55:57.000Z",
          iteration: 1,
          source: "worker",
          level: "error",
          text: "worker process exited unexpectedly",
        },
      ],
    };
    const model = buildLoopFailureSummaryModel(loop);
    expect(model.kind).toBe("unknown_failure");
    if (model.kind !== "unknown_failure") throw new Error("expected unknown_failure");
    expect(model.fallbackMessage).toBe("Loop failed: worker process exited unexpectedly");
  });

  it("falls back to a generic message when logs[] is empty entirely", () => {
    const loop: LoopRecord = { ...ROUND_19_CAP_LOOP, logs: [] };
    const model = buildLoopFailureSummaryModel(loop);
    if (model.kind !== "unknown_failure") throw new Error("expected unknown_failure");
    expect(model.fallbackMessage).toBe("Loop failed (no detail recorded).");
  });
});
