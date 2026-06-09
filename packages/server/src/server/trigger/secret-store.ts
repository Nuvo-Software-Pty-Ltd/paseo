import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// D-3.5d — self-host-only secret store. In self-host mode the daemon
// generates the per-trigger signing secret AND verifies inbound webhook
// signatures locally, so it must retain the full secret (the public
// `WebhookTrigger` record keeps only a fingerprint, matching the cloud
// invariant where the raw secret lives solely in the control plane).
//
// This store is NEVER served over the wire — it backs only the self-host
// `/hooks/:webhookId` receiver's signature check. Keyed by the public
// `webhookId` (URL-safe), one file per secret under
// `$PASEO_HOME/triggers/secrets/`.
export interface TriggerSecretStore {
  get(webhookId: string): Promise<string | null>;
  put(webhookId: string, secret: string): Promise<void>;
  delete(webhookId: string): Promise<void>;
}

export class FileBackedTriggerSecretStore implements TriggerSecretStore {
  constructor(private readonly dir: string) {}

  private filePath(webhookId: string): string {
    // webhookId is base64url (no path separators) — safe as a filename.
    return join(this.dir, `${webhookId}.secret`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async get(webhookId: string): Promise<string | null> {
    try {
      return (await readFile(this.filePath(webhookId), "utf-8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async put(webhookId: string, secret: string): Promise<void> {
    await this.ensureDir();
    await writeFile(this.filePath(webhookId), secret, { encoding: "utf-8", mode: 0o600 });
  }

  async delete(webhookId: string): Promise<void> {
    await rm(this.filePath(webhookId), { force: true });
  }
}
