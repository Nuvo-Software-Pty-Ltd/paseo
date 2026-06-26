import type { ProviderSnapshotEntry } from "./agent/agent-sdk-types.js";
import {
  CLAUDE_OPUS_EXTENDED_THINKING_OPTIONS,
  CLAUDE_THINKING_OPTIONS,
  CLAUDE_ULTRACODE_THINKING_OPTIONS,
} from "./agent/providers/claude/models.js";

// F1 design-out (synthesis C2, 2026-05-26): the cloud daemon does NOT pull
// the provider catalog from a running container or from S3. It serves a
// static catalog at cloud-mode boot, baked into the daemon image.
//
// IMPORTANT — round-3 audit clarification (closes integration-audit B5):
// this file is the DAEMON-INTERNAL cloud-mode catalog. The shape is
// `ProviderSnapshotEntry` (defined in `agent/agent-sdk-types.ts`), which is
// the daemon's own internal type used by `ProviderSnapshotManager` to
// describe per-cwd provider availability. The static cloud-mode array
// below is what `ProviderSnapshotManager.getSnapshot()` returns when
// `isPaseoCloudMode()` is true — bypassing the per-cwd binary probe.
//
// `@orchestra/cloud-shared/src/providers.ts` is a SEPARATE, app-facing
// manifest with a different shape (`Provider` — used by the mobile app's
// "Add agent" picker to render labels, icons, and feature flags). The two
// are NOT a verbatim mirror, despite both being named with "provider":
//   - This file:      `ProviderSnapshotEntry[]`   (daemon-internal,
//                                                  per-cwd availability)
//   - cloud-shared:   `Provider[]`                (app-facing UI manifest)
//
// On-host self-host operators get the existing per-cwd refresh path
// (provider-snapshot-manager.ts default) and never read this constant —
// the cloud-mode branch in ProviderSnapshotManager.getSnapshot is the
// single discriminator (F11 preserved).
//
// CATALOG SYNC: the Claude `models` list below is a curated mirror of the
// on-host catalog in `agent/providers/claude/models.ts` (`getClaudeModels()`).
// Cloud keeps its own end-user `label`/`description` copy, but the model
// **ids**, **isDefault**, and **thinkingOptions** must stay in lock-step with
// `getClaudeModels()`. `cloud-provider-snapshot.test.ts` enforces this — a
// model added to `models.ts` that is not added here (the 0.1.99 drift) fails
// that test. Reuse the thinking-option constants from `models.ts` rather than
// re-declaring them so effort tiers can't drift.
//
// COMPAT(provider-snapshot): the wire shape `ProviderSnapshotEntry` is
// part of the daemon's WS protocol contract; new fields must be optional
// + back-compat per CLAUDE.md. Catalog versioning is tracked by
// `CLOUD_PROVIDER_SNAPSHOT_VERSION` below — bump on every release.

export const CLOUD_PROVIDER_SNAPSHOT_VERSION = "2026.06-1";

export const CLOUD_PROVIDER_SNAPSHOT: readonly ProviderSnapshotEntry[] = [
  {
    provider: "claude",
    status: "ready",
    enabled: true,
    label: "Claude",
    description: "Anthropic Claude via @anthropic-ai/claude-agent-sdk.",
    defaultModeId: "default",
    fetchedAt: "2026-06-26T00:00:00.000Z",
    models: [
      {
        provider: "claude",
        id: "claude-fable-5",
        label: "Claude Fable 5",
        description: "Anthropic's most powerful model. 1M context.",
        thinkingOptions: [...CLAUDE_ULTRACODE_THINKING_OPTIONS],
      },
      {
        provider: "claude",
        id: "claude-opus-4-8[1m]",
        label: "Claude Opus 4.8 1M",
        description: "Most capable model, with a 1M-token context window.",
        thinkingOptions: [...CLAUDE_ULTRACODE_THINKING_OPTIONS],
      },
      {
        provider: "claude",
        id: "claude-opus-4-8",
        label: "Claude Opus 4.8",
        description: "Anthropic's most capable model.",
        isDefault: true,
        thinkingOptions: [...CLAUDE_ULTRACODE_THINKING_OPTIONS],
      },
      {
        provider: "claude",
        id: "claude-opus-4-7[1m]",
        label: "Claude Opus 4.7 1M",
        description: "Previous flagship, with a 1M-token context window.",
        thinkingOptions: [...CLAUDE_OPUS_EXTENDED_THINKING_OPTIONS],
      },
      {
        provider: "claude",
        id: "claude-opus-4-7",
        label: "Claude Opus 4.7",
        description: "Previous-generation flagship model.",
        thinkingOptions: [...CLAUDE_OPUS_EXTENDED_THINKING_OPTIONS],
      },
      {
        provider: "claude",
        id: "claude-opus-4-6[1m]",
        label: "Claude Opus 4.6 1M",
        description: "Capable for complex work, with a 1M-token context window.",
        thinkingOptions: [...CLAUDE_THINKING_OPTIONS],
      },
      {
        provider: "claude",
        id: "claude-opus-4-6",
        label: "Claude Opus 4.6",
        description: "Capable for complex, long-running work.",
        thinkingOptions: [...CLAUDE_THINKING_OPTIONS],
      },
      {
        provider: "claude",
        id: "claude-sonnet-4-6[1m]",
        label: "Claude Sonnet 4.6 1M",
        description: "Balanced quality and speed, with a 1M-token context window.",
        thinkingOptions: [...CLAUDE_THINKING_OPTIONS],
      },
      {
        provider: "claude",
        id: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        description: "Balanced quality and speed.",
        thinkingOptions: [...CLAUDE_THINKING_OPTIONS],
      },
      {
        provider: "claude",
        id: "claude-haiku-4-5",
        label: "Claude Haiku 4.5",
        description: "Fastest. Suitable for high-throughput workflows.",
      },
    ],
    modes: [
      {
        id: "default",
        label: "Default",
        description: "Permission-gated tool calls.",
      },
      {
        id: "acceptEdits",
        label: "Accept edits",
        description: "Auto-allow file edits.",
      },
      {
        id: "bypassPermissions",
        label: "Bypass",
        description: "No permission gates.",
      },
      { id: "plan", label: "Plan", description: "Discuss before acting." },
    ],
  },
] as const;
