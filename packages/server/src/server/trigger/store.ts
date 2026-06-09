import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebhookTriggerSchema, type WebhookTrigger } from "./types.js";

function generateTriggerId(): string {
  return randomBytes(4).toString("hex");
}

export interface WebhookTriggerStore {
  list(): Promise<WebhookTrigger[]>;
  get(id: string): Promise<WebhookTrigger | null>;
  /**
   * Resolve a trigger by its PUBLIC `webhookId`. On-host this scans the
   * store; in cloud mode the authoritative webhookId→workspace map lives
   * in the proprietary ingress, so the cloud fire route resolves by
   * internal `triggerId` via `get()` instead — `getByWebhookId` only ever
   * resolves WITHIN this workspace's own data (defense in depth: a
   * webhookId that isn't in this partition → null → never spawn).
   */
  getByWebhookId(webhookId: string): Promise<WebhookTrigger | null>;
  create(trigger: Omit<WebhookTrigger, "id">): Promise<WebhookTrigger>;
  put(trigger: WebhookTrigger): Promise<void>;
  delete(id: string): Promise<void>;
}

export class FileBackedWebhookTriggerStore implements WebhookTriggerStore {
  constructor(private readonly dir: string) {}

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async list(): Promise<WebhookTrigger[]> {
    await this.ensureDir();
    const entries = await readdir(this.dir, { withFileTypes: true });
    const triggers = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const content = await readFile(join(this.dir, entry.name), "utf-8");
          return WebhookTriggerSchema.parse(JSON.parse(content));
        }),
    );
    return triggers.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(id: string): Promise<WebhookTrigger | null> {
    await this.ensureDir();
    try {
      const content = await readFile(this.filePath(id), "utf-8");
      return WebhookTriggerSchema.parse(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async getByWebhookId(webhookId: string): Promise<WebhookTrigger | null> {
    const all = await this.list();
    return all.find((trigger) => trigger.webhookId === webhookId) ?? null;
  }

  async create(trigger: Omit<WebhookTrigger, "id">): Promise<WebhookTrigger> {
    // Re-parse through the schema so `.default(null)` fields populate
    // uniformly — matching what list()/get() return after disk re-parse.
    const created = WebhookTriggerSchema.parse({
      ...trigger,
      id: generateTriggerId(),
    });
    await this.put(created);
    return created;
  }

  async put(trigger: WebhookTrigger): Promise<void> {
    await this.ensureDir();
    await writeFile(this.filePath(trigger.id), JSON.stringify(trigger, null, 2), "utf-8");
  }

  async delete(id: string): Promise<void> {
    await this.ensureDir();
    await rm(this.filePath(id), { force: true });
  }
}
