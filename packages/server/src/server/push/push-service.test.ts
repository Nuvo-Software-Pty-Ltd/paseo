import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { PushService } from "./push-service.js";
import type { PushTokenStore } from "./token-store.js";

const logger = pino({ level: "silent" });

function makeTokenStore(): { store: PushTokenStore; removed: string[] } {
  const removed: string[] = [];
  const store: PushTokenStore = {
    addToken: async () => {},
    removeToken: async (token: string) => {
      removed.push(token);
    },
    getAllTokens: async () => [],
  };
  return { store, removed };
}

function mockExpoResponse(data: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ data }),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PushService invalid-token pruning", () => {
  test("removes a token Expo reports as DeviceNotRegistered", async () => {
    const { store, removed } = makeTokenStore();
    mockExpoResponse([
      {
        status: "error",
        message: "not registered",
        details: { error: "DeviceNotRegistered" },
      },
    ]);

    await new PushService(logger, store).sendPush(["ExponentPushToken[dead]"], {
      title: "t",
      body: "b",
    });

    expect(removed).toEqual(["ExponentPushToken[dead]"]);
  });

  test("keeps tokens on a successful send", async () => {
    const { store, removed } = makeTokenStore();
    mockExpoResponse([{ status: "ok", id: "receipt-1" }]);

    await new PushService(logger, store).sendPush(["ExponentPushToken[live]"], {
      title: "t",
      body: "b",
    });

    expect(removed).toEqual([]);
  });

  test("keeps tokens on a non-credential error (e.g. MessageRateExceeded)", async () => {
    const { store, removed } = makeTokenStore();
    mockExpoResponse([
      {
        status: "error",
        message: "slow down",
        details: { error: "MessageRateExceeded" },
      },
    ]);

    await new PushService(logger, store).sendPush(["ExponentPushToken[live]"], {
      title: "t",
      body: "b",
    });

    expect(removed).toEqual([]);
  });
});
