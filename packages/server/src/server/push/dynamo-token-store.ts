import type { Logger } from "pino";

import { resolveDaemonDataTableName, type DynamoLike } from "../cloud-dynamo-client.js";
import { createCloudSharedKeys, type CloudSharedKeys } from "../cloud-shared-mirror.js";
import type { PushTokenStore } from "./token-store.js";

// Cloud-mode DynamoDB-backed PushTokenStore. Replaces
// `FileBackedPushTokenStore` (a JSON file at `$PASEO_HOME/push-tokens.json`)
// which is wiped on every ECS task replacement — so after a daemon recycle
// the file-backed store held zero tokens and every turn-complete push was
// silently dropped until the app reconnected and re-registered.
//
// Row layout (cloud-shared keys.ts:workspacePushToken, mirrored in
// `cloud-shared-mirror.ts:CloudSharedKeys.workspacePushToken`):
//   pk = "<ws>#push-token"
//   sk = "<expo push token>"
// One row per registered device token. The sort key IS the token, so
// re-registering the same token is an idempotent upsert (natural dedupe),
// matching the file store's `Set` semantics. Cloud is single-workspace-
// per-daemon (the ambient `PASEO_WORKSPACE_ID`), so every row is under the
// per-workspace partition and tenant isolation is by construction.
//
// IAM (workspace-role-template.ts WorkspaceDynamoDb LeadingKeys): the
// per-workspace daemon role must allow `<ws>#push-token` +
// `<ws>#push-token#*` in its inline policy (add both together with the
// `"push-token"` entry in bootstrap.ts DAEMON_OWNED_PARTITION_PREFIXES).

export interface DynamoPushTokenStoreOptions {
  client: DynamoLike;
  // The ambient container workspace id (`PASEO_WORKSPACE_ID`) — the DDB
  // partition-key prefix.
  workspaceId: string;
  logger: Logger;
  tableName?: string;
  keys?: CloudSharedKeys;
}

export class DynamoPushTokenStore implements PushTokenStore {
  private readonly client: DynamoLike;
  private readonly workspaceId: string;
  private readonly tableName: string;
  private readonly keys: CloudSharedKeys;
  private readonly logger: Logger;

  constructor(options: DynamoPushTokenStoreOptions) {
    this.client = options.client;
    this.workspaceId = options.workspaceId;
    this.tableName = options.tableName ?? resolveDaemonDataTableName();
    this.keys = options.keys ?? createCloudSharedKeys();
    this.logger = options.logger.child({
      component: "dynamo-push-token-store",
    });
  }

  async addToken(token: string): Promise<void> {
    const normalized = token.trim();
    if (!normalized) return;
    const key = this.keys.workspacePushToken(this.workspaceId, normalized);
    const now = new Date().toISOString();
    try {
      await this.client.put({
        TableName: this.tableName,
        Item: { ...key, token: normalized, createdAt: now, updatedAt: now },
      });
    } catch (err) {
      this.logger.warn(
        { err, workspaceId: this.workspaceId },
        "DynamoPushTokenStore: addToken failed",
      );
      throw err;
    }
  }

  async removeToken(token: string): Promise<void> {
    const normalized = token.trim();
    if (!normalized) return;
    const key = this.keys.workspacePushToken(this.workspaceId, normalized);
    try {
      await this.client.delete(this.tableName, key);
    } catch (err) {
      this.logger.warn(
        { err, workspaceId: this.workspaceId },
        "DynamoPushTokenStore: removeToken failed",
      );
      throw err;
    }
  }

  async getAllTokens(): Promise<string[]> {
    // Partition-only query — the pk comes from the shared key builder
    // (F12: no inline key strings in store impls).
    const { pk } = this.keys.workspacePushToken(this.workspaceId, "");
    const result = await this.client.query({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
    });
    const tokens: string[] = [];
    for (const item of result.Items ?? []) {
      const token = typeof item.token === "string" ? item.token.trim() : "";
      if (token) tokens.push(token);
    }
    return tokens;
  }
}
