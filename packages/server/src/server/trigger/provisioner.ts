import { createHmac, randomBytes } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod";
import { cloudHmacFetch } from "../cloud-hmac-fetch.js";
import type { TriggerSecretStore } from "./secret-store.js";
import type { TriggerProvisionResult, TriggerRotateResult } from "./types.js";

// D-3.5d — the ONLY place cloud and self-host webhook triggers differ.
// Resolved exactly like `DynamoScheduleStore.notifyRegister`: the
// discriminator is the PRESENCE/ABSENCE of an injected internal URL, not
// an `if (cloud)` branch. The bootstrap composes the cloud provisioner
// when `ORCHESTRA_AUTH_INTERNAL_URL` is set (registration is auth-owned —
// VERIFY-3.5d #4), and the self-host provisioner otherwise.

export interface TriggerProvisioner {
  /**
   * Provision the public ingress for a freshly-created trigger. Returns
   * the public `webhookId`, the `ingressUrl` to surface in the GUI, and
   * the raw signing `secret` (returned to the client exactly once).
   */
  provision(triggerId: string): Promise<TriggerProvisionResult>;
  /**
   * Rotate the signing secret for an existing trigger. Returns ONLY the
   * new one-time secret — the public webhookId/ingressUrl are stable
   * across a rotate, so the caller reuses the existing record's values.
   */
  rotate(triggerId: string, webhookId: string): Promise<TriggerRotateResult>;
  /** Tear down the public ingress when a trigger is deleted. */
  deprovision(triggerId: string, webhookId: string): Promise<void>;
}

function generateWebhookId(): string {
  // 32 bytes → 256-bit unguessable public id, URL-safe.
  return randomBytes(32).toString("base64url");
}

function generateSecret(): string {
  // 32-byte HMAC-SHA256 signing secret, URL-safe hex-equivalent.
  return randomBytes(32).toString("base64url");
}

/**
 * Self-host provisioner: generates the webhookId + secret locally and
 * points the ingress at the daemon's own `/hooks/<webhookId>` receiver
 * (mounted by bootstrap when no cloud ingress is configured). This makes
 * webhook triggers fully functional with no cloud component.
 */
export class SelfHostTriggerProvisioner implements TriggerProvisioner {
  constructor(
    private readonly baseUrl: string,
    private readonly secretStore: TriggerSecretStore,
  ) {}

  private async buildResult(webhookId: string): Promise<TriggerProvisionResult> {
    const base = this.baseUrl.replace(/\/$/, "");
    const secret = generateSecret();
    // Persist the full secret so the local `/hooks/:webhookId` receiver
    // can verify inbound signatures (the trigger record keeps only a
    // fingerprint). This store is never served over the wire.
    await this.secretStore.put(webhookId, secret);
    return { webhookId, ingressUrl: `${base}/hooks/${webhookId}`, secret };
  }

  async provision(): Promise<TriggerProvisionResult> {
    return this.buildResult(generateWebhookId());
  }

  async rotate(_triggerId: string, webhookId: string): Promise<TriggerRotateResult> {
    // Same public webhookId / URL, new secret (overwrites the stored one,
    // invalidating signatures made with the old secret). Only the secret
    // changes across a rotate, so return it alone.
    const secret = generateSecret();
    await this.secretStore.put(webhookId, secret);
    return { secret };
  }

  async deprovision(_triggerId: string, webhookId: string): Promise<void> {
    await this.secretStore.delete(webhookId);
  }
}

const RegisterWebhookResponseSchema = z.object({
  webhookId: z.string().min(1),
  ingressUrl: z.string().min(1),
  secret: z.string().min(1),
});

// rotate-webhook-secret returns ONLY the new secret — webhookId/ingressUrl
// are stable across a rotate (the route never re-issues them).
const RotateWebhookResponseSchema = z.object({
  secret: z.string().min(1),
});

export interface CloudTriggerProvisionerOptions {
  internalUrl: string;
  hmacKey: string;
  workspaceId: string;
  accountId: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

/**
 * Cloud provisioner: HMAC-POSTs the auth-service `/api/auth-internal/*`
 * register/rotate/deregister routes (VERIFY-3.5d #4 — registration is
 * co-located in auth, the service that owns the ingress + secret store,
 * so no cross-service KMS grant is needed). The control plane generates +
 * stores the secret and owns the global `webhook-route#<webhookId>` →
 * triggerId map; the daemon persists only `ingressUrl` +
 * `secretFingerprint` and passes the one-time secret straight through to
 * the create/rotate RPC response.
 *
 * Reuses `cloudHmacFetch` (same primitive as schedule register) but needs
 * the response body, so it performs the signed fetch and parses the JSON
 * directly rather than via the void-returning helper path.
 */
export class CloudTriggerProvisioner implements TriggerProvisioner {
  private readonly internalUrl: string;
  private readonly hmacKey: string;
  private readonly workspaceId: string;
  private readonly accountId: string;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CloudTriggerProvisionerOptions) {
    this.internalUrl = options.internalUrl.replace(/\/$/, "");
    this.hmacKey = options.hmacKey;
    this.workspaceId = options.workspaceId;
    this.accountId = options.accountId;
    this.logger = options.logger.child({ component: "cloud-trigger-provisioner" });
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<unknown> {
    const body = JSON.stringify({ workspaceId: this.workspaceId, ...payload });
    const hmac = createHmac("sha256", this.hmacKey).update(body).digest("hex");
    const res = await this.fetchImpl(`${this.internalUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Orchestra-Internal-HMAC": hmac },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      this.logger.warn(
        { path, status: res.status, responseBody: text },
        "register-webhook non-2xx",
      );
      throw new Error(`register-webhook ${path} failed (status=${res.status})`);
    }
    return res.json();
  }

  async provision(triggerId: string): Promise<TriggerProvisionResult> {
    const raw = await this.post("/api/auth-internal/register-webhook", {
      accountId: this.accountId,
      triggerId,
    });
    return RegisterWebhookResponseSchema.parse(raw);
  }

  async rotate(triggerId: string, webhookId: string): Promise<TriggerRotateResult> {
    const raw = await this.post("/api/auth-internal/rotate-webhook-secret", {
      triggerId,
      webhookId,
    });
    return RotateWebhookResponseSchema.parse(raw);
  }

  async deprovision(triggerId: string, webhookId: string): Promise<void> {
    await cloudHmacFetch({
      url: `${this.internalUrl}/api/auth-internal/deregister-webhook`,
      hmacKey: this.hmacKey,
      body: JSON.stringify({ workspaceId: this.workspaceId, triggerId, webhookId }),
      logger: this.logger,
      fetchImpl: this.fetchImpl,
      logContext: { triggerId, webhookId, workspaceId: this.workspaceId },
      failureLogLabel: "deregister-webhook",
    });
  }
}
