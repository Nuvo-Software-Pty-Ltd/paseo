// Bounded retry around the daemon probe (PLAN-app.md Task 9). The auth
// service's `markStateActive` flips state="active" the instant ECS RUNNING
// lands — NOT when the daemon is healthy (LEARNINGS.md 2026-05-25 D-2 ship
// gate § "Note for D-3+"). The post-create probe can hit a 502/transient
// error during the ~5-10 s window before the daemon WS upgrade succeeds.
//
// This helper wraps the underlying probe in a bounded retry that returns
// a structured outcome instead of throwing on the first transient failure.
// The setup-screen consumes the outcome to show a "Starting workspace…"
// splash vs. a "Workspace is still starting — try refreshing in a minute"
// + [Retry] affordance.
//
// When PLAN-auth-and-shared lands a daemon-/api/health-gated state
// transition (deferred per the LEARNINGS note), this retry budget shrinks
// proportionally. Until then it is the load-bearing client-side mitigation.

export type DaemonBoundedRetryOutcome =
  | { kind: "ok"; attempt: number }
  | {
      kind: "still_booting";
      attempts: number;
      lastReason: string;
    }
  | {
      kind: "failed";
      attempts: number;
      reason: string;
    };

export interface DaemonBoundedRetryInput {
  // Per-attempt probe. Either resolves (the probe succeeded) or rejects
  // (the probe failed). Caller is responsible for closing any in-flight
  // client on rejection.
  attempt: () => Promise<void>;
  // Hard cap on attempts. Default 15 (~30 s @ 2 s spacing) matches T9's
  // budget.
  maxAttempts?: number;
  // Spacing between attempts in ms. Default 2000. Caller may shorten on
  // a 202/resuming mint result (passes retryAfterMs from the daemon).
  spacingMs?: number;
  // Optional sleep — defaults to setTimeout; tests pass a no-op or a
  // controlled promise.
  sleep?: (ms: number) => Promise<void>;
  // Optional predicate that classifies a thrown error as "still booting"
  // (transient — retry) vs "failed" (terminal — give up immediately).
  // Default treats everything except hard 4xx as retryable.
  isTransient?: (error: unknown) => boolean;
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function defaultIsTransient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  // Hard auth failures + missing-server-info are terminal — retrying won't
  // recover those. Everything else (502, transport closed, ECONNREFUSED)
  // is retryable during the markStateActive window.
  if (lower.includes("incorrect password")) return false;
  if (lower.includes("missing server info")) return false;
  return true;
}

export async function runDaemonBoundedRetry(
  input: DaemonBoundedRetryInput,
): Promise<DaemonBoundedRetryOutcome> {
  const maxAttempts = input.maxAttempts ?? 15;
  const spacingMs = input.spacingMs ?? 2000;
  const sleep = input.sleep ?? DEFAULT_SLEEP;
  const isTransient = input.isTransient ?? defaultIsTransient;

  let attempts = 0;
  let lastReason = "Unable to connect";
  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      await input.attempt();
      return { kind: "ok", attempt: attempts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastReason = message;
      if (!isTransient(error)) {
        return { kind: "failed", attempts, reason: message };
      }
      if (attempts >= maxAttempts) break;
      await sleep(spacingMs);
    }
  }
  return { kind: "still_booting", attempts, lastReason };
}
