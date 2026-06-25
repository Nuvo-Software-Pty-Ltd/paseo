import type { Logger } from "pino";
import { z } from "zod";

import { resolveDaemonDataTableName, type DynamoLike } from "../cloud-dynamo-client.js";
import { createCloudSharedKeys, type CloudSharedKeys } from "../cloud-shared-mirror.js";
import type { PersistedProjectRecord, ProjectRegistry } from "../workspace-registry.js";

// D-3.12 (UAT follow-ups #3 + #4) — DynamoDB-backed ProjectRegistry for
// cloud mode. Replaces `FileBackedProjectRegistry` (single JSON file at
// `$PASEO_HOME/projects/projects.json`) which is wiped on every ECS task
// replacement.
//
// Row layout (cloud-shared keys.ts:workspaceProject, mirrored in
// `cloud-shared-mirror.ts:CloudSharedKeys.workspaceProject`):
//   pk = "<ws>#project"
//   sk = "<projectId>"
// One row per project. The full `PersistedProjectRecord` body lives in
// the row's `record` attribute. Reads/writes go through
// `keys.workspaceProject` (F12 — no inline pk/sk strings).
//
// IAM (D-3.11 / D-3.12 — workspace-role-template.ts WorkspaceDynamoDb
// LeadingKeys): the per-workspace daemon role has
//   `<workspaceId>#project` + `<workspaceId>#project#*`
// allowed in its inline policy. Existing workspaces pick up the new
// grant via the D-3.11 backfill script.
//
// Implementation notes:
//   - `existsOnDisk()` returns `true` once any project row has been
//     written to the partition. The on-host `FileBackedProjectRegistry`
//     uses this hook to distinguish "fresh install, no file yet" from
//     "file exists but empty". In cloud mode the analog is "has any
//     row been written" — a fresh workspace returns `false`, a
//     populated one returns `true`. The workspace-bootstrap migration
//     paths in `workspace-registry-bootstrap.ts` use this to decide
//     whether to seed initial projects from disk discovery.
//   - `list()` runs a single Query on the workspace partition. The
//     result set is bounded by the workspace's project count (typically
//     a handful) so no pagination is needed at Day-1.
//   - `archive()` reads + writes (PutItem of a record with archivedAt
//     stamped). Matches the on-disk impl's atomicity: a concurrent
//     reader either sees the pre-archive row or the post-archive row,
//     never a torn write.

// Deliberately duplicated from `workspace-registry.ts` (cloud store keeps
// its own copy). MUST stay field-aligned with that schema.
const PersistedProjectRecordSchema = z.object({
  projectId: z.string(),
  rootPath: z.string(),
  kind: z.enum(["git", "non_git"]),
  displayName: z.string(),
  // User-set override layered over the derived displayName. Mirrors the
  // file-backed PersistedProjectRecordSchema (workspace-registry.ts). Null
  // means "use the derived name". Old rows without the field still parse.
  customName: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  // COMPAT(workspace-project-1n): added in v0.1.73, drop optionality when
  // floor >= v0.1.73 (target 2026-12). `workspaceId` echoes the
  // `<ws>#project` partition for cross-mode uniformity; `repoUrl` is the
  // credential-free canonical repo URL persisted in the row body.
  workspaceId: z.string().optional(),
  repoUrl: z.string().nullable().optional(),
});

export interface DynamoProjectStoreOptions {
  client: DynamoLike;
  workspaceId: string;
  logger: Logger;
  tableName?: string;
  keys?: CloudSharedKeys;
}

export class DynamoProjectStore implements ProjectRegistry {
  private readonly client: DynamoLike;
  private readonly workspaceId: string;
  private readonly tableName: string;
  private readonly keys: CloudSharedKeys;
  private readonly logger: Logger;

  constructor(options: DynamoProjectStoreOptions) {
    this.client = options.client;
    this.workspaceId = options.workspaceId;
    this.tableName = options.tableName ?? resolveDaemonDataTableName();
    this.keys = options.keys ?? createCloudSharedKeys();
    this.logger = options.logger.child({ component: "dynamo-project-store" });
  }

  async initialize(): Promise<void> {
    // No-op. The store is lazy; `list()` runs a Query on demand.
  }

  async existsOnDisk(): Promise<boolean> {
    // "Has any project row been written to this workspace's partition?"
    // — the cloud analog of the file-backed registry's
    // `fs.access(filePath)`. A bounded Query (Limit: 1) is the minimal
    // probe.
    const result = await this.client.query({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": `${this.workspaceId}#project` },
      Limit: 1,
    });
    return (result.Items?.length ?? 0) > 0;
  }

  async list(): Promise<PersistedProjectRecord[]> {
    const result = await this.client.query({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": `${this.workspaceId}#project` },
    });
    const records: PersistedProjectRecord[] = [];
    for (const item of result.Items ?? []) {
      const parsed = this.tryParseRow(item);
      if (parsed) records.push(parsed);
    }
    return records;
  }

  async get(projectId: string): Promise<PersistedProjectRecord | null> {
    const key = this.keys.workspaceProject(this.workspaceId, projectId);
    const result = await this.client.get(this.tableName, key);
    if (!result.Item) return null;
    return this.tryParseRow(result.Item);
  }

  async upsert(record: PersistedProjectRecord): Promise<void> {
    const parsed = PersistedProjectRecordSchema.parse(record);
    const key = this.keys.workspaceProject(this.workspaceId, parsed.projectId);
    try {
      await this.client.put({
        TableName: this.tableName,
        Item: {
          ...key,
          projectId: parsed.projectId,
          record: parsed,
          createdAt: parsed.createdAt,
          updatedAt: parsed.updatedAt,
        },
      });
    } catch (err) {
      this.logger.warn(
        { err, projectId: parsed.projectId, workspaceId: this.workspaceId },
        "DynamoProjectStore: upsert failed",
      );
      throw err;
    }
  }

  async archive(projectId: string, archivedAt: string): Promise<void> {
    const existing = await this.get(projectId);
    if (!existing) {
      return;
    }
    await this.upsert({
      ...existing,
      updatedAt: archivedAt,
      archivedAt,
    });
  }

  async remove(projectId: string): Promise<void> {
    const key = this.keys.workspaceProject(this.workspaceId, projectId);
    try {
      await this.client.delete(this.tableName, key);
    } catch (err) {
      this.logger.warn(
        { err, projectId, workspaceId: this.workspaceId },
        "DynamoProjectStore: remove failed",
      );
      throw err;
    }
  }

  private tryParseRow(item: Record<string, unknown>): PersistedProjectRecord | null {
    try {
      return PersistedProjectRecordSchema.parse(item.record);
    } catch (err) {
      this.logger.warn(
        { err, workspaceId: this.workspaceId, sk: item.sk },
        "DynamoProjectStore: row failed schema parse — skipping",
      );
      return null;
    }
  }
}
