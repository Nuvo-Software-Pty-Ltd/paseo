import type { Logger } from "pino";
import { createCloudSharedKeys, type CloudSharedKeys } from "../cloud-shared-mirror.js";
import { resolveDaemonDataTableName, type DynamoLike } from "../cloud-dynamo-client.js";
import type { ChatMessage, ChatRoom } from "./chat-types.js";
import type { ChatStore, ChatStorePayload } from "./chat-store.js";

// T-1 (D-3) — DynamoDB-backed ChatStore for cloud mode.
//
// COMPAT(chat-dynamostore): DDB row shapes pinned by
// `@orchestra/cloud-shared/keys.ts` HEAD `c9f804c`. On-disk JSON shape
// (FileBackedChatStore) remains binding for on-host; this implementation
// is cloud-only.
//
// Row layout (from cloud-shared keys.ts:169-177):
//   - Room:    pk = "<ws>#chat", sk = "<roomId>#meta"
//   - Message: pk = "<ws>#chat", sk = "<roomId>#msg#<messageId>"
//
// `loadAll` queries the `<ws>#chat` partition once and sorts client-side
// (DDB returns rows in sk lexical order; the room+messages share a
// partition so a single Query returns everything). `save` is per-row
// idempotent PutItem.
//
// F3 design-out: the workspaceId is sourced from PASEO_WORKSPACE_ID at
// construction (validated against the JWT binding at boot per
// cloud-auth.ts). Callers never pass a workspaceId; cross-tenant
// writes are impossible by construction.

export interface DynamoChatStoreOptions {
  client: DynamoLike;
  workspaceId: string;
  logger: Logger;
  tableName?: string;
  keys?: CloudSharedKeys;
}

export class DynamoChatStore implements ChatStore {
  private readonly client: DynamoLike;
  private readonly workspaceId: string;
  private readonly tableName: string;
  private readonly keys: CloudSharedKeys;
  private readonly logger: Logger;

  constructor(options: DynamoChatStoreOptions) {
    this.client = options.client;
    this.workspaceId = options.workspaceId;
    this.tableName = options.tableName ?? resolveDaemonDataTableName();
    this.keys = options.keys ?? createCloudSharedKeys();
    this.logger = options.logger.child({ component: "dynamo-chat-store" });
  }

  async loadAll(): Promise<ChatStorePayload> {
    const result = await this.client.query({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": `${this.workspaceId}#chat` },
    });
    const rooms: ChatRoom[] = [];
    const messages: ChatMessage[] = [];
    for (const item of result.Items ?? []) {
      const sk = String(item.sk);
      if (sk.endsWith("#meta")) {
        rooms.push({
          id: String(item.id ?? item.roomId),
          name: String(item.name ?? ""),
          purpose: item.purpose === null ? null : String(item.purpose ?? ""),
          createdAt: String(item.createdAt),
          updatedAt: String(item.updatedAt),
        });
      } else if (sk.includes("#msg#")) {
        const rawReply = item.replyToMessageId;
        const replyToMessageId =
          rawReply === null || rawReply === undefined ? null : String(rawReply);
        messages.push({
          id: String(item.id ?? item.messageId),
          roomId: String(item.roomId),
          authorAgentId: String(item.authorAgentId ?? ""),
          body: String(item.body ?? item.content ?? ""),
          replyToMessageId,
          mentionAgentIds: Array.isArray(item.mentionAgentIds)
            ? item.mentionAgentIds.map(String)
            : [],
          createdAt: String(item.createdAt),
        });
      }
    }
    return { rooms, messages };
  }

  async save(payload: ChatStorePayload): Promise<void> {
    // Per-row PutItem. Tests use the in-memory adapter; production
    // uses the real DynamoDBDocumentClient (operator adds the
    // package.json dep + adapter when deploying).
    // F12: every key goes through this.keys.* — no inline strings.
    for (const room of payload.rooms) {
      const key = this.keys.workspaceChatRoom(this.workspaceId, room.id);
      try {
        await this.client.put({
          TableName: this.tableName,
          Item: {
            ...key,
            id: room.id,
            name: room.name,
            purpose: room.purpose,
            createdAt: room.createdAt,
            updatedAt: room.updatedAt,
          },
        });
      } catch (err) {
        this.logger.warn(
          { err, workspaceId: this.workspaceId, roomId: room.id },
          "DynamoChatStore: put room failed",
        );
        throw err;
      }
    }
    for (const message of payload.messages) {
      const key = this.keys.workspaceChatMessage(this.workspaceId, message.roomId, message.id);
      try {
        await this.client.put({
          TableName: this.tableName,
          Item: {
            ...key,
            id: message.id,
            roomId: message.roomId,
            authorAgentId: message.authorAgentId,
            body: message.body,
            replyToMessageId: message.replyToMessageId,
            mentionAgentIds: message.mentionAgentIds,
            createdAt: message.createdAt,
          },
        });
      } catch (err) {
        this.logger.warn(
          { err, workspaceId: this.workspaceId, messageId: message.id },
          "DynamoChatStore: put message failed",
        );
        throw err;
      }
    }
  }
}
