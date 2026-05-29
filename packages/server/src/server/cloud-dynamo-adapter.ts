import type {
  DynamoDBDocumentClient,
  GetCommandInput,
  PutCommandInput,
  DeleteCommandInput,
  QueryCommandInput,
  UpdateCommandInput,
} from "@aws-sdk/lib-dynamodb";

import type {
  DynamoGetResult,
  DynamoLike,
  DynamoPutParams,
  DynamoQueryParams,
  DynamoQueryResult,
  DynamoUpdateParams,
} from "./cloud-dynamo-client.js";
import type { DdbKey } from "./cloud-shared-mirror.js";

// Adapter from the daemon's `DynamoLike` seam onto a real
// `@aws-sdk/lib-dynamodb` `DynamoDBDocumentClient`. Mirrors the
// `SecretsManagerLike` -> `SecretsManagerClient` adapter in
// `cloud-credentials.ts`.
//
// Construction is deferred to the caller — the production daemon
// bootstrap builds the client once per process and hands the adapter
// to every cloud-mode store. The wrapper is "thin" by design: just
// command-name translation. Retry / backoff / auth-refresh is left to
// the SDK's built-in client config (the AWS SDK v3 default is sane).
//
// IAM scope (see 30-state/dynamo-store-schema.md): the daemon's
// per-workspace task role must be able to PutItem / GetItem /
// UpdateItem / DeleteItem / Query on the configured table, scoped to
// its workspace's `pk` prefix. CDK follow-up filed in D-3.10.

export function createDynamoLikeFromDocumentClient(client: DynamoDBDocumentClient): DynamoLike {
  return {
    async get(table: string, key: DdbKey): Promise<DynamoGetResult> {
      const input: GetCommandInput = {
        TableName: table,
        Key: key,
      };
      const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
      const result = await client.send(new GetCommand(input));
      return result.Item ? { Item: result.Item } : {};
    },

    async put(params: DynamoPutParams): Promise<void> {
      const input: PutCommandInput = {
        TableName: params.TableName,
        Item: params.Item,
        ...(params.ConditionExpression ? { ConditionExpression: params.ConditionExpression } : {}),
        ...(params.ExpressionAttributeNames
          ? { ExpressionAttributeNames: params.ExpressionAttributeNames }
          : {}),
        ...(params.ExpressionAttributeValues
          ? { ExpressionAttributeValues: params.ExpressionAttributeValues }
          : {}),
      };
      const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
      await client.send(new PutCommand(input));
    },

    async delete(table: string, key: DdbKey): Promise<void> {
      const input: DeleteCommandInput = {
        TableName: table,
        Key: key,
      };
      const { DeleteCommand } = await import("@aws-sdk/lib-dynamodb");
      await client.send(new DeleteCommand(input));
    },

    async query(params: DynamoQueryParams): Promise<DynamoQueryResult> {
      const input: QueryCommandInput = {
        TableName: params.TableName,
        KeyConditionExpression: params.KeyConditionExpression,
        ...(params.ExpressionAttributeNames
          ? { ExpressionAttributeNames: params.ExpressionAttributeNames }
          : {}),
        ...(params.ExpressionAttributeValues
          ? { ExpressionAttributeValues: params.ExpressionAttributeValues }
          : {}),
        ...(params.Limit !== undefined ? { Limit: params.Limit } : {}),
        ...(params.ExclusiveStartKey ? { ExclusiveStartKey: params.ExclusiveStartKey } : {}),
        ...(params.ScanIndexForward !== undefined
          ? { ScanIndexForward: params.ScanIndexForward }
          : {}),
      };
      const { QueryCommand } = await import("@aws-sdk/lib-dynamodb");
      const result = await client.send(new QueryCommand(input));
      return {
        ...(result.Items ? { Items: result.Items } : { Items: [] }),
        ...(result.LastEvaluatedKey ? { LastEvaluatedKey: result.LastEvaluatedKey } : {}),
      };
    },

    async update(params: DynamoUpdateParams): Promise<void> {
      const input: UpdateCommandInput = {
        TableName: params.TableName,
        Key: params.Key,
        UpdateExpression: params.UpdateExpression,
        ...(params.ExpressionAttributeNames
          ? { ExpressionAttributeNames: params.ExpressionAttributeNames }
          : {}),
        ...(params.ExpressionAttributeValues
          ? { ExpressionAttributeValues: params.ExpressionAttributeValues }
          : {}),
        ...(params.ConditionExpression ? { ConditionExpression: params.ConditionExpression } : {}),
      };
      const { UpdateCommand } = await import("@aws-sdk/lib-dynamodb");
      await client.send(new UpdateCommand(input));
    },
  };
}

let cachedDocumentClient: DynamoDBDocumentClient | null = null;

/**
 * Resolve a shared `DynamoDBDocumentClient` for the daemon process.
 * Lazily constructed on first use; the SDK reads AWS credentials from
 * the ECS task role (or env vars in dev) via the default provider chain.
 *
 * Region is sourced from `AWS_REGION` (set by ECS automatically) with
 * an `ap-southeast-2` fallback for parity with the dev stack default.
 */
export async function getSharedDocumentClient(): Promise<DynamoDBDocumentClient> {
  if (cachedDocumentClient) return cachedDocumentClient;
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient: DocClient } = await import("@aws-sdk/lib-dynamodb");
  const region = process.env.AWS_REGION?.trim() || "ap-southeast-2";
  const raw = new DynamoDBClient({ region });
  cachedDocumentClient = DocClient.from(raw);
  return cachedDocumentClient;
}

/**
 * Convenience: build the `DynamoLike` adapter wired to the shared
 * DocumentClient. The cloud-mode bootstrap calls this once and hands
 * the result to every `Dynamo*Store` instance for the workspace.
 */
export async function buildCloudModeDynamoLike(): Promise<DynamoLike> {
  const client = await getSharedDocumentClient();
  return createDynamoLikeFromDocumentClient(client);
}
