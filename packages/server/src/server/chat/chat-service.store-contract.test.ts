import { describe, expect, test } from "vitest";
import pino from "pino";
import { ChatService } from "./chat-service.js";
import type { ChatStore, ChatStorePayload } from "./chat-store.js";

class InMemoryChatStore implements ChatStore {
  payload: ChatStorePayload = { rooms: [], messages: [] };
  saveCount = 0;

  async loadAll(): Promise<ChatStorePayload> {
    return {
      rooms: this.payload.rooms.map((room) => ({ ...room })),
      messages: this.payload.messages.map((message) => ({ ...message })),
    };
  }

  async save(payload: ChatStorePayload): Promise<void> {
    this.saveCount += 1;
    this.payload = {
      rooms: payload.rooms.map((room) => ({ ...room })),
      messages: payload.messages.map((message) => ({ ...message })),
    };
  }
}

describe("ChatService store-contract", () => {
  test("delegates persistence to the injected ChatStore", async () => {
    const store = new InMemoryChatStore();
    const logger = pino({ level: "silent" });
    const service = new ChatService({ store, logger });
    await service.initialize();

    const room = await service.createRoom({ name: "design-review", purpose: "weekly" });
    await service.dispatchMessage({
      room: room.id,
      authorAgentId: "agent-a",
      body: "looks good",
    });

    expect(store.saveCount).toBeGreaterThanOrEqual(2);
    expect(store.payload.rooms).toHaveLength(1);
    expect(store.payload.rooms[0]?.name).toBe("design-review");
    expect(store.payload.messages).toHaveLength(1);
    expect(store.payload.messages[0]?.body).toBe("looks good");

    // A fresh service re-reading from the same store sees the same state.
    const replay = new ChatService({ store, logger });
    await replay.initialize();
    const rooms = await replay.listRooms();
    expect(rooms).toHaveLength(1);
    expect(rooms[0]?.id).toBe(room.id);
    const messages = await replay.readMessages({ room: room.id });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toBe("looks good");
  });

  test("surfaces store errors to the caller (fail-loud)", async () => {
    class FailingStore implements ChatStore {
      async loadAll(): Promise<ChatStorePayload> {
        return { rooms: [], messages: [] };
      }
      async save(): Promise<void> {
        throw new Error("backend unavailable");
      }
    }
    const service = new ChatService({
      store: new FailingStore(),
      logger: pino({ level: "silent" }),
    });
    await service.initialize();
    await expect(service.createRoom({ name: "fail-room" })).rejects.toThrow("backend unavailable");
  });
});
