import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import {
  type AgentModeColorTier,
  type AgentModeIcon,
  type AgentProviderDefinition,
  type AgentProviderModeDefinition,
} from "@getpaseo/protocol/provider-manifest";
import { SELECTABLE_PROVIDER_STATUSES } from "@/provider-selection/resolve-agent-form";

function buildProviderModes(entry: ProviderSnapshotEntry): AgentProviderModeDefinition[] {
  const entryModes = entry.modes ?? [];

  return entryModes.map((mode) =>
    Object.assign({}, mode, {
      icon: (mode.icon ?? "ShieldCheck") as AgentModeIcon,
      colorTier: (mode.colorTier ?? "moderate") as AgentModeColorTier,
    }),
  );
}

export function buildProviderDefinitions(
  snapshotEntries: ProviderSnapshotEntry[] | undefined,
): AgentProviderDefinition[] {
  if (!snapshotEntries?.length) {
    return [];
  }

  return snapshotEntries.map((entry) => ({
    id: entry.provider,
    label: entry.label ?? entry.provider,
    description: entry.description ?? "",
    defaultModeId: entry.defaultModeId ?? null,
    modes: buildProviderModes(entry),
  }));
}

// Whether the agent-chat composer treats a snapshot entry as a *selectable*
// provider. The composer keys selectability off the provider STATUS
// (SELECTABLE_PROVIDER_STATUSES — currently "ready"), NOT the `enabled` flag.
// The automation target picker historically filtered by `entry.enabled`, which
// dropped providers the composer happily offers (e.g. a "ready" cloud Anthropic
// entry that isn't flagged `enabled`), leaving the automation dropdown empty.
// Both surfaces now share this predicate so they cannot diverge again.
export function isSelectableProviderEntry(entry: ProviderSnapshotEntry): boolean {
  return SELECTABLE_PROVIDER_STATUSES.has(entry.status);
}

// The provider options the automation target picker should offer — exactly the
// entries the composer treats as selectable. Returns plain {id,label} so it can
// be unit-tested without the Combobox.
export function buildSelectableProviderOptions(
  snapshotEntries: ProviderSnapshotEntry[] | undefined,
): Array<{ id: string; label: string }> {
  return (snapshotEntries ?? [])
    .filter(isSelectableProviderEntry)
    .map((entry) => ({ id: entry.provider, label: entry.label ?? entry.provider }));
}

export function resolveProviderLabel(
  provider: string,
  snapshotEntries: ProviderSnapshotEntry[] | undefined,
): string {
  return snapshotEntries?.find((entry) => entry.provider === provider)?.label ?? provider;
}

export function resolveProviderDefinition(
  provider: string,
  snapshotEntries: ProviderSnapshotEntry[] | undefined,
): AgentProviderDefinition | undefined {
  return buildProviderDefinitions(snapshotEntries).find((definition) => definition.id === provider);
}
