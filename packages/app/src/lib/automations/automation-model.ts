// View-model that normalizes the two automation record kinds — a timer-driven
// `ScheduleSummary` and an inbound-webhook-driven `WebhookTriggerSummary` —
// into one `Automation` shape rendered in the unified "Automations" list.
//
// The two records live in SEPARATE daemon stores + RPC families (see
// packages/server/src/server/trigger/types.ts for why). The merged list is a
// client-side concern only; nothing here crosses the wire.
import type { ScheduleSummary } from "@server/server/schedule/types";
import type { WebhookTriggerSummary } from "@server/server/trigger/types";

export type AutomationKind = "schedule" | "webhook";

export interface Automation {
  id: string;
  kind: AutomationKind;
  name: string | null;
  statusLabel: string;
  cadenceLabel: string;
  lastRunAt: string | null;
  // List summaries do not carry `runs[]`, so we cannot detect a failed last run
  // here — always false for summaries. The detail screen, which fetches the
  // full record with runs, uses `isLastRunFailure(runs)` instead.
  lastRunFailed: boolean;
  // Preserved for stable sort; not rendered directly.
  updatedAt: string;
}

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

// Format an `every` interval as a compact human label: "Every 30s",
// "Every 5m", "Every 2h", "Every 3d". Picks the largest whole unit that divides
// evenly; otherwise falls back to the next-smaller unit.
export function formatEveryMs(everyMs: number): string {
  if (everyMs >= MS_PER_DAY && everyMs % MS_PER_DAY === 0) {
    return `Every ${everyMs / MS_PER_DAY}d`;
  }
  if (everyMs >= MS_PER_HOUR && everyMs % MS_PER_HOUR === 0) {
    return `Every ${everyMs / MS_PER_HOUR}h`;
  }
  if (everyMs >= MS_PER_MINUTE && everyMs % MS_PER_MINUTE === 0) {
    return `Every ${everyMs / MS_PER_MINUTE}m`;
  }
  if (everyMs >= MS_PER_SECOND) {
    const seconds = Math.round(everyMs / MS_PER_SECOND);
    return `Every ${seconds}s`;
  }
  return `Every ${everyMs}ms`;
}

function scheduleStatusLabel(status: ScheduleSummary["status"]): string {
  if (status === "active") return "Active";
  if (status === "paused") return "Paused";
  return "Completed";
}

function scheduleCadenceLabel(cadence: ScheduleSummary["cadence"]): string {
  if (cadence.type === "every") {
    return formatEveryMs(cadence.everyMs);
  }
  return `Cron: ${cadence.expression}`;
}

export function normalizeSchedule(schedule: ScheduleSummary): Automation {
  return {
    id: schedule.id,
    kind: "schedule",
    name: schedule.name,
    statusLabel: scheduleStatusLabel(schedule.status),
    cadenceLabel: scheduleCadenceLabel(schedule.cadence),
    lastRunAt: schedule.lastRunAt,
    lastRunFailed: false,
    updatedAt: schedule.updatedAt,
  };
}

export function normalizeWebhookTrigger(trigger: WebhookTriggerSummary): Automation {
  return {
    id: trigger.id,
    kind: "webhook",
    name: trigger.name,
    statusLabel: trigger.enabled ? "Active" : "Disabled",
    cadenceLabel: "On webhook",
    lastRunAt: trigger.lastFiredAt,
    lastRunFailed: false,
    updatedAt: trigger.updatedAt,
  };
}

// Merge the two lists into one, stable-sorted by `updatedAt` descending
// (most-recently-updated first). Ties preserve input order (schedules before
// webhooks, each in its source-list order).
export function mergeAutomations(
  schedules: ReadonlyArray<ScheduleSummary>,
  triggers: ReadonlyArray<WebhookTriggerSummary>,
): Automation[] {
  const merged: Automation[] = [
    ...schedules.map(normalizeSchedule),
    ...triggers.map(normalizeWebhookTrigger),
  ];
  return merged
    .map((automation, index) => ({ automation, index }))
    .sort((left, right) => {
      const byUpdatedAt = right.automation.updatedAt.localeCompare(left.automation.updatedAt);
      if (byUpdatedAt !== 0) {
        return byUpdatedAt;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.automation);
}
