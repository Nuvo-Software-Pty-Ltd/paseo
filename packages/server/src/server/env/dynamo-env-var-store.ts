import type { Logger } from "pino";

import { resolveDaemonDataTableName, type DynamoLike } from "../cloud-dynamo-client.js";
import { createCloudSharedKeys, type CloudSharedKeys } from "../cloud-shared-mirror.js";
import {
  ScopedEnvVarRecordSchema,
  type EnvVarStore,
  type ScopedEnvVarRecord,
  type ScopedEnvVarScope,
} from "./env-var-store.js";

// D-3.5c — DynamoDB-backed EnvVarStore for cloud mode. Replaces
// `FileBackedEnvVarStore` (single JSON file at
// `$PASEO_HOME/projects/env-vars.json`) which is wiped on every ECS task
// replacement.
//
// Row layout (cloud-shared keys.ts:workspaceEnvVar, mirrored in
// `cloud-shared-mirror.ts:CloudSharedKeys.workspaceEnvVar`):
//   pk = "<ws>#envvar"
//   sk = "<scope>#<scopeId>#<key>"
// One row per (scope, scopeId, key). The full `ScopedEnvVarRecord` body
// lives in the row's `record` attribute. Both workspace-scoped and
// project-scoped vars live in the one `<ws>#envvar` partition — cloud is
// single-workspace-per-daemon (the ambient `PASEO_WORKSPACE_ID`), so every
// row is already under the per-workspace partition and tenant isolation is
// by construction (same as `<ws>#project`).
//
// IAM (D-3.11 / D-3.5c — workspace-role-template.ts WorkspaceDynamoDb
// LeadingKeys): the per-workspace daemon role must allow
//   `<workspaceId>#envvar` + `<workspaceId>#envvar#*`
// in its inline policy. The cloud stream appends this (exact, wildcard)
// pair to the `dynamodb:LeadingKeys` list.

export interface DynamoEnvVarStoreOptions {
  client: DynamoLike;
  // The ambient container workspace id (`PASEO_WORKSPACE_ID`). This is the
  // DDB partition key prefix — NOT the var's `scopeId` (which lives in the
  // sort key alongside the scope and the key name).
  workspaceId: string;
  logger: Logger;
  tableName?: string;
  keys?: CloudSharedKeys;
}

export class DynamoEnvVarStore implements EnvVarStore {
  private readonly client: DynamoLike;
  private readonly workspaceId: string;
  private readonly tableName: string;
  private readonly keys: CloudSharedKeys;
  private readonly logger: Logger;

  constructor(options: DynamoEnvVarStoreOptions) {
    this.client = options.client;
    this.workspaceId = options.workspaceId;
    this.tableName = options.tableName ?? resolveDaemonDataTableName();
    this.keys = options.keys ?? createCloudSharedKeys();
    this.logger = options.logger.child({ component: "dynamo-env-var-store" });
  }

  async listForScope(scope: ScopedEnvVarScope, scopeId: string): Promise<ScopedEnvVarRecord[]> {
    const result = await this.client.query({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `${this.workspaceId}#envvar`,
        ":prefix": `${scope}#${scopeId}#`,
      },
    });
    const records: ScopedEnvVarRecord[] = [];
    for (const item of result.Items ?? []) {
      const parsed = this.tryParseRow(item);
      if (parsed) records.push(parsed);
    }
    return records;
  }

  async upsert(record: ScopedEnvVarRecord): Promise<void> {
    const parsed = ScopedEnvVarRecordSchema.parse(record);
    const key = this.keys.workspaceEnvVar(
      this.workspaceId,
      parsed.scope,
      parsed.scopeId,
      parsed.key,
    );
    try {
      await this.client.put({
        TableName: this.tableName,
        Item: {
          ...key,
          record: parsed,
          createdAt: parsed.createdAt,
          updatedAt: parsed.updatedAt,
        },
      });
    } catch (err) {
      this.logger.warn(
        { err, scope: parsed.scope, scopeId: parsed.scopeId, workspaceId: this.workspaceId },
        "DynamoEnvVarStore: upsert failed",
      );
      throw err;
    }
  }

  async remove(scope: ScopedEnvVarScope, scopeId: string, key: string): Promise<void> {
    const ddbKey = this.keys.workspaceEnvVar(this.workspaceId, scope, scopeId, key);
    try {
      await this.client.delete(this.tableName, ddbKey);
    } catch (err) {
      this.logger.warn(
        { err, scope, scopeId, workspaceId: this.workspaceId },
        "DynamoEnvVarStore: remove failed",
      );
      throw err;
    }
  }

  private tryParseRow(item: Record<string, unknown>): ScopedEnvVarRecord | null {
    try {
      return ScopedEnvVarRecordSchema.parse(item.record);
    } catch (err) {
      this.logger.warn(
        { err, workspaceId: this.workspaceId, sk: item.sk },
        "DynamoEnvVarStore: row failed schema parse — skipping",
      );
      return null;
    }
  }
}
