import { describe, expect, it } from "vitest";

import {
  WEBHOOK_HOW_TO_SIGN,
  WEBHOOK_METHOD,
  WEBHOOK_PAYLOAD_TEMPLATE_NOTE,
  WEBHOOK_SIGNATURE_TOLERANCE_NOTE,
  buildWebhookCurlExample,
  webhookSignatureHeaderName,
} from "@/lib/automations/webhook-config";

// D-3.5d — these instructions are rendered verbatim to users configuring an
// external caller. They MUST match what the server actually verifies:
//   - Cloud ingress (`/t/<id>`):   header `X-Orchestra-Signature`
//   - Self-host receiver (`/hooks/<id>`): header `X-Paseo-Signature`
// Both verify HMAC-SHA256 over `"<unixSeconds>.<rawBody>"`, hex, format
// `t=<unixSeconds>,v1=<hex>`, within a ±300s window.
const CLOUD_URL = "https://hooks.dev.orchestra.nuvo.software/t/wh_AbC123";
const SELF_HOST_URL = "http://192.168.1.20:6767/hooks/AbC123xyz";

describe("webhookSignatureHeaderName", () => {
  it("uses X-Orchestra-Signature for a cloud /t/ ingress URL", () => {
    expect(webhookSignatureHeaderName(CLOUD_URL)).toBe("X-Orchestra-Signature");
  });

  it("uses X-Paseo-Signature for a self-host /hooks/ ingress URL", () => {
    expect(webhookSignatureHeaderName(SELF_HOST_URL)).toBe("X-Paseo-Signature");
  });

  it("does not mistake the cloud `hooks.` host for a self-host /hooks/ path", () => {
    // The cloud host literally starts with `hooks.` — the discriminator is the
    // PATH segment, not a substring of the host.
    expect(webhookSignatureHeaderName("https://hooks.orchestra.nuvo.software/t/x")).toBe(
      "X-Orchestra-Signature",
    );
  });

  it("defaults to the cloud header when the URL shape is unknown", () => {
    expect(webhookSignatureHeaderName("https://example.com/weird/x")).toBe("X-Orchestra-Signature");
  });
});

describe("buildWebhookCurlExample", () => {
  it("targets the ingress URL with a POST and JSON content-type", () => {
    const curl = buildWebhookCurlExample({ ingressUrl: CLOUD_URL });
    expect(curl).toContain("curl -X POST 'https://hooks.dev.orchestra.nuvo.software/t/wh_AbC123'");
    expect(curl).toContain("-H 'Content-Type: application/json'");
  });

  it("emits the correct signature header for a cloud URL", () => {
    const curl = buildWebhookCurlExample({ ingressUrl: CLOUD_URL });
    expect(curl).toContain("X-Orchestra-Signature: t=$TS,v1=$SIG");
  });

  it("emits the self-host signature header for a /hooks/ URL", () => {
    const curl = buildWebhookCurlExample({ ingressUrl: SELF_HOST_URL });
    expect(curl).toContain("X-Paseo-Signature: t=$TS,v1=$SIG");
  });

  it("computes the signature over `<unixSeconds>.<rawBody>` with HMAC-SHA256", () => {
    const curl = buildWebhookCurlExample({ ingressUrl: CLOUD_URL });
    // timestamp is unix seconds
    expect(curl).toContain("TS=$(date +%s)");
    // signed string is `<t>.<body>` and hashed with sha256 + the secret
    expect(curl).toContain(`printf '%s.%s' "$TS" "$BODY"`);
    expect(curl).toContain('openssl dgst -sha256 -hmac "$SECRET"');
  });

  it("uses a placeholder for the one-time secret rather than embedding it", () => {
    const curl = buildWebhookCurlExample({ ingressUrl: CLOUD_URL });
    expect(curl).toContain("SECRET='<your-signing-secret>'");
    expect(curl).not.toContain("wh_AbC123'\n"); // sanity: webhookId only in URL
  });

  it("lets the caller override the example body", () => {
    const curl = buildWebhookCurlExample({
      ingressUrl: CLOUD_URL,
      body: '{"action":"deploy"}',
    });
    expect(curl).toContain(`BODY='{"action":"deploy"}'`);
  });
});

describe("webhook config copy", () => {
  it("documents POST as the method", () => {
    expect(WEBHOOK_METHOD).toBe("POST");
  });

  it("explains the signing scheme accurately", () => {
    expect(WEBHOOK_HOW_TO_SIGN).toContain("HMAC-SHA256");
    expect(WEBHOOK_HOW_TO_SIGN).toContain("<unix seconds>.<raw body>");
  });

  it("notes the ±5 minute replay window", () => {
    expect(WEBHOOK_SIGNATURE_TOLERANCE_NOTE).toContain("5 minutes");
  });

  it("documents the {{payload}} template substitution", () => {
    expect(WEBHOOK_PAYLOAD_TEMPLATE_NOTE).toContain("{{payload}}");
  });
});
