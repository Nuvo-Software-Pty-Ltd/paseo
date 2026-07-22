import { describe, expect, it, vi } from "vitest";
import type { WebSocketLike } from "@getpaseo/client/internal/daemon-client-transport-types";
import {
  createSeededWorkspaceTokenTransportFactory,
  createWorkspaceTokenRefreshingTransportFactory,
} from "./orchestra-cloud-transport";

class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  protocols?: string[];
  constructor(
    public url: string,
    options?: { protocols?: string[] },
  ) {
    this.protocols = options?.protocols;
  }
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  send = vi.fn();
  close = vi.fn();
  on(event: string, handler: (...args: unknown[]) => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(handler);
    this.listeners.set(event, set);
  }
  off(event: string, handler: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(handler);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.listeners.get(event) ?? new Set()) {
      handler(...args);
    }
  }
}

describe("createWorkspaceTokenRefreshingTransportFactory", () => {
  it("mints a fresh token before constructing the WebSocket and uses it as the subprotocol", async () => {
    const tokenProvider = vi.fn().mockResolvedValueOnce("token-A").mockResolvedValueOnce("token-B");
    const constructed: FakeWebSocket[] = [];
    const webSocketFactory = (url: string, opts?: { protocols?: string[] }) => {
      const ws = new FakeWebSocket(url, opts);
      constructed.push(ws);
      return ws;
    };

    const factory = createWorkspaceTokenRefreshingTransportFactory({
      tokenProvider,
      webSocketFactory,
    });

    const transport1 = factory({ url: "wss://example.test/ws" });
    const openHandler1 = vi.fn();
    transport1.onOpen(openHandler1);

    await vi.waitFor(() => {
      expect(constructed.length).toBe(1);
    });

    expect(tokenProvider).toHaveBeenCalledTimes(1);
    expect(constructed[0]?.protocols).toEqual(["paseo.workspace.token-A"]);
    expect(constructed[0]?.url).toBe("wss://example.test/ws");

    constructed[0]?.emit("open");
    expect(openHandler1).toHaveBeenCalledTimes(1);

    // A second connect attempt mints a fresh token.
    const transport2 = factory({ url: "wss://example.test/ws" });
    transport2.onOpen(() => {});
    await vi.waitFor(() => {
      expect(constructed.length).toBe(2);
    });
    expect(tokenProvider).toHaveBeenCalledTimes(2);
    expect(constructed[1]?.protocols).toEqual(["paseo.workspace.token-B"]);
  });

  it("does not construct a WebSocket if close() is called before the token arrives", async () => {
    let releaseToken: (token: string) => void = () => {};
    const tokenProvider = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseToken = resolve;
        }),
    );
    const constructed: FakeWebSocket[] = [];
    const webSocketFactory = (url: string, opts?: { protocols?: string[] }) => {
      const ws = new FakeWebSocket(url, opts);
      constructed.push(ws);
      return ws;
    };

    const factory = createWorkspaceTokenRefreshingTransportFactory({
      tokenProvider,
      webSocketFactory,
    });

    const transport = factory({ url: "wss://example.test/ws" });
    transport.close(1000, "bye");
    releaseToken("late-token");

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(constructed.length).toBe(0);
  });

  it("invokes error and close handlers if the token fetch fails", async () => {
    const tokenProvider = vi.fn().mockRejectedValueOnce(new Error("mint failed"));
    const factory = createWorkspaceTokenRefreshingTransportFactory({
      tokenProvider,
      webSocketFactory: () => {
        throw new Error("should not be called");
      },
    });

    const transport = factory({ url: "wss://example.test/ws" });
    const errorHandler = vi.fn();
    const closeHandler = vi.fn();
    transport.onError(errorHandler);
    transport.onClose(closeHandler);

    await vi.waitFor(() => {
      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(closeHandler).toHaveBeenCalledTimes(1);
    });
  });
});

describe("createSeededWorkspaceTokenTransportFactory", () => {
  it("uses the pre-minted token on the first connect without minting, then mints on reconnect", async () => {
    // The seeded token was minted OUTSIDE the connect timeout (fix A), so the
    // first connect must not incur a network mint. Reconnects re-mint because
    // the workspace token is short-lived and must not be reused (transport
    // invariant).
    const tokenProvider = vi.fn().mockResolvedValueOnce("reconnect-token");
    const constructed: FakeWebSocket[] = [];
    const webSocketFactory = (url: string, opts?: { protocols?: string[] }) => {
      const ws = new FakeWebSocket(url, opts);
      constructed.push(ws);
      return ws;
    };

    const factory = createSeededWorkspaceTokenTransportFactory({
      initialToken: "seed-token",
      tokenProvider,
      webSocketFactory,
    });

    // First connect: uses the seeded token, no mint.
    const transport1 = factory({ url: "wss://example.test/ws" });
    transport1.onOpen(() => {});
    await vi.waitFor(() => {
      expect(constructed.length).toBe(1);
    });
    expect(tokenProvider).not.toHaveBeenCalled();
    expect(constructed[0]?.protocols).toEqual(["paseo.workspace.seed-token"]);

    // Second connect (reconnect): mints a fresh token.
    const transport2 = factory({ url: "wss://example.test/ws" });
    transport2.onOpen(() => {});
    await vi.waitFor(() => {
      expect(constructed.length).toBe(2);
    });
    expect(tokenProvider).toHaveBeenCalledTimes(1);
    expect(constructed[1]?.protocols).toEqual(["paseo.workspace.reconnect-token"]);
  });
});
