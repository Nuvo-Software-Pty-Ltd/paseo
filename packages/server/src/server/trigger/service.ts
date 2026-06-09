import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStore } from "../agent/agent-storage.js";
import { formatSystemNotificationPrompt } from "../agent/agent-prompt.js";
import { getCurrentWorkspaceAuth, workspaceAuthStorage } from "../cloud-auth.js";
import { spawnFromAutomation } from "../automation/spawn.js";
import type { ScheduleRun } from "../schedule/types.js";
import type { WebhookTriggerStore } from "./store.js";
import type { TriggerProvisioner } from "./provisioner.js";
import type {
  CreateWebhookTriggerInput,
  UpdateWebhookTriggerInput,
  WebhookTrigger,
} from "./types.js";

// Cap inline run history so a high-frequency webhook can't grow the
// record unboundedly (OQ4). Older runs roll off the inline window.
const MAX_INLINE_RUNS = 50;
// Cap the inbound webhook body injected into the prompt. An external
// webhook body is UNTRUSTED input that becomes part of an agent prompt —
// bound its size and strip control chars (threat note, Task 6).
const MAX_PAYLOAD_CHARS = 8192;
const PAYLOAD_PLACEHOLDER = "{{payload}}";

function trimOptionalName(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error("Trigger prompt is required");
  }
  return trimmed;
}

function fingerprint(secret: string): string {
  return secret.slice(-6);
}

/**
 * Render an untrusted webhook body into a capped, control-char-stripped
 * string. Never injected into shell/tool config — only into prompt text.
 */
function sanitizePayload(payload: unknown): string {
  let serialized: string;
  try {
    serialized = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
  } catch {
    serialized = String(payload);
  }
  // Strip C0/C1 control chars except tab/newline/carriage-return.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate sanitization of untrusted input
  // oxlint-disable-next-line no-control-regex
  const stripped = serialized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "");
  if (stripped.length <= MAX_PAYLOAD_CHARS) {
    return stripped;
  }
  return `${stripped.slice(0, MAX_PAYLOAD_CHARS)}… [truncated ${stripped.length - MAX_PAYLOAD_CHARS} chars]`;
}

function buildTriggerFireBody(trigger: WebhookTrigger, runId: string, payload: unknown): string {
  const heading = trigger.name
    ? `Webhook "${trigger.name}" fired (id=${trigger.id}, run=${runId}).`
    : `Webhook fired (id=${trigger.id}, run=${runId}).`;
  if (trigger.payloadTemplate === null) {
    return `${heading}\n${trigger.prompt}`;
  }
  const rendered = trigger.payloadTemplate.includes(PAYLOAD_PLACEHOLDER)
    ? trigger.payloadTemplate.split(PAYLOAD_PLACEHOLDER).join(sanitizePayload(payload))
    : trigger.payloadTemplate;
  return `${heading}\n${rendered}`;
}

export interface TriggerServiceOptions {
  store: WebhookTriggerStore;
  provisioner: TriggerProvisioner;
  logger: Logger;
  agentManager: AgentManager;
  agentStorage: AgentStore;
  now?: () => Date;
}

/**
 * Result of a create/rotate operation — carries the one-time `secret`
 * alongside the persisted record. The secret is returned to the client
 * exactly once and never re-served.
 */
export interface TriggerWithSecret {
  trigger: WebhookTrigger;
  secret: string;
  ingressUrl: string;
}

export class TriggerService {
  private readonly store: WebhookTriggerStore;
  private readonly provisioner: TriggerProvisioner;
  private readonly logger: Logger;
  private readonly agentManager: AgentManager;
  private readonly agentStorage: AgentStore;
  private readonly now: () => Date;

  constructor(options: TriggerServiceOptions) {
    this.store = options.store;
    this.provisioner = options.provisioner;
    this.logger = options.logger.child({ module: "trigger-service" });
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.now = options.now ?? (() => new Date());
  }

  getStore(): WebhookTriggerStore {
    return this.store;
  }

  async create(input: CreateWebhookTriggerInput): Promise<TriggerWithSecret> {
    const now = this.now();
    const prompt = normalizePrompt(input.prompt);
    // F3: derive cloud-owner claims from the ALS at create-time, never
    // from the wire. On-host (no ALS) → both null.
    const cloudOwner = getCurrentWorkspaceAuth();
    // Persist first (assigns the internal id) with placeholder ingress,
    // then provision the public ingress using that id, then patch the
    // record. Mirrors how the schedule store notifies after persist.
    const created = await this.store.create({
      webhookId: "",
      name: trimOptionalName(input.name),
      prompt,
      target: input.target,
      payloadTemplate: input.payloadTemplate ?? null,
      enabled: input.enabled ?? true,
      ingressUrl: null,
      secretFingerprint: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastFiredAt: null,
      runs: [],
      cloudOwnerWorkspaceId: cloudOwner?.workspaceId ?? null,
      cloudOwnerAccountId: cloudOwner?.accountId ?? null,
    });

    let provisioned;
    try {
      provisioned = await this.provisioner.provision(created.id);
    } catch (err) {
      // Roll back the orphaned record so a failed provision doesn't leave
      // a trigger with no working ingress.
      await this.store.delete(created.id).catch(() => undefined);
      throw err;
    }

    const finalized: WebhookTrigger = {
      ...created,
      webhookId: provisioned.webhookId,
      ingressUrl: provisioned.ingressUrl,
      secretFingerprint: fingerprint(provisioned.secret),
      updatedAt: this.now().toISOString(),
    };
    await this.store.put(finalized);
    return { trigger: finalized, secret: provisioned.secret, ingressUrl: provisioned.ingressUrl };
  }

  async list(): Promise<WebhookTrigger[]> {
    return this.store.list();
  }

  async inspect(id: string): Promise<WebhookTrigger> {
    const trigger = await this.store.get(id);
    if (!trigger) {
      throw new Error(`Webhook trigger not found: ${id}`);
    }
    return trigger;
  }

  async logs(id: string): Promise<ScheduleRun[]> {
    const trigger = await this.inspect(id);
    return [...trigger.runs].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  async update(input: UpdateWebhookTriggerInput): Promise<WebhookTrigger> {
    const trigger = await this.inspect(input.id);
    let updated: WebhookTrigger = trigger;
    if (input.prompt !== undefined) {
      updated = { ...updated, prompt: normalizePrompt(input.prompt) };
    }
    if (input.name !== undefined) {
      updated = { ...updated, name: trimOptionalName(input.name) };
    }
    if (input.target !== undefined) {
      updated = { ...updated, target: input.target };
    }
    if (input.payloadTemplate !== undefined) {
      updated = { ...updated, payloadTemplate: input.payloadTemplate };
    }
    if (input.enabled !== undefined) {
      updated = { ...updated, enabled: input.enabled };
    }
    updated = { ...updated, updatedAt: this.now().toISOString() };
    await this.store.put(updated);
    return updated;
  }

  async setEnabled(id: string, enabled: boolean): Promise<WebhookTrigger> {
    return this.update({ id, enabled });
  }

  async delete(id: string): Promise<void> {
    const trigger = await this.store.get(id);
    await this.store.delete(id);
    if (trigger) {
      await this.provisioner.deprovision(trigger.id, trigger.webhookId).catch((err) => {
        this.logger.warn({ err, triggerId: id }, "deprovision webhook failed (record deleted)");
      });
    }
  }

  async rotateSecret(id: string): Promise<TriggerWithSecret> {
    const trigger = await this.inspect(id);
    // Rotate changes ONLY the secret; the public webhookId/ingressUrl are
    // stable, so reuse the existing record's values (the cloud
    // rotate-webhook-secret route returns {secret} only — VERIFY-3.5d #4).
    const { secret } = await this.provisioner.rotate(trigger.id, trigger.webhookId);
    const updated: WebhookTrigger = {
      ...trigger,
      secretFingerprint: fingerprint(secret),
      updatedAt: this.now().toISOString(),
    };
    await this.store.put(updated);
    return { trigger: updated, secret, ingressUrl: trigger.ingressUrl ?? "" };
  }

  /**
   * Manual test fire from the GUI / `trigger/run-once`. Resolves by
   * internal id and fires with the supplied sample payload.
   */
  async runOnce(id: string, payload: unknown = {}): Promise<WebhookTrigger> {
    const trigger = await this.inspect(id);
    await this.fire(trigger, payload);
    return this.inspect(id);
  }

  /**
   * Resolve a trigger by its public webhookId. Used by the self-host
   * `/hooks/:webhookId` receiver after local signature verification.
   */
  async getByWebhookId(webhookId: string): Promise<WebhookTrigger | null> {
    return this.store.getByWebhookId(webhookId);
  }

  /**
   * Core fire path — shared by the internal webhook-fire route (cloud),
   * the self-host receiver, and manual run-once. Spawns through the SAME
   * `spawnFromAutomation` helper schedules use. A disabled trigger is a
   * logged no-op (never spawns).
   */
  async fire(trigger: WebhookTrigger, payload: unknown): Promise<void> {
    if (!trigger.enabled) {
      this.logger.info({ triggerId: trigger.id }, "webhook fire skipped — trigger disabled");
      return;
    }
    const now = this.now();
    const runId = randomUUID();
    const runningRun: ScheduleRun = {
      id: runId,
      scheduledFor: now.toISOString(),
      startedAt: now.toISOString(),
      endedAt: null,
      status: "running",
      agentId: null,
      output: null,
      error: null,
    };
    await this.appendRun(trigger.id, runningRun, now);

    const wrappedPrompt = formatSystemNotificationPrompt(
      buildTriggerFireBody(trigger, runId, payload),
    );
    const spawn = () =>
      spawnFromAutomation({
        target: trigger.target,
        wrappedPrompt,
        labels: { "paseo.trigger-id": trigger.id, "paseo.trigger-run": runId },
        deps: {
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          logger: this.logger,
        },
      });

    try {
      // Restore ALS at fire time (cloud) so the agent spawn finds its
      // per-spawn credential. On-host (null cloudOwner*) → runs without an
      // ALS context, identical to schedules.
      const result =
        trigger.cloudOwnerWorkspaceId && trigger.cloudOwnerAccountId
          ? await workspaceAuthStorage.run(
              {
                workspaceId: trigger.cloudOwnerWorkspaceId,
                accountId: trigger.cloudOwnerAccountId,
                expiresAt: Number.MAX_SAFE_INTEGER,
              },
              spawn,
            )
          : await spawn();
      await this.finishRun(trigger.id, runId, {
        status: "succeeded",
        agentId: result.agentId,
        output: result.output,
        error: null,
      });
    } catch (error) {
      await this.finishRun(trigger.id, runId, {
        status: "failed",
        agentId: null,
        output: null,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async appendRun(triggerId: string, run: ScheduleRun, now: Date): Promise<void> {
    const trigger = await this.inspect(triggerId);
    const runs = [...trigger.runs, run].slice(-MAX_INLINE_RUNS);
    await this.store.put({
      ...trigger,
      runs,
      lastFiredAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  }

  private async finishRun(
    triggerId: string,
    runId: string,
    patch: {
      status: "succeeded" | "failed";
      agentId: string | null;
      output: string | null;
      error: string | null;
    },
  ): Promise<void> {
    const trigger = await this.inspect(triggerId);
    const now = this.now();
    const runs = trigger.runs.map((run) =>
      run.id === runId ? { ...run, ...patch, endedAt: now.toISOString() } : run,
    );
    await this.store.put({ ...trigger, runs, updatedAt: now.toISOString() });
  }
}
