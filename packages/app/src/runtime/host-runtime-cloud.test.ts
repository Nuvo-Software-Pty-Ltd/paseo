import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(() => Promise.resolve(null)),
    setItem: vi.fn(() => Promise.resolve()),
    removeItem: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock("@/constants/platform", () => ({ isWeb: true, isNative: false }));

vi.mock("@/desktop/daemon/desktop-daemon", () => ({
  shouldUseDesktopDaemon: () => false,
}));

vi.mock("@/desktop/daemon/desktop-daemon-transport", () => ({
  buildLocalDaemonTransportUrl: () => "ws://localhost",
  createDesktopLocalDaemonTransportFactory: () => null,
}));

const hoisted = vi.hoisted(() => {
  return {
    mintWorkspaceToken: vi.fn(() =>
      Promise.resolve({
        status: "active" as const,
        token: "minted-jwt",
        expiresAt: Date.now() + 3600_000,
      }),
    ),
    daemonClientCalls: [] as Array<Record<string, unknown>>,
  };
});

vi.mock("@/lib/orchestra-cloud-client", () => ({
  mintWorkspaceToken: hoisted.mintWorkspaceToken,
}));

vi.mock("@getpaseo/client/internal/daemon-client", () => {
  class FakeDaemonClient {
    public config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.config = config;
      hoisted.daemonClientCalls.push(config);
    }
  }
  return { DaemonClient: FakeDaemonClient };
});

import { createDefaultDeps } from "./host-runtime";
import type { HostConnection, HostProfile } from "@/types/host-connection";
import type {
  DaemonTransport,
  DaemonTransportFactory,
} from "@getpaseo/client/internal/daemon-client-transport-types";

function makeHost(): HostProfile {
  return {
    serverId: "srv_cloud",
    label: "cloud",
    lifecycle: {},
    connections: [],
    preferredConnectionId: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

beforeEach(() => {
  hoisted.daemonClientCalls.length = 0;
  hoisted.mintWorkspaceToken.mockClear();
});

describe("host-runtime createDefaultDeps cloud-mode integration", () => {
  it("routes a directTcp connection with workspaceId through the refreshing transport factory", async () => {
    const connection: HostConnection = {
      id: "direct:cloud.example.com:443",
      type: "directTcp",
      endpoint: "cloud.example.com:443",
      useTls: true,
      workspaceId: "wks_abc",
    };

    const deps = createDefaultDeps();
    deps.createClient({
      host: makeHost(),
      connection,
      clientId: "cid_test",
      runtimeGeneration: 1,
    });

    expect(hoisted.daemonClientCalls).toHaveLength(1);
    const config = hoisted.daemonClientCalls[0];
    expect(config?.password).toBeUndefined();
    const transportFactory = config?.transportFactory as DaemonTransportFactory | undefined;
    expect(transportFactory).toBeTypeOf("function");

    // Invoking the factory triggers a fresh token mint, and the resulting
    // transport ultimately constructs a WebSocket using paseo.workspace.<jwt>.
    // We capture the WebSocket constructor calls via the global WebSocket.
    type WsCtor = new (url: string, protocols?: string | string[]) => unknown;
    const constructed: Array<{ url: string; protocols?: string | string[] }> = [];
    const originalWebSocket = (globalThis as unknown as { WebSocket?: WsCtor }).WebSocket;
    class FakeWebSocket {
      readyState = 0;
      binaryType = "arraybuffer";
      constructor(url: string, protocols?: string | string[]) {
        constructed.push({ url, protocols });
      }
      addEventListener(): void {}
      removeEventListener(): void {}
      send(): void {}
      close(): void {}
    }
    (globalThis as unknown as { WebSocket: WsCtor }).WebSocket = FakeWebSocket as unknown as WsCtor;

    let transport: DaemonTransport | null = null;
    try {
      transport = transportFactory!({ url: "wss://cloud.example.com:443/ws" });
      await vi.waitFor(() => {
        expect(hoisted.mintWorkspaceToken).toHaveBeenCalledWith("wks_abc");
        expect(constructed.length).toBe(1);
      });
      expect(constructed[0]?.protocols).toEqual(["paseo.workspace.minted-jwt"]);
    } finally {
      transport?.close();
      if (originalWebSocket) {
        (globalThis as unknown as { WebSocket: WsCtor }).WebSocket = originalWebSocket;
      } else {
        delete (globalThis as unknown as { WebSocket?: WsCtor }).WebSocket;
      }
    }
  });

  it("preserves the API-key path: directTcp without workspaceId uses password and no transport factory", () => {
    const connection: HostConnection = {
      id: "direct:lan:6767",
      type: "directTcp",
      endpoint: "lan:6767",
      useTls: false,
      password: "secret-api-key",
    };

    const deps = createDefaultDeps();
    deps.createClient({
      host: makeHost(),
      connection,
      clientId: "cid_test",
      runtimeGeneration: 1,
    });

    expect(hoisted.daemonClientCalls).toHaveLength(1);
    const config = hoisted.daemonClientCalls[0];
    expect(config?.password).toBe("secret-api-key");
    expect(config?.transportFactory).toBeUndefined();
    expect(hoisted.mintWorkspaceToken).not.toHaveBeenCalled();
  });
});
