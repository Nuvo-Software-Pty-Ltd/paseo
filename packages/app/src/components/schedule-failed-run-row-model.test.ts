import { describe, expect, it } from "vitest";
import type { ScheduleRun } from "@server/server/schedule/types";
import { buildScheduleRunRowModel, isLastRunFailure } from "./schedule-failed-run-row-model";

// Round-19 fixture verbatim, captured at:
// paseo-cloud-daemon/examples/schedule-record/round-19-fired-failed-bad-cwd.json
const ROUND_19_FAILED_RUN: ScheduleRun = {
  id: "931e71b1-1f12-4c61-abe2-c2d5cadfc32d",
  scheduledFor: "2026-05-09T02:38:38.967Z",
  startedAt: "2026-05-09T02:38:39.246Z",
  endedAt: "2026-05-09T02:38:39.250Z",
  status: "failed",
  agentId: null,
  output: null,
  error: "Working directory does not exist: /tmp/paseo-spec-r19-DOES-NOT-EXIST",
};

// A canonical succeeded-run shape (round-14 fixture pattern: agentId set,
// output set, error null).
const SUCCEEDED_RUN: ScheduleRun = {
  id: "a-success",
  scheduledFor: "2026-05-09T02:00:00.000Z",
  startedAt: "2026-05-09T02:00:01.000Z",
  endedAt: "2026-05-09T02:00:05.000Z",
  status: "succeeded",
  agentId: "00000000-0000-4000-8000-000000000001",
  output: "ok",
  error: null,
};

const RUNNING_RUN: ScheduleRun = {
  id: "b-running",
  scheduledFor: "2026-05-09T02:10:00.000Z",
  startedAt: "2026-05-09T02:10:01.000Z",
  endedAt: null,
  status: "running",
  agentId: null,
  output: null,
  error: null,
};

describe("buildScheduleRunRowModel", () => {
  it("renders the round-19 failed run with the daemon's error string verbatim", () => {
    const model = buildScheduleRunRowModel(ROUND_19_FAILED_RUN);
    expect(model).toEqual({
      status: "failed",
      scheduledFor: "2026-05-09T02:38:38.967Z",
      startedAt: "2026-05-09T02:38:39.246Z",
      endedAt: "2026-05-09T02:38:39.250Z",
      error: "Working directory does not exist: /tmp/paseo-spec-r19-DOES-NOT-EXIST",
      agentId: null,
    });
  });

  it("preserves agentId:null on failed runs (no broken agent link)", () => {
    const model = buildScheduleRunRowModel(ROUND_19_FAILED_RUN);
    if (model.status !== "failed") throw new Error("expected failed");
    expect(model.agentId).toBeNull();
  });

  it("falls back to a generic hint when the daemon emits error:null on a failed run", () => {
    const model = buildScheduleRunRowModel({
      ...ROUND_19_FAILED_RUN,
      error: null,
    });
    if (model.status !== "failed") throw new Error("expected failed");
    expect(model.error).toBe("Run failed (no error message recorded)");
  });

  it("renders a succeeded run with output and agentId", () => {
    const model = buildScheduleRunRowModel(SUCCEEDED_RUN);
    expect(model).toEqual({
      status: "succeeded",
      scheduledFor: "2026-05-09T02:00:00.000Z",
      startedAt: "2026-05-09T02:00:01.000Z",
      endedAt: "2026-05-09T02:00:05.000Z",
      agentId: "00000000-0000-4000-8000-000000000001",
      output: "ok",
    });
  });

  it("renders a running run without endedAt", () => {
    const model = buildScheduleRunRowModel(RUNNING_RUN);
    expect(model).toEqual({
      status: "running",
      scheduledFor: "2026-05-09T02:10:00.000Z",
      startedAt: "2026-05-09T02:10:01.000Z",
    });
  });
});

describe("isLastRunFailure", () => {
  it("returns true when the most-recent run failed (round-19 maxRuns:1 case)", () => {
    expect(isLastRunFailure([ROUND_19_FAILED_RUN])).toBe(true);
  });

  it("returns false when the most-recent run succeeded", () => {
    expect(isLastRunFailure([SUCCEEDED_RUN])).toBe(false);
  });

  it("returns false for an empty run list (no fires yet)", () => {
    expect(isLastRunFailure([])).toBe(false);
  });

  it("returns true if the LAST run failed even when earlier runs succeeded", () => {
    expect(isLastRunFailure([SUCCEEDED_RUN, ROUND_19_FAILED_RUN])).toBe(true);
  });

  it("returns false if the last run is still running", () => {
    expect(isLastRunFailure([ROUND_19_FAILED_RUN, RUNNING_RUN])).toBe(false);
  });
});
