import { createHmac } from "node:crypto";
import type { Logger } from "pino";
import { tryParseQuotaExceededBody, type QuotaExceededPayload } from "./cloud-quota.js";

// Shared HMAC envelope for daemon → auth-service outbound POSTs in cloud
// mode. Computes HMAC-SHA256 over the (pre-serialized) JSON body and
// attaches it as X-Orchestra-Internal-HMAC. Warn-and-continue on network /
// non-2xx — never throws.
//
// Three call sites today (cloud-version-beacon, cloud-webhook-emit,
// cloud-heartbeat) share the same envelope; this helper exists so adding
// a fourth doesn't tempt a fourth inline copy. The auth-service-side
// verifier expects exactly this header name + algorithm.
//
// F3 design-out: the helper is identity-agnostic — the caller passes a
// fully-built body. No ALS, no JWT, no workspace lookup in here.

export interface CloudHmacFetchParams {
  url: string;
  hmacKey: string;
  body: string;
  logger: Logger;
  // Test seam: inject a fetch impl instead of using the global. Production
  // callers omit; tests pass a vi.fn().
  fetchImpl?: typeof fetch;
  // Extra structured fields attached to warn-level logs on failure. Lets
  // each call site name itself (e.g., { eventType, workspaceId }) so an
  // operator triaging logs can tell which envelope failed.
  logContext?: Record<string, unknown>;
  // Stable label for the failure log message. Defaults to a generic.
  failureLogLabel?: string;
}

/**
 * Parsed `Retry-After` / `X-RateLimit-*` headers from an auth-side
 * 429 response. Surfaced to the caller alongside the optional
 * quotaPayload so a session-side handler can pass the limits through
 * to the client (PLAN-app dispatch).
 */
export interface RateLimitHeaders {
  retryAfterSeconds?: number;
  rateLimitRemaining?: number;
  rateLimitLimit?: number;
  rateLimitReset?: number;
}

export interface CloudHmacFetchResult {
  ok: boolean;
  status?: number;
  /**
   * T-12 (synthesis A8): when the response is a 429 with a parseable
   * QuotaExceededWire body, this field carries the typed payload.
   * Other 4xx/5xx responses leave it undefined.
   */
  quotaPayload?: QuotaExceededPayload;
  /**
   * T-12 (synthesis A8): RFC 6585 / draft-ietf-httpapi-ratelimit-headers
   * fields parsed from the response. Always undefined on success or on
   * non-429 errors.
   */
  rateLimitHeaders?: RateLimitHeaders;
}

function parseRateLimitHeaders(headers: Headers): RateLimitHeaders | undefined {
  const retryAfter = headers.get("Retry-After");
  const limit = headers.get("X-RateLimit-Limit");
  const remaining = headers.get("X-RateLimit-Remaining");
  const reset = headers.get("X-RateLimit-Reset");
  if (!retryAfter && !limit && !remaining && !reset) return undefined;
  const out: RateLimitHeaders = {};
  if (retryAfter) {
    const n = Number(retryAfter);
    if (Number.isFinite(n)) out.retryAfterSeconds = n;
  }
  if (limit) {
    const n = Number(limit);
    if (Number.isFinite(n)) out.rateLimitLimit = n;
  }
  if (remaining) {
    const n = Number(remaining);
    if (Number.isFinite(n)) out.rateLimitRemaining = n;
  }
  if (reset) {
    const n = Number(reset);
    if (Number.isFinite(n)) out.rateLimitReset = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function cloudHmacFetch(params: CloudHmacFetchParams): Promise<CloudHmacFetchResult> {
  const { url, hmacKey, body, logger } = params;
  const doFetch = params.fetchImpl ?? fetch;
  const logContext = params.logContext ?? {};
  const failureLabel = params.failureLogLabel ?? "cloud HMAC fetch";

  const hmac = createHmac("sha256", hmacKey).update(body).digest("hex");

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Orchestra-Internal-HMAC": hmac,
      },
      body,
    });
  } catch (err) {
    logger.warn({ err, url, ...logContext }, `${failureLabel}: network failure`);
    return { ok: false };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const rateLimitHeaders = parseRateLimitHeaders(response.headers);
    // T-12 (synthesis A8): a 429 may carry a typed quota payload.
    // Parse opportunistically; other 4xx/5xx leave the field
    // undefined.
    const quotaPayload =
      response.status === 429 ? (tryParseQuotaExceededBody(text) ?? undefined) : undefined;
    logger.warn(
      {
        status: response.status,
        responseBody: text,
        url,
        ...(quotaPayload ? { quotaClass: quotaPayload.quotaClass } : {}),
        ...logContext,
      },
      `${failureLabel}: non-2xx response`,
    );
    return {
      ok: false,
      status: response.status,
      ...(quotaPayload ? { quotaPayload } : {}),
      ...(rateLimitHeaders ? { rateLimitHeaders } : {}),
    };
  }

  return { ok: true, status: response.status };
}
