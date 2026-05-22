import { createHmac } from "node:crypto";
import type { Logger } from "pino";

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

export interface CloudHmacFetchResult {
  ok: boolean;
  status?: number;
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
    logger.warn(
      { status: response.status, responseBody: text, url, ...logContext },
      `${failureLabel}: non-2xx response`,
    );
    return { ok: false, status: response.status };
  }

  return { ok: true, status: response.status };
}
