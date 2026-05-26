// Pure view-model for a single schedule run row. The wire shape is pinned by
// the round-19 capture (paseo-cloud-daemon/examples/schedule-record/
// round-19-fired-failed-bad-cwd.json): failed runs carry a free-form
// `error: string`, `agentId: null`, and `output: null`. There is NO top-level
// `failureReason` field on the schedule. See PLAN-app.md Task 1.
import type { ScheduleRun } from "@server/server/schedule/types";

export type ScheduleFailedRunRowModel =
  | {
      status: "running";
      scheduledFor: string;
      startedAt: string;
    }
  | {
      status: "succeeded";
      scheduledFor: string;
      startedAt: string;
      endedAt: string | null;
      agentId: string | null;
      output: string | null;
    }
  | {
      status: "failed";
      scheduledFor: string;
      startedAt: string;
      endedAt: string | null;
      // `error` is the daemon-side string verbatim. Render unchanged so the
      // operator sees the same message the daemon logged (round-19: "Working
      // directory does not exist: <path>").
      error: string;
      // `agentId` may be null for cap-trap failures (the daemon never spawned
      // an agent process). The UI must NOT render an agent link in that case.
      agentId: string | null;
    };

export function buildScheduleRunRowModel(run: ScheduleRun): ScheduleFailedRunRowModel {
  if (run.status === "running") {
    return {
      status: "running",
      scheduledFor: run.scheduledFor,
      startedAt: run.startedAt,
    };
  }
  if (run.status === "succeeded") {
    return {
      status: "succeeded",
      scheduledFor: run.scheduledFor,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      agentId: run.agentId,
      output: run.output,
    };
  }
  // status === "failed"
  return {
    status: "failed",
    scheduledFor: run.scheduledFor,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    // Daemon may emit `error: null` in pathological cases; fall back to a
    // generic hint rather than the empty string so the row doesn't render an
    // unlabeled red icon.
    error: run.error ?? "Run failed (no error message recorded)",
    agentId: run.agentId,
  };
}

// Used by the schedule-list summary line in the projects picker: when the
// most-recent run failed, the row surfaces a "Last run failed" hint instead
// of the default green checkmark / next-run text. Round-19 binding: a
// `maxRuns:1` schedule whose only run failed still flips its top-level
// `status` to "completed", so the list view cannot rely on the schedule's
// status alone to detect a failure.
export function isLastRunFailure(runs: ReadonlyArray<ScheduleRun>): boolean {
  if (runs.length === 0) return false;
  const last = runs[runs.length - 1];
  return last !== undefined && last.status === "failed";
}
