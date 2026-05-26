// Higher-level dispatch state for the pre-flight workspace-token mint
// (PLAN-app.md Task 6). Wraps `mintWorkspaceToken` with a bounded retry on
// 202 (resuming) and 503 (provisioning), so callers don't re-implement the
// loop. Returns a terminal state the UI can switch on for splash / banner
// rendering.

import { mintWorkspaceToken, type MintWorkspaceTokenResult } from "./orchestra-cloud-client";

export type MintTokenFlowOutcome =
  | { kind: "active"; token: string; expiresAt: number }
  | { kind: "billing_locked"; reactivateUrl: string | null }
  | { kind: "archived"; canUnarchive: boolean }
  | { kind: "provisioning_failed"; retryable: boolean }
  // Bounded retry exhausted while the workspace was still 202/503 — give the
  // user a [Retry] affordance rather than spinning forever (D-2 lesson:
  // `markStateActive` may hold the WS upgrade in 502 for ~5-10 s; the daemon
  // could in theory take longer for cold-resume).
  | { kind: "still_resuming"; lastRetryAfterMs: number; attempts: number }
  | { kind: "still_provisioning"; lastRetryAfterMs: number; attempts: number };

interface RunMintTokenFlowInput {
  workspaceId: string;
  // Hard cap on retries. Default 15 (PLAN-app.md Task 9 budget = ~30 s @ 2 s
  // spacing). Caller may shorten for the post-create probe (T9) or lengthen
  // for a deliberate cold-resume splash.
  maxAttempts?: number;
  // Optional async sleep — accepts a ms delay and returns void. Defaults to
  // `setTimeout` but tests can pass a deterministic no-op or a controlled
  // promise to drive the loop synchronously.
  sleep?: (ms: number) => Promise<void>;
  // Optional client override — used in tests to mock the underlying mint
  // call without touching globalThis.fetch. The default uses the real
  // orchestra-cloud-client implementation.
  mint?: (workspaceId: string) => Promise<MintWorkspaceTokenResult>;
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function runMintTokenFlow(
  input: RunMintTokenFlowInput,
): Promise<MintTokenFlowOutcome> {
  const maxAttempts = input.maxAttempts ?? 15;
  const sleep = input.sleep ?? DEFAULT_SLEEP;
  const mint = input.mint ?? mintWorkspaceToken;

  let lastResumeRetry = 0;
  let lastProvisioningRetry = 0;
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts += 1;
    const result = await mint(input.workspaceId);
    if (result.status === "active") {
      return { kind: "active", token: result.token, expiresAt: result.expiresAt };
    }
    if (result.status === "billing_locked") {
      return { kind: "billing_locked", reactivateUrl: result.reactivateUrl };
    }
    if (result.status === "archived") {
      return { kind: "archived", canUnarchive: result.canUnarchive };
    }
    if (result.status === "provisioning_failed") {
      return { kind: "provisioning_failed", retryable: result.retryable };
    }
    if (result.status === "resuming") {
      lastResumeRetry = result.retryAfterMs;
      if (attempts >= maxAttempts) break;
      await sleep(result.retryAfterMs);
      continue;
    }
    if (result.status === "provisioning") {
      lastProvisioningRetry = result.retryAfterMs;
      if (attempts >= maxAttempts) break;
      await sleep(result.retryAfterMs);
      continue;
    }
    // Exhaustiveness — every status from MintWorkspaceTokenResult is
    // handled above. If a new variant lands without a handler the type
    // check fails here.
    const _exhaustive: never = result;
    void _exhaustive;
  }

  // The loop exhausted without reaching a terminal state. Surface "still
  // resuming/provisioning" so the UI can render a [Retry] affordance
  // instead of spinning forever. lastResumeRetry / lastProvisioningRetry
  // carries the daemon's last suggested wait so the UI can hint at expected
  // duration.
  if (lastProvisioningRetry > 0 && lastResumeRetry === 0) {
    return {
      kind: "still_provisioning",
      lastRetryAfterMs: lastProvisioningRetry,
      attempts,
    };
  }
  return {
    kind: "still_resuming",
    lastRetryAfterMs: lastResumeRetry,
    attempts,
  };
}
