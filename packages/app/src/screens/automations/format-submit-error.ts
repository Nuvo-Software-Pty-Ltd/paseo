// Action being attempted when the submission threw — drives the user-facing verb.
export type SubmitAction = "create" | "save";

const GENERIC_REASON = "an unexpected error occurred.";

// Build a user-facing message for a thrown create/update failure. React Query's
// `mutateAsync` REJECTS when the mutationFn throws (e.g. the daemon RPC throwing
// on a failed cloud schedule-register), and that rejection would otherwise be
// swallowed. We surface the error's message without leaking a stack trace: only
// the first line of the message is kept.
export function formatSubmitError(err: unknown, action: SubmitAction): string {
  const verb = action === "create" ? "create" : "save";
  return `Couldn't ${verb} the automation: ${extractReason(err)}`;
}

function extractReason(err: unknown): string {
  let raw = "";
  if (err instanceof Error) {
    raw = err.message;
  } else if (typeof err === "string") {
    raw = err;
  }
  // Keep only the first line so a stack trace appended to the message never leaks.
  const firstLine = raw.split("\n", 1)[0]?.trim() ?? "";
  return firstLine.length > 0 ? firstLine : GENERIC_REASON;
}
