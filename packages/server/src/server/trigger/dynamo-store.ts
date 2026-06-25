import type { Logger } from "pino";
import { randomBytes } from "node:crypto";
import { resolveDaemonDataTableName, type DynamoLike } from "../cloud-dynamo-client.js";
import { createCloudSharedKeys, type CloudSharedKeys } from "../cloud-shared-mirror.js";
import type { ScheduleRun } from "@getpaseo/protocol/schedule/types";
import { WebhookTriggerSchema, type WebhookTrigger } from "@getpaseo/protocol/trigger/types";
import type { WebhookTriggerStore } from "./store.js";

// D-3.5d — DynamoDB-backed WebhookTriggerStore for cloud mode. Mirrors
// the `DynamoScheduleStore` row layout under a distinct partition:
//   - Trigger meta: pk = "<ws>#trigger", sk = "<triggerId>#meta"
//   - Trigger run:  pk = "<ws>#trigger", sk = "<triggerId>#run#<runId>"
//
// Unlike the schedule store, this store performs NO register/deregister
// notify — webhook ingress provisioning is the `TriggerProvisioner`
// seam's job (bootstrap injects the cloud provisioner when the internal
// URL is present). The store is pure persistence.
//
// `getByWebhookId` queries only THIS workspace's partition (defense in
// depth). The cloud fire route resolves by internal `triggerId` via a
// direct `get()`, so a partition scan is never on the hot fire path.

function generateTriggerId(): string {
  return randomBytes(4).toString("hex");
}

export interface DynamoWebhookTriggerStoreOptions {
  client: DynamoLike;
  workspaceId: string;
  logger: Logger;
  tableName?: string;
  keys?: CloudSharedKeys;
}

export class DynamoWebhookTriggerStore implements WebhookTriggerStore {
  private readonly client: DynamoLike;
  private readonly workspaceId: string;
  private readonly tableName: string;
  private readonly keys: CloudSharedKeys;
  private readonly logger: Logger;

  constructor(options: DynamoWebhookTriggerStoreOptions) {
    this.client = options.client;
    this.workspaceId = options.workspaceId;
    this.tableName = options.tableName ?? resolveDaemonDataTableName();
    this.keys = options.keys ?? createCloudSharedKeys();
    this.logger = options.logger.child({ component: "dynamo-trigger-store" });
  }

  async list(): Promise<WebhookTrigger[]> {
    const result = await this.client.query({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": `${this.workspaceId}#trigger` },
    });
    const items = result.Items ?? [];
    const triggersById = new Map<string, WebhookTrigger>();
    const runsById = new Map<string, ScheduleRun[]>();
    for (const item of items) {
      const sk = String(item.sk);
      if (sk.endsWith("#meta")) {
        const parsed = WebhookTriggerSchema.parse(item.record);
        triggersById.set(parsed.id, parsed);
      } else if (sk.includes("#run#")) {
        const triggerId = sk.split("#run#")[0];
        const run = item.record as ScheduleRun;
        const existing = runsById.get(triggerId) ?? [];
        existing.push(run);
        runsById.set(triggerId, existing);
      }
    }
    const all: WebhookTrigger[] = [];
    for (const [id, trigger] of triggersById) {
      const runs = (runsById.get(id) ?? []).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      all.push({ ...trigger, runs });
    }
    return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(id: string): Promise<WebhookTrigger | null> {
    const metaRes = await this.client.get(
      this.tableName,
      this.keys.workspaceTrigger(this.workspaceId, id),
    );
    if (!metaRes.Item) return null;
    const parsed = WebhookTriggerSchema.parse(metaRes.Item.record);
    const runsRes = await this.client.query({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `${this.workspaceId}#trigger`,
        ":prefix": `${id}#run#`,
      },
    });
    const runs = (runsRes.Items ?? [])
      .map((row) => row.record as ScheduleRun)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return { ...parsed, runs };
  }

  async getByWebhookId(webhookId: string): Promise<WebhookTrigger | null> {
    // Within-partition scan only (defense in depth). Cloud fire resolves
    // by triggerId directly; this exists for parity + self-host-style use.
    const all = await this.list();
    return all.find((trigger) => trigger.webhookId === webhookId) ?? null;
  }

  async create(trigger: Omit<WebhookTrigger, "id">): Promise<WebhookTrigger> {
    const created = WebhookTriggerSchema.parse({ ...trigger, id: generateTriggerId() });
    await this.put(created);
    return created;
  }

  async put(trigger: WebhookTrigger): Promise<void> {
    const key = this.keys.workspaceTrigger(this.workspaceId, trigger.id);
    const { runs, ...rest } = trigger;
    await this.client.put({
      TableName: this.tableName,
      Item: {
        ...key,
        triggerId: trigger.id,
        webhookId: trigger.webhookId,
        record: { ...rest, runs: [] as ScheduleRun[] },
        createdAt: trigger.createdAt,
        updatedAt: trigger.updatedAt,
      },
    });
    for (const run of runs) {
      await this.putRun(trigger.id, run);
    }
  }

  async putRun(triggerId: string, run: ScheduleRun): Promise<void> {
    const key = this.keys.workspaceTriggerRun(this.workspaceId, triggerId, run.id);
    await this.client.put({
      TableName: this.tableName,
      Item: {
        ...key,
        triggerId,
        runId: run.id,
        record: run,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        status: run.status,
      },
    });
  }

  async delete(id: string): Promise<void> {
    const res = await this.client.query({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `${this.workspaceId}#trigger`,
        ":prefix": `${id}#`,
      },
    });
    for (const row of res.Items ?? []) {
      await this.client.delete(this.tableName, { pk: String(row.pk), sk: String(row.sk) });
    }
    this.logger.debug({ triggerId: id }, "deleted webhook trigger rows");
  }
}
