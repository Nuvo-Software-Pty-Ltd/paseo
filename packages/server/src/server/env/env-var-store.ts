import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Logger } from "pino";
import { z } from "zod";

// D-3.5c — scoped environment variables. A user sets env vars at two
// scopes — the workspace container (`workspace`, keyed by the 3.5a
// container `workspaceId`) and an individual project (`project`, keyed by
// `projectId`) — and they are injected into BOTH spawned agent
// subprocesses and terminal (PTY) sessions. Storage + injection live in
// the AGPL core (a self-host user gets the feature for free); cloud only
// swaps the file-backed store for the Dynamo-backed one through the
// existing `isPaseoCloudMode()` construction discriminator.
//
// This store is a sibling of the project / workspace registries: on-host
// it lives beside `projects.json` / `workspaces.json` under
// `$PASEO_HOME/projects/env-vars.json`; in cloud it is a Dynamo partition
// (`<ws>#envvar`). See `dynamo-env-var-store.ts` for the cloud impl and
// `scoped-env-resolver.ts` for the shared resolver both injection sites use.

export const ScopedEnvVarScopeSchema = z.enum(["workspace", "project"]);
export type ScopedEnvVarScope = z.infer<typeof ScopedEnvVarScopeSchema>;

export const ScopedEnvVarRecordSchema = z.object({
  scope: ScopedEnvVarScopeSchema,
  // workspace scope: the container `workspaceId` (`ws_<id>` / `ws_local`);
  // project scope: the `projectId`. This is the 3.5a entity id the var
  // attaches to — NOT a per-cwd path id (see scoped-env-resolver.ts).
  scopeId: z.string(),
  // Env var name. Validated at the RPC edge (charset, length cap,
  // reserved-key reject — see scoped-env-resolver.ts:validateEnvVarKey).
  key: z.string(),
  value: z.string(),
  // Marks "do not echo back the value on list" — the RPC layer returns a
  // masked placeholder and the UI shows `••••`. The value is still stored
  // verbatim (DDB at-rest encryption + tenant LeadingKeys in cloud; 0o600
  // file on-host). Day-N hardening may route truly-secret values to a
  // per-workspace secrets manager (daemon OQ-3); the flag makes that
  // upgrade additive.
  secret: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ScopedEnvVarRecord = z.infer<typeof ScopedEnvVarRecordSchema>;

const StoredEnvVarsSchema = z.array(ScopedEnvVarRecordSchema);

export interface EnvVarStore {
  listForScope(scope: ScopedEnvVarScope, scopeId: string): Promise<ScopedEnvVarRecord[]>;
  upsert(record: ScopedEnvVarRecord): Promise<void>;
  remove(scope: ScopedEnvVarScope, scopeId: string, key: string): Promise<void>;
}

// Identity of a record within the store: one value per (scope, scopeId, key).
function recordIdentity(scope: ScopedEnvVarScope, scopeId: string, key: string): string {
  return `${scope}#${scopeId}#${key}`;
}

// On-host file-backed store. Mirrors the atomic temp-file+rename /
// in-memory-cache precedent of FileBackedProjectRegistry. The file is
// written `0o600` (env vars hold MCP-server API tokens) and lives under
// `$PASEO_HOME/projects/` because it is part of the same 3.5a record model.
export class FileBackedEnvVarStore implements EnvVarStore {
  private readonly filePath: string;
  private readonly logger: Logger;
  private loaded = false;
  private readonly cache = new Map<string, ScopedEnvVarRecord>();
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(options: { paseoHome: string; logger: Logger }) {
    this.filePath = path.join(options.paseoHome, "projects", "env-vars.json");
    this.logger = options.logger.child({ component: "env-var-store" });
  }

  async listForScope(scope: ScopedEnvVarScope, scopeId: string): Promise<ScopedEnvVarRecord[]> {
    await this.load();
    return Array.from(this.cache.values()).filter(
      (record) => record.scope === scope && record.scopeId === scopeId,
    );
  }

  async upsert(record: ScopedEnvVarRecord): Promise<void> {
    await this.load();
    const parsed = ScopedEnvVarRecordSchema.parse(record);
    this.cache.set(recordIdentity(parsed.scope, parsed.scopeId, parsed.key), parsed);
    await this.enqueuePersist();
  }

  async remove(scope: ScopedEnvVarScope, scopeId: string, key: string): Promise<void> {
    await this.load();
    if (!this.cache.delete(recordIdentity(scope, scopeId, key))) {
      return;
    }
    await this.enqueuePersist();
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.cache.clear();
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = StoredEnvVarsSchema.parse(JSON.parse(raw));
      for (const record of parsed) {
        this.cache.set(recordIdentity(record.scope, record.scopeId, record.key), record);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.error(
          { err: error, filePath: this.filePath },
          "Failed to load env-var store file",
        );
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const records = Array.from(this.cache.values());
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    // 0o600 — env vars may hold MCP-server API tokens (daemon OQ-3).
    await fs.writeFile(tempPath, JSON.stringify(records, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tempPath, this.filePath);
  }

  private async enqueuePersist(): Promise<void> {
    const nextPersist = this.persistQueue.then(() => this.persist());
    this.persistQueue = nextPersist.catch(() => {});
    await nextPersist;
  }
}
