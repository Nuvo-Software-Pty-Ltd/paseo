// Quota error envelope (T8). Operator-locked shape per CROSS-STREAM-SYNTHESIS
// § 2 A8 (commit 9dc8972, 2026-05-26).
//
// Source of truth in the cloud stack:
//   orchestra-cloud-private/packages/cloud-shared/src/schemas.ts
//   exports RpcErrorQuotaSchema + QUOTA_CLASSES.
//
// The paseo-fork app cannot import @orchestra/cloud-shared directly (it
// would couple the AGPL client to a private repo), so the shape is
// re-declared here. PLAN-auth-and-shared Task 17 anti-drift CI is the only
// invariant that guarantees the cloud-shared schema and this local copy
// stay aligned; the integration-audit checklist in STATUS-app.md asserts
// the alignment at PR-merge time.
//
// Wire shape (verbatim from synthesis):
//   { code:"quota_exceeded", quotaClass, current, cap, retryAfterMs? }
// Daemon emits this on WS rpc_error; auth-and-shared returns it on REST
// 429 along with X-RateLimit-* headers.

export const QUOTA_CLASSES = [
  "workspace_count",
  "workspace_archived_count",
  "agent_count",
  "loop_count",
  "outbound_spend",
  "push_token_count",
] as const;

export type QuotaClass = (typeof QUOTA_CLASSES)[number];

export interface QuotaErrorEnvelope {
  code: "quota_exceeded";
  quotaClass: QuotaClass;
  current: number;
  cap: number;
  retryAfterMs?: number;
}

// Returns the envelope when `value` matches the wire shape, or null
// otherwise. Used to parse WS rpc_error payloads and REST 429 bodies via
// the SAME helper — they share the same shape per the operator lock.
export function parseQuotaErrorEnvelope(value: unknown): QuotaErrorEnvelope | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (obj.code !== "quota_exceeded") return null;
  if (typeof obj.quotaClass !== "string") return null;
  if (!QUOTA_CLASSES.includes(obj.quotaClass as QuotaClass)) return null;
  if (typeof obj.current !== "number" || !Number.isFinite(obj.current)) return null;
  if (typeof obj.cap !== "number" || !Number.isFinite(obj.cap)) return null;
  const retryAfterMs =
    typeof obj.retryAfterMs === "number" && Number.isFinite(obj.retryAfterMs)
      ? obj.retryAfterMs
      : undefined;
  return {
    code: "quota_exceeded",
    quotaClass: obj.quotaClass as QuotaClass,
    current: obj.current,
    cap: obj.cap,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

// Per-class user-facing copy. The "Upgrade plan" CTA is a placeholder Day-1
// per PLAN-app.md Task 8 + OQ 3 (Day-1 is "free during beta"); D-4 billing
// flips the destination behind the feature flag.
export interface QuotaErrorCopy {
  message: string;
  primaryCta?: {
    kind: "archive-workspaces" | "close-agent" | "upgrade-plan";
    label: string;
  };
  secondaryCta?: {
    kind: "archive-workspaces" | "close-agent" | "upgrade-plan";
    label: string;
  };
  // push_token_count is silent for the user (operator-only). The UI host
  // can branch on `silent:true` to skip rendering entirely.
  silent?: boolean;
}

export function getQuotaErrorCopy(envelope: QuotaErrorEnvelope): QuotaErrorCopy {
  const { quotaClass, current, cap } = envelope;
  switch (quotaClass) {
    case "workspace_count":
      return {
        message: `You've reached your workspace cap (${current}/${cap}). Archive a workspace or upgrade your plan.`,
        primaryCta: { kind: "archive-workspaces", label: "Archive workspaces" },
        secondaryCta: { kind: "upgrade-plan", label: "Upgrade plan" },
      };
    case "workspace_archived_count":
      return {
        message: `You've reached your archived-workspace cap (${current}/${cap}). Permanently remove some to archive a new one.`,
        secondaryCta: { kind: "upgrade-plan", label: "Upgrade plan" },
      };
    case "agent_count":
      return {
        message: `You've reached the per-workspace agent cap (${current}/${cap}). Close an agent or upgrade your plan.`,
        primaryCta: { kind: "close-agent", label: "Close agent" },
        secondaryCta: { kind: "upgrade-plan", label: "Upgrade plan" },
      };
    case "loop_count":
      return {
        message: `You've reached the per-workspace loop cap (${current}/${cap}). Stop a running loop or upgrade your plan.`,
        secondaryCta: { kind: "upgrade-plan", label: "Upgrade plan" },
      };
    case "outbound_spend":
      return {
        message: `Anthropic spend cap reached for this workspace. Resets on the next billing cycle.`,
        secondaryCta: { kind: "upgrade-plan", label: "Upgrade plan" },
      };
    case "push_token_count":
      // Silent — push-token cap is an operator-visible signal, not a
      // user-visible failure. The UI host should not render anything.
      return {
        message: "",
        silent: true,
      };
    default: {
      // Exhaustiveness: any new QuotaClass added upstream must extend this
      // switch. The unhandled-class fallback message keeps the user
      // unblocked while a hotfix lands.
      const _exhaustive: never = quotaClass;
      void _exhaustive;
      return {
        message: `Quota exceeded (${current}/${cap}).`,
        secondaryCta: { kind: "upgrade-plan", label: "Upgrade plan" },
      };
    }
  }
}
