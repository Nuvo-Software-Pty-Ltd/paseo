import { z } from "zod";

// T-12 (synthesis A8) — quota error envelope.
//
// Operator-decided envelope (2026-05-26):
//   { code: "quota_exceeded", quotaClass, current, cap }
//
// Source of truth: @orchestra/cloud-shared/src/quota.ts (PLAN-auth-
// and-shared owns). The AGPL fork MUST NOT import from cloud-shared;
// this module is the duplicate per the open-core-duplication pattern
// (cloud-clone.ts, cloud-webhook-events.ts, cloud-provider-snapshot.ts).
// Anti-drift CI (deferred follow-up #8 from D-1.5 / D-2) covers this
// alongside the other mirrors.
//
// Auth's HTTP 429 response body carries the snake_case wire form; the
// daemon's WS rpc_error.payload mirrors the same fields in camelCase
// (consistent with the daemon's existing wire conventions). The four
// fields propagate end-to-end: auth → daemon (cloud-hmac-fetch parses
// the 429) → WS client (PLAN-app dispatches).
//
// COMPAT(quota_exceeded): added in D-3 for cloud quotas. Old clients
// dispatch on `code` only and fall through to "handler_error" per
// permission.md:259-261. Target removal of the back-compat fall-
// through: 6 months from D-3 ship (per CLAUDE.md protocol-contract
// rule).

/**
 * Open-ended union — the auth side may add new classes (e.g.,
 * `loop_iteration_count`) without breaking the AGPL daemon's parser.
 * Forward-compat per the CLAUDE.md protocol-contract rule.
 */
export type QuotaClass =
  | "workspace_count"
  | "agent_count"
  | "loop_count"
  | "outbound_api_spend"
  | "push_token"
  | "archived_workspace_count"
  | (string & {});

/** Camel-case in-TS shape used by the daemon and WS rpc_error envelope. */
export interface QuotaExceededPayload {
  code: "quota_exceeded";
  quotaClass: QuotaClass;
  current: number;
  cap: number;
}

/** Snake-case wire shape used by auth's HTTP 429 response body. */
export const QuotaExceededWireSchema = z
  .object({
    code: z.literal("quota_exceeded"),
    quota_class: z.string().min(1),
    current: z.number().nonnegative(),
    cap: z.number().nonnegative(),
  })
  .strict();

export type QuotaExceededWire = z.infer<typeof QuotaExceededWireSchema>;

export function fromWireQuotaExceeded(wire: QuotaExceededWire): QuotaExceededPayload {
  return {
    code: "quota_exceeded",
    quotaClass: wire.quota_class,
    current: wire.current,
    cap: wire.cap,
  };
}

export function toWireQuotaExceeded(payload: QuotaExceededPayload): QuotaExceededWire {
  return {
    code: "quota_exceeded",
    quota_class: payload.quotaClass,
    current: payload.current,
    cap: payload.cap,
  };
}

/**
 * Parse an auth-service 429 response body into the typed payload.
 * Returns null when the body doesn't match (e.g., a 429 from an
 * unrelated source, or a malformed payload). The caller treats null
 * the same as no quota info — warn-and-continue or generic error.
 */
export function tryParseQuotaExceededBody(body: string): QuotaExceededPayload | null {
  try {
    const parsed = JSON.parse(body);
    const wire = QuotaExceededWireSchema.safeParse(parsed);
    return wire.success ? fromWireQuotaExceeded(wire.data) : null;
  } catch {
    return null;
  }
}

/**
 * Typed error a daemon-side caller can throw when an outbound HMAC
 * POST returns a quota-violating 429. The session-side wrapper in
 * session.ts catches and emits an rpc_error{code:"quota_exceeded", …}
 * to the originating WS client.
 */
export class QuotaExceededError extends Error {
  readonly code = "quota_exceeded" as const;
  readonly quotaClass: QuotaClass;
  readonly current: number;
  readonly cap: number;
  constructor(payload: QuotaExceededPayload) {
    super(`Quota exceeded for ${payload.quotaClass}: ${payload.current} >= ${payload.cap}`);
    this.name = "QuotaExceededError";
    this.quotaClass = payload.quotaClass;
    this.current = payload.current;
    this.cap = payload.cap;
  }

  toPayload(): QuotaExceededPayload {
    return {
      code: this.code,
      quotaClass: this.quotaClass,
      current: this.current,
      cap: this.cap,
    };
  }
}
