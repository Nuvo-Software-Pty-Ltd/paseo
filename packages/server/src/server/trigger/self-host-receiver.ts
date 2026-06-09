import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, text } from "express";
import type { Logger } from "pino";
import type { TriggerSecretStore } from "./secret-store.js";
import type { TriggerService } from "./service.js";

// D-3.5d — self-host public webhook receiver: POST /hooks/:webhookId.
//
// Mounted ONLY when no cloud ingress is configured (the open-core
// discriminator — cloud deployments rely on the proprietary edge instead
// and never expose this). Verifies the per-trigger signature LOCALLY
// against the stored secret, then fires through the same
// `TriggerService.fire` path as the cloud route.
//
// Signature scheme (Stripe-style, fail-closed): header
//   X-Paseo-Signature: t=<unixSeconds>,v1=<hex-hmac-sha256>
// where the signed payload is `${t}.${rawBody}`. A ±REPLAY_WINDOW_S
// timestamp window bounds replay; the compare is timing-safe.
//
// Self-host operators exposing /hooks/* are responsible for TLS
// termination (threat note).

const REPLAY_WINDOW_S = 300;
const MAX_BODY_BYTES = 1024 * 256; // 256 KiB cap on inbound webhook bodies

function parseSignatureHeader(header: string | undefined): { t: number; v1: string } | null {
  if (!header) return null;
  let t: number | null = null;
  let v1: string | null = null;
  for (const part of header.split(",")) {
    const [key, value] = part.split("=");
    if (key === "t") {
      const n = Number(value);
      if (Number.isFinite(n)) t = n;
    } else if (key === "v1") {
      v1 = value ?? null;
    }
  }
  if (t === null || !v1) return null;
  return { t, v1 };
}

function verifySignature(params: {
  rawBody: string;
  secret: string;
  header: string | undefined;
  nowS: number;
}): boolean {
  const parsed = parseSignatureHeader(params.header);
  if (!parsed) return false;
  if (Math.abs(params.nowS - parsed.t) > REPLAY_WINDOW_S) return false;
  const expected = createHmac("sha256", params.secret)
    .update(`${parsed.t}.${params.rawBody}`)
    .digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(parsed.v1, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export interface SelfHostReceiverOptions {
  triggerService: TriggerService;
  secretStore: TriggerSecretStore;
  logger: Logger;
  now?: () => Date;
}

export function createSelfHostWebhookReceiver(options: SelfHostReceiverOptions): Router {
  const router = Router();
  const { triggerService, secretStore, logger } = options;
  const now = options.now ?? (() => new Date());

  // Raw text parser so we can HMAC the exact bytes the client signed.
  router.use("/hooks", text({ type: () => true, limit: MAX_BODY_BYTES }));

  router.post("/hooks/:webhookId", (req, res) => {
    void (async () => {
      const webhookId = String(req.params.webhookId ?? "");
      const rawBody = typeof req.body === "string" ? req.body : "";
      const secret = await secretStore.get(webhookId);
      const sigHeader = req.headers["x-paseo-signature"] as string | undefined;
      // Fail closed: unknown webhookId / missing-or-bad signature → 401
      // with NO spawn, no information leak about whether the id exists.
      if (
        !secret ||
        !verifySignature({
          rawBody,
          secret,
          header: sigHeader,
          nowS: Math.floor(now().getTime() / 1000),
        })
      ) {
        logger.warn({ webhookId }, "self-host webhook receiver: signature rejected");
        res.status(401).json({ error: "invalid_signature" });
        return;
      }
      const trigger = await triggerService.getByWebhookId(webhookId);
      if (!trigger) {
        res.status(404).json({ error: "trigger_not_found" });
        return;
      }
      let payload: unknown = rawBody;
      try {
        payload = rawBody.length > 0 ? JSON.parse(rawBody) : {};
      } catch {
        // Non-JSON body — pass the raw string through; the templating
        // layer sanitizes it.
      }
      try {
        await triggerService.fire(trigger, payload);
        res.status(200).json({ ok: true, triggerId: trigger.id });
      } catch (err) {
        logger.error({ err, webhookId }, "self-host webhook fire failed");
        res.status(500).json({ error: "fire_failed" });
      }
    })();
  });

  return router;
}
