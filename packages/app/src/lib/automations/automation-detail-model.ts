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

// A not-found is the ONLY outcome we treat as "this id isn't in that store —
// try the next one". Connection/host errors (timeouts, disconnects) carry
// different messages and must propagate. The daemon throws `Schedule not
// found: <id>` / `Webhook trigger not found: <id>`, so match on "not found".
export function isAutomationNotFoundError(error: unknown): boolean {
  return error instanceof Error && /not found/i.test(error.message);
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
