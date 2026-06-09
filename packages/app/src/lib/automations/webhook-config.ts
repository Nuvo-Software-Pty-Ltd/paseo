// D-3.5d — pure helpers for the "how to call this webhook" configuration
// instructions surfaced on the create-success reveal and the webhook detail
// screen. These strings are rendered verbatim to users wiring up an external
// caller, so they MUST match what the server actually verifies.
//
// Verified contract (both cloud + self-host share the canonical
// `webhook-signature.ts` verifier — they differ ONLY in the header name):
//
//   Cloud ingress (Orchestra control plane):
//     POST https://hooks.<stage>.orchestra.nuvo.software/t/<webhookId>
//     header `X-Orchestra-Signature`
//     — orchestra-cloud-private packages/auth/src/routes/webhook-ingress.ts:53,89
//     — register returns ingressUrl `<host>/t/<webhookId>`
//       (webhook-register.ts:160)
//
//   Self-host receiver (this daemon):
//     POST <daemonBaseUrl>/hooks/<webhookId>
//     header `X-Paseo-Signature`
//     — packages/server/src/server/trigger/self-host-receiver.ts:16,76,81
//
//   Both verify: v1 = HMAC_SHA256(secret, "<unixSeconds>.<rawBody>"), lowercase
//   hex, no prefix; header value `t=<unixSeconds>,v1=<hex>`; the request must
//   arrive within ±300s of `t` (REPLAY_WINDOW_S / WEBHOOK_SIGNATURE_TOLERANCE
//   _SECONDS). The raw request body maps to `{{payload}}` (parsed JSON, or the
//   raw string if it is not valid JSON).

export const WEBHOOK_METHOD = "POST";

export const CLOUD_SIGNATURE_HEADER = "X-Orchestra-Signature";
export const SELF_HOST_SIGNATURE_HEADER = "X-Paseo-Signature";

// The cloud control plane registers the public ingress at `/t/<webhookId>`,
// while the self-host receiver mounts `/hooks/<webhookId>`. The signature
// header differs accordingly. We discriminate on the URL PATH segment, not a
// substring of the host — the cloud host itself begins with `hooks.`.
export function webhookSignatureHeaderName(ingressUrl: string): string {
  return ingressPath(ingressUrl).startsWith("/hooks/")
    ? SELF_HOST_SIGNATURE_HEADER
    : CLOUD_SIGNATURE_HEADER;
}

function ingressPath(ingressUrl: string): string {
  const withoutScheme = ingressUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const slash = withoutScheme.indexOf("/");
  return slash === -1 ? "" : withoutScheme.slice(slash);
}

export const WEBHOOK_HOW_TO_SIGN =
  "Sign every request with HMAC-SHA256. Compute v1 = HMAC-SHA256(secret, " +
  '"<unix seconds>.<raw body>") as lowercase hex, then send the header value ' +
  "as t=<unix seconds>,v1=<hex>.";

export const WEBHOOK_SIGNATURE_TOLERANCE_NOTE =
  "The request must arrive within 5 minutes of the timestamp, or it is rejected.";

export const WEBHOOK_PAYLOAD_TEMPLATE_NOTE =
  "If you set a payload template, {{payload}} is replaced with the request body " +
  "(parsed JSON, or raw text if it isn't JSON) when the agent runs.";

const DEFAULT_EXAMPLE_BODY = '{"hello":"world"}';

interface WebhookCurlExampleInput {
  ingressUrl: string;
  /** The example request body. Defaults to a tiny JSON object. */
  body?: string;
}

// A copy-paste-ready shell snippet. The secret is a placeholder (it is shown
// exactly once and should not be embedded in a shared command), but the
// signature is computed for real with openssl so the snippet works once the
// caller pastes their secret in.
export function buildWebhookCurlExample({ ingressUrl, body }: WebhookCurlExampleInput): string {
  const header = webhookSignatureHeaderName(ingressUrl);
  const exampleBody = body ?? DEFAULT_EXAMPLE_BODY;
  return [
    "SECRET='<your-signing-secret>'",
    `BODY='${exampleBody}'`,
    "TS=$(date +%s)",
    `SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')`,
    `curl -X POST '${ingressUrl}' \\`,
    "  -H 'Content-Type: application/json' \\",
    `  -H "${header}: t=$TS,v1=$SIG" \\`,
    '  -d "$BODY"',
  ].join("\n");
}
