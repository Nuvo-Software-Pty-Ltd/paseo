// Pure model for the loop-failure summary card. The wire shape is pinned by
// round-19 (paseo-cloud-daemon/examples/loop-record/
// round-19-loop-maxTimeMs-cap.json). When `loop.status === "failed"`, the
// human-meaningful cap-class explanation lives in the trailing
// `logs[N].text` (e.g. "Reached max time (1000ms)." or
// "Reached max iterations.") — there is NO top-level `failureReason` field
// on LoopRecord. See PLAN-app.md Task 2.
import type { LoopRecord, LoopIterationRecord } from "@server/server/loop-types";

export interface LoopFailedIterationSummary {
  index: number;
  // `failureReason` DOES exist on iterations (distinct from the top-level
  // loop). Surfaced beside the cap-class message so the operator can see why
  // an individual iteration failed before the loop hit its time/iteration
  // cap.
  failureReason: string | null;
}

export type LoopFailureSummaryModel =
  | { kind: "not_failed" }
  | {
      kind: "cap";
      // Daemon-side text, rendered verbatim. round-19: "Reached max time
      // (1000ms).". A fabricated maxIterations cap fixture would render
      // "Reached max iterations." — the wording is daemon-side and the test
      // mirrors the round-19 pattern.
      capMessage: string;
      failedIterations: LoopFailedIterationSummary[];
    }
  | {
      kind: "unknown_failure";
      // No `loop`-source `error` log was found — fall back to the last log
      // entry's text, prefixed with "Loop failed: ". Covers worker-crash and
      // edge classes where the daemon ends the loop without emitting a
      // canonical cap-class log entry.
      fallbackMessage: string;
      failedIterations: LoopFailedIterationSummary[];
    };

export function buildLoopFailureSummaryModel(loop: LoopRecord): LoopFailureSummaryModel {
  if (loop.status !== "failed") {
    return { kind: "not_failed" };
  }
  const failedIterations: LoopFailedIterationSummary[] = loop.iterations
    .filter((iter): iter is LoopIterationRecord => iter.status === "failed")
    .map((iter) => ({
      index: iter.index,
      failureReason: iter.failureReason,
    }));

  // Walk logs[] in reverse, pick the first entry where source === "loop" and
  // level === "error". Round-19 binding: seq 11, source "loop", level
  // "error", text "Reached max time (1000ms).".
  for (let i = loop.logs.length - 1; i >= 0; i -= 1) {
    const entry = loop.logs[i];
    if (!entry) continue;
    if (entry.source === "loop" && entry.level === "error") {
      return {
        kind: "cap",
        capMessage: entry.text,
        failedIterations,
      };
    }
  }

  // No loop-source error log; fall back to the last entry's text. Covers the
  // worker-crash / SIGKILL / abrupt-termination class where the loop record
  // was finalized without a canonical cap-class log entry.
  const lastEntry = loop.logs[loop.logs.length - 1];
  const fallbackMessage = lastEntry?.text
    ? `Loop failed: ${lastEntry.text}`
    : "Loop failed (no detail recorded).";
  return {
    kind: "unknown_failure",
    fallbackMessage,
    failedIterations,
  };
}
