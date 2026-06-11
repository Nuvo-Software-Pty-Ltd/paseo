// Resolves an automation id to its full detail record. The two automation
// kinds live in separate daemon stores (schedules vs webhook triggers) with
// separate RPC families, so resolving an id means inspecting the right store.
//
// When the caller already knows the kind (carried from the list row into the
// detail route) we inspect that store directly — no guessing. For a kind-less
// deep link we probe the schedule store first and fall through to the webhook
// store ONLY on a genuine not-found. The daemon's schedule service THROWS
// `Schedule not found: <id>` for an unknown id (it does not return
// `{schedule:null}`), so the probe must catch that not-found and keep going —
// while re-throwing any genuine error (host disconnected, timeout) so it still
// surfaces to the user instead of being silently treated as "try webhook".
import type { AutomationKind } from "@/lib/automations/automation-model";
import type { ScheduleRun, StoredSchedule } from "@server/server/schedule/types";
import type { WebhookTrigger } from "@server/server/trigger/types";

export type AutomationDetailRecord =
  | { kind: "schedule"; record: StoredSchedule; runs: ScheduleRun[] }
  | { kind: "webhook"; record: WebhookTrigger; runs: ScheduleRun[] };

// Minimal structural view of the daemon client — just the inspect/logs calls
// this resolver needs. The real `DaemonClient` satisfies this shape.
export interface AutomationDetailClient {
  scheduleInspect(options: { id: string }): Promise<{ schedule: StoredSchedule | null }>;
  scheduleLogs(options: { id: string }): Promise<{ runs?: ScheduleRun[] }>;
  triggerInspect(options: { id: string }): Promise<{ trigger: WebhookTrigger | null }>;
  triggerLogs(options: { id: string }): Promise<{ runs?: ScheduleRun[] }>;
}

// Read an error's message structurally — WITHOUT gating on `instanceof Error`.
// The daemon RPC error is a `DaemonRpcError` subclass of Error, but the app's
// web bundle re-transpiles that class through Metro/Babel (we import the daemon
// client from `@server/...` *source*, not a prebuilt dist). A class that
// `extends Error` transpiled for the browser does not reliably satisfy
// `error instanceof Error` at runtime, so the old `error instanceof Error`
// guard returned false for a real not-found on web — which made the kind-less
// probe re-throw the raw `Schedule not found: <id>` error on the webhook detail
// view instead of falling through to the webhook store. Reading `.message`
// off whatever shape we actually get keeps detection bundle-independent.
function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

// A not-found is the ONLY outcome we treat as "this id isn't in that store —
// try the next one". Connection/host errors (timeouts, disconnects) carry
// different messages and must propagate. The daemon throws `Schedule not
// found: <id>` / `Webhook trigger not found: <id>`, so match on "not found".
//
// We deliberately discriminate on the message text, not the RPC `.code`: a
// schedule not-found arrives as `code="schedule_request_failed"`, but so does
// any other schedule failure (permission denied, etc.), and a client-side
// timeout ("Timeout waiting for message schedule/inspect/response") carries no
// code at all. Only the "not found" message reliably means "wrong store" — a
// bare code match would swallow genuine errors we must surface.
export function isAutomationNotFoundError(error: unknown): boolean {
  // Only thrown error objects (Error instances or the transpiled RPC error
  // object that carries `.message`) qualify. A bare string/primitive is not a
  // structured throw we trust to mean "wrong store".
  if (typeof error !== "object" || error === null) {
    return false;
  }
  return /not found/i.test(readErrorMessage(error));
}

async function inspectScheduleDetail(
  client: AutomationDetailClient,
  id: string,
): Promise<AutomationDetailRecord | null> {
  const result = await client.scheduleInspect({ id });
  if (!result.schedule) {
    return null;
  }
  const logs = await client.scheduleLogs({ id });
  return { kind: "schedule", record: result.schedule, runs: logs.runs ?? [] };
}

async function inspectWebhookDetail(
  client: AutomationDetailClient,
  id: string,
): Promise<AutomationDetailRecord | null> {
  const result = await client.triggerInspect({ id });
  if (!result.trigger) {
    return null;
  }
  const logs = await client.triggerLogs({ id });
  return { kind: "webhook", record: result.trigger, runs: logs.runs ?? [] };
}

export async function resolveAutomationDetail({
  client,
  automationId,
  kind,
  webhookSupported,
}: {
  client: AutomationDetailClient;
  automationId: string;
  // Carried from the list row; `undefined` for kind-less deep links.
  kind: AutomationKind | undefined;
  webhookSupported: boolean;
}): Promise<AutomationDetailRecord> {
  // Kind known up front — inspect the matching store directly. A missing id
  // throws (or returns null) and surfaces as not-found, as it should.
  if (kind === "schedule") {
    const schedule = await inspectScheduleDetail(client, automationId);
    if (schedule) {
      return schedule;
    }
    throw new Error("Automation not found");
  }
  if (kind === "webhook") {
    const webhook = await inspectWebhookDetail(client, automationId);
    if (webhook) {
      return webhook;
    }
    throw new Error("Automation not found");
  }

  // Kind-less deep link: probe schedule first, then webhook. Fall through ONLY
  // on a genuine not-found; re-throw connection/host errors.
  try {
    const schedule = await inspectScheduleDetail(client, automationId);
    if (schedule) {
      return schedule;
    }
  } catch (error) {
    if (!isAutomationNotFoundError(error)) {
      throw error;
    }
  }

  if (webhookSupported) {
    const webhook = await inspectWebhookDetail(client, automationId);
    if (webhook) {
      return webhook;
    }
  }

  throw new Error("Automation not found");
}
