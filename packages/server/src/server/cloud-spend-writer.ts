import type { Logger } from "pino";
import { cloudHmacFetch, type CloudHmacFetchResult } from "./cloud-hmac-fetch.js";

// T-18 (synthesis A7) — per-turn spend-row writer.
//
// Writes to `<workspaceId>#spend / <yyyy-mm-dd>` (UTC day key) so the
// proprietary lifecycle worker's quota aggregator (PLAN-lifecycle-
// worker D-3-3) can read the rows on a periodic sweep and enforce the
// per-workspace outbound-API-spend cap.
//
// Synthesis OQ-C: the daemon writes RAW TOKEN COUNTS (input, cached
// input, output) per turn — NOT pre-computed cents. The aggregator on
// the lifecycle-worker side multiplies by a model-specific rate table.
// This keeps the rate table on the billing side; the daemon's job is
// just to record what happened. Rate-table updates do not require a
// daemon redeploy.
//
// Mechanism: HMAC POST to the auth service's `/api/auth-internal/spend`
// (PLAN-auth-and-shared owns the route). Auth performs the DDB
// UpdateItem with `ADD turnCount :n, ADD inputTokens :i, ADD
// cachedInputTokens :ci, ADD outputTokens :o`. Same posture as the
// heartbeat (T-4 from D-2): the daemon carries no DDB SDK; F9 keeps
// auth as the single DDB writer for cross-tenant rows.
//
// Day-1 posture: warn-and-continue on any failure. A missed spend row
// is a quota under-count, not a correctness regression. Repeated
// failures surface via the EMF metric `SpendRowWriteFailed` (PLAN-
// cdk-infra Task 8, observability.md:88).
//
// F3 design-out: the caller passes a fully-formed body; this primitive
// derives nothing from request context (no ALS, no JWT). The
// agent-manager turn-end hook reads workspaceId/accountId from
// getCurrentWorkspaceAuth() and includes them in the call.

export interface SpendRowWriteParams {
  /** Target URL — `${ORCHESTRA_AUTH_INTERNAL_URL}/api/auth-internal/spend`. */
  url: string;
  /** HMAC key from ORCHESTRA_INTERNAL_HMAC_KEY. */
  hmacKey: string;
  /** From the ALS — F3 design-out. */
  workspaceId: string;
  /** UTC day in `YYYY-MM-DD`; the caller computes it via toUtcDayKey. */
  dayKey: string;
  /** Token telemetry from the provider's usage block. */
  turn: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  };
  logger: Logger;
  fetchImpl?: typeof fetch;
}

/**
 * Compute the UTC day key (`YYYY-MM-DD`) for the spend row's sort key.
 * Aggregator (PLAN-lifecycle-worker D-3-3) reads rows by `<ws>#spend`
 * partition + `<dayKey>` sort to compute the rolling window.
 */
export function toUtcDayKey(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function writeSpendRow(params: SpendRowWriteParams): Promise<CloudHmacFetchResult> {
  const body = JSON.stringify({
    workspaceId: params.workspaceId,
    dayKey: params.dayKey,
    turnCount: 1,
    inputTokens: params.turn.inputTokens,
    cachedInputTokens: params.turn.cachedInputTokens,
    outputTokens: params.turn.outputTokens,
  });
  return cloudHmacFetch({
    url: params.url,
    hmacKey: params.hmacKey,
    body,
    logger: params.logger,
    ...(params.fetchImpl !== undefined ? { fetchImpl: params.fetchImpl } : {}),
    logContext: { workspaceId: params.workspaceId, dayKey: params.dayKey },
    failureLogLabel: "Spend-row write",
  });
}
