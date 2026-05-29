// Minimal DDB DocumentClient surface the daemon's cloud-mode stores use.
// Mirrors the `SecretsManagerLike` seam in `cloud-credentials.ts` —
// tests inject a Map-backed fake; production wires in
// `@aws-sdk/lib-dynamodb`'s `DynamoDBDocumentClient` via a thin adapter.
//
// Why a wrapper instead of importing the SDK directly: the daemon's
// `package.json` does not yet include the DynamoDB SDK. Adding it is
// a separate deploy concern (operator-driven dep bump alongside the
// CDK IAM-grant deploy). Until that lands, the cloud-mode stores still
// type-check and unit-test against this interface.
//
// F12 design-out: every DDB key concat goes through
// `cloud-shared-mirror.createCloudSharedKeys()` — never inline strings
// in store implementations.

import type { DdbKey } from "./cloud-shared-mirror.js";

/** Result of a GetItem call. `Item` is undefined when the row is absent. */
export interface DynamoGetResult {
  Item?: Record<string, unknown>;
}

export interface DynamoQueryResult {
  Items?: Record<string, unknown>[];
  LastEvaluatedKey?: Record<string, unknown>;
}

export interface DynamoQueryParams {
  TableName: string;
  KeyConditionExpression: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
  Limit?: number;
  ExclusiveStartKey?: Record<string, unknown>;
  ScanIndexForward?: boolean;
}

export interface DynamoUpdateParams {
  TableName: string;
  Key: DdbKey;
  UpdateExpression: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
  ConditionExpression?: string;
}

export interface DynamoPutParams {
  TableName: string;
  Item: Record<string, unknown>;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
}

export interface DynamoLike {
  get(table: string, key: DdbKey): Promise<DynamoGetResult>;
  put(params: DynamoPutParams): Promise<void>;
  delete(table: string, key: DdbKey): Promise<void>;
  query(params: DynamoQueryParams): Promise<DynamoQueryResult>;
  update(params: DynamoUpdateParams): Promise<void>;
}

/**
 * In-memory test seam — keys are `${pk}${sk}` so the
 * `KeyConditionExpression` `pk = :pk AND begins_with(sk, :prefix)` shape
 * we use in stores can be exercised in tests without spinning up
 * DynamoDB Local.
 */
export class InMemoryDynamoClient implements DynamoLike {
  private readonly rows = new Map<string, Record<string, unknown>>();

  private composeKey(pk: string, sk: string): string {
    return `${pk}${sk}`;
  }

  async get(_table: string, key: DdbKey): Promise<DynamoGetResult> {
    const item = this.rows.get(this.composeKey(key.pk, key.sk));
    return item ? { Item: { ...item } } : {};
  }

  async put(params: DynamoPutParams): Promise<void> {
    const pk = String(params.Item.pk);
    const sk = String(params.Item.sk);
    const k = this.composeKey(pk, sk);
    // Honor a simple `attribute_not_exists(pk)` condition so idempotency
    // checks behave correctly in unit tests.
    if (params.ConditionExpression?.includes("attribute_not_exists(pk)") && this.rows.has(k)) {
      const err = new Error("Conditional check failed (InMemoryDynamoClient)");
      err.name = "ConditionalCheckFailedException";
      throw err;
    }
    this.rows.set(k, { ...params.Item });
  }

  async delete(_table: string, key: DdbKey): Promise<void> {
    this.rows.delete(this.composeKey(key.pk, key.sk));
  }

  async query(params: DynamoQueryParams): Promise<DynamoQueryResult> {
    // Minimal support: KeyConditionExpression of shape
    //   "pk = :pk" or "pk = :pk AND begins_with(sk, :prefix)"
    const values = params.ExpressionAttributeValues ?? {};
    const targetPk = values[":pk"] as string | undefined;
    const skPrefix = values[":prefix"] as string | undefined;
    if (!targetPk) return { Items: [] };
    const items: Record<string, unknown>[] = [];
    for (const row of this.rows.values()) {
      if (row.pk !== targetPk) continue;
      const sk = String(row.sk);
      if (skPrefix !== undefined && !sk.startsWith(skPrefix)) continue;
      items.push({ ...row });
    }
    // Sort by sk ascending (DDB default). ScanIndexForward:false reverses.
    items.sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
    if (params.ScanIndexForward === false) items.reverse();
    if (typeof params.Limit === "number") items.splice(params.Limit);
    return { Items: items };
  }

  async update(params: DynamoUpdateParams): Promise<void> {
    // Minimal support for "ADD" expressions used by the spend writer
    // (T-18) shape. The expression is parsed token-by-token; only
    // the ADD path is implemented because that's the only path the
    // daemon uses today.
    const k = this.composeKey(params.Key.pk, params.Key.sk);
    const existing = this.rows.get(k) ?? { pk: params.Key.pk, sk: params.Key.sk };
    const values = params.ExpressionAttributeValues ?? {};
    const names = params.ExpressionAttributeNames ?? {};
    const trimmed = params.UpdateExpression.trim();
    if (!trimmed.toUpperCase().startsWith("ADD ")) {
      // Tests may use SET; honor it as a record merge.
      if (trimmed.toUpperCase().startsWith("SET ")) {
        // Very narrow SET-impl: "SET #a = :a, #b = :b, ..."
        const body = trimmed.slice(4);
        for (const clause of body.split(",")) {
          const [lhs, rhs] = clause.split("=").map((s) => s.trim());
          const field = lhs.startsWith("#") ? names[lhs] : lhs;
          const value = values[rhs];
          if (field !== undefined) (existing as Record<string, unknown>)[field] = value;
        }
        this.rows.set(k, existing);
        return;
      }
      throw new Error(`InMemoryDynamoClient: unsupported UpdateExpression: ${trimmed}`);
    }
    const body = trimmed.slice(4);
    for (const clause of body.split(",")) {
      const [lhs, rhs] = clause.split(/\s+/).filter(Boolean);
      const field = lhs.startsWith("#") ? names[lhs] : lhs;
      const delta = Number(values[rhs]);
      if (field === undefined || !Number.isFinite(delta)) continue;
      const prev = Number(existing[field] ?? 0);
      existing[field] = prev + delta;
    }
    this.rows.set(k, existing);
  }

  // Test helper: read every row keyed by a partition.
  _snapshot(): Map<string, Record<string, unknown>> {
    return new Map(this.rows);
  }
}

/**
 * Resolve the DDB table name for **control-plane** rows (workspace
 * metadata, account index, keypair, spend, webhook-event). Sourced
 * from `ORCHESTRA_DDB_TABLE` with `orchestra-dev-state` as the dev
 * fallback.
 *
 * D-3.10 follow-up split: daemon-data stores (chat / permission /
 * loop / schedule) route through `resolveDaemonDataTableName()`
 * instead, so a future CDK split (separate
 * `orchestra-prod-daemon-data` table) is a deploy-config flip rather
 * than a code change. See 30-state/dynamo-store-schema.md §
 * "Env-var table split".
 */
export function resolveCloudStateTableName(): string {
  return process.env.ORCHESTRA_DDB_TABLE ?? "orchestra-dev-state";
}

/**
 * Resolve the DDB table name for **daemon-data** rows (chat,
 * permission, loop, schedule — the four surfaces wired in D-3.10).
 *
 * Resolution order:
 *   1. `ORCHESTRA_DDB_DAEMON_TABLE` if set (production split path)
 *   2. fall back to `ORCHESTRA_DDB_TABLE` (single-table dev default)
 *   3. `orchestra-dev-state` as the ultimate fallback (matches the
 *      control-plane default so the two tables collapse to one when
 *      neither override is set)
 *
 * Why the split: in production we want daemon-data on its own DDB
 * table so per-tenant chat write rate (the dominant write driver)
 * doesn't share throughput / cost-attribution / hot-partition risk
 * with control-plane reads. D-3.10 ships the env-var seam so a
 * future CDK change deploys the second table by flipping
 * `ORCHESTRA_DDB_DAEMON_TABLE` on the per-workspace task def —
 * no daemon code change required.
 */
export function resolveDaemonDataTableName(): string {
  return (
    process.env.ORCHESTRA_DDB_DAEMON_TABLE ??
    process.env.ORCHESTRA_DDB_TABLE ??
    "orchestra-dev-state"
  );
}
