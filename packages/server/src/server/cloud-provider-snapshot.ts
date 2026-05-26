import type { ProviderSnapshotEntry } from "./agent/agent-sdk-types.js";

// F1 design-out (synthesis C2, 2026-05-26): the cloud daemon does NOT pull
// the provider catalog from a running container or from S3. It serves a
// static catalog mirrored from `@orchestra/cloud-shared/src/providers.ts`.
// Source of truth (proprietary side):
//   - PROVIDER_SNAPSHOT (the array below)
//   - PROVIDER_SNAPSHOT_VERSION (the version string below)
//
// The AGPL fork MUST NOT import from `@orchestra/cloud-shared`. This
// module is the AGPL-side duplicate; anti-drift CI (deferred follow-up #8
// from D-1.5 / D-2 — single sweep post-D-3) enforces equality between
// this file and the cloud-shared source.
//
// COMPAT(provider-snapshot): payload pinned by
// @orchestra/cloud-shared/src/providers.ts (PLAN-auth-and-shared D-3 Task 7).
// Auth's GET /api/v1/cloud/providers/snapshot serves the same constant to
// PLAN-app. Same lifecycle as the daemon image — the constant rotates only
// on a daemon redeploy. No env var, no S3 fetch, no Docker COPY step.
//
// On-host self-host operators get the existing per-cwd refresh path
// (provider-snapshot-manager.ts default) and never read this constant —
// the cloud-mode branch in ProviderSnapshotManager.getSnapshot is the
// single discriminator (F11 preserved).
//
// Open-core boundary: same duplication pattern as `cloud-clone.ts`
// (GitHub-token Secrets Manager id template), `cloud-webhook-events.ts`
// (D-2 webhook event schemas), and `cloud-quota.ts` (D-3 T-12 quota
// envelope). The AGPL fork ships the shape; cloud-shared serves the
// authoritative copy that other proprietary modules import.

export const CLOUD_PROVIDER_SNAPSHOT_VERSION = "2026.05-1";

export const CLOUD_PROVIDER_SNAPSHOT: readonly ProviderSnapshotEntry[] = [
  {
    provider: "claude",
    status: "ready",
    enabled: true,
    label: "Claude",
    description: "Anthropic Claude via @anthropic-ai/claude-agent-sdk.",
    defaultModeId: "default",
    fetchedAt: "2026-05-26T00:00:00.000Z",
    models: [
      {
        provider: "claude",
        id: "claude-opus-4-7",
        label: "Claude Opus 4.7",
        description: "Anthropic's most capable model. 1M context.",
        isDefault: true,
      },
      {
        provider: "claude",
        id: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        description: "Balanced quality and speed.",
      },
      {
        provider: "claude",
        id: "claude-haiku-4-5",
        label: "Claude Haiku 4.5",
        description: "Fastest. Suitable for high-throughput workflows.",
      },
    ],
    modes: [
      { id: "default", label: "Default", description: "Permission-gated tool calls." },
      { id: "acceptEdits", label: "Accept edits", description: "Auto-allow file edits." },
      { id: "bypassPermissions", label: "Bypass", description: "No permission gates." },
      { id: "plan", label: "Plan", description: "Discuss before acting." },
    ],
  },
] as const;
