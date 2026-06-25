import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type pino from "pino";
import { z } from "zod";
import { ChatMessageSchema, ChatRoomSchema } from "@getpaseo/protocol/chat/types";

export const ChatStorePayloadSchema = z.object({
  rooms: z.array(ChatRoomSchema),
  messages: z.array(ChatMessageSchema),
});

export type ChatStorePayload = z.infer<typeof ChatStorePayloadSchema>;

export interface ChatStore {
  loadAll(): Promise<ChatStorePayload>;
  save(payload: ChatStorePayload): Promise<void>;
}

export class FileBackedChatStore implements ChatStore {
  private readonly filePath: string;
  private readonly logger: pino.Logger;

  constructor(options: { paseoHome: string; logger: pino.Logger }) {
    this.filePath = path.join(options.paseoHome, "chat", "rooms.json");
    this.logger = options.logger.child({ component: "chat-store" });
  }

  async loadAll(): Promise<ChatStorePayload> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return ChatStorePayloadSchema.parse(JSON.parse(raw));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.error({ err: error, filePath: this.filePath }, "Failed to load chat store");
      }
      return { rooms: [], messages: [] };
    }
  }

  async save(payload: ChatStorePayload): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
    await fs.rename(tempPath, this.filePath);
  }
}
