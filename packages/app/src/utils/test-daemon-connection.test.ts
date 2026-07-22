import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClientConfig } from "@getpaseo/client/internal/daemon-client";
import type { MintWorkspaceTokenResult } from "@/lib/orchestra-cloud-client";
import type { DaemonConnectionDependencies, DaemonProbeClient } from "./test-daemon-connection";

class FakeDaemonClient implements DaemonProbeClient {
  readonly lastError: string | null;

  constructor(
    private readonly probe: FakeDaemonProbe,
    readonly config: DaemonClientConfig,
  ) {
    this.lastError = probe.nextLastError;
  }

  async connect(): Promise<void> {
    if (this.probe.nextConnectError) {
      throw this.probe.nextConnectError;
    }
  }

  getLastServerInfoMessage() {
    return {
      serverId: "srv_probe_test",
      hostname: "probe-host",
    };
  }

  async close(): Promise<void> {
    this.probe.closedClients.push(this);
  }
}

class FakeDaemonProbe {
  createdClients: FakeDaemonClient[] = [];
  closedClients: FakeDaemonClient[] = [];
  clientIdsRequested = 0;
  nextConnectError: Error | null = null;
  nextLastError: string | null = null;

  // Controllable per test — the cloud (workspaceId) path mints through this.
  mint = vi.fn(
    (workspaceId: string): Promise<MintWorkspaceTokenResult> =>
      Promise.resolve({ status: "active", token: `wtok_${workspaceId}`, expiresAt: 0 }),
  );

  readonly deps: DaemonConnectionDependencies<FakeDaemonClient> = {
    getClientId: async () => {
      this.clientIdsRequested += 1;
      return "cid_shared_probe_test";
    },
    resolveAppVersion: () => null,
    createLocalTransportFactory: () => null,
    buildLocalTransportUrl: ({ transportType, transportPath }) =>
      `paseo+local://${transportType}?path=${encodeURIComponent(transportPath)}`,
    createClient: (config) => {
      const client = new FakeDaemonClient(this, config);
      this.createdClients.push(client);
      return client;
    },
    mintWorkspaceToken: (workspaceId) => this.mint(workspaceId),
  };

  failNextConnection(error: Error, lastError: string | null): void {
    this.nextConnectError = error;
    this.nextLastError = lastError;
  }

  createdConfigs(): DaemonClientConfig[] {
    return this.createdClients.map((client) => client.config);
  }
}

describe("test-daemon-connection connectToDaemon", () => {
  let probe: FakeDaemonProbe;

  beforeEach(() => {
    vi.stubGlobal("__DEV__", false);
    probe = new FakeDaemonProbe();
  });

  it("reuses the app clientId for direct connections", async () => {
    const { connectToDaemon } = await import("./test-daemon-connection");
    const first = await connectToDaemon(
      {
        id: "direct:lan:6767",
        type: "directTcp",
        endpoint: "lan:6767",
      },
      undefined,
      probe.deps,
    );
    await first.client.close();

    const second = await connectToDaemon(
      {
        id: "direct:lan:6767",
        type: "directTcp",
        endpoint: "lan:6767",
      },
      undefined,
      probe.deps,
    );
    await second.client.close();

    const [firstConfig, secondConfig] = probe.createdConfigs();
    expect(firstConfig?.clientId).toBe("cid_shared_probe_test");
    expect(secondConfig?.clientId).toBe("cid_shared_probe_test");
    expect(probe.clientIdsRequested).toBe(2);
  });

  it("encodes the local socket target into the client config", async () => {
    const { connectToDaemon } = await import("./test-daemon-connection");
    const result = await connectToDaemon(
      {
        id: "socket:/tmp/paseo.sock",
        type: "directSocket",
        path: "/tmp/paseo.sock",
      },
      undefined,
      probe.deps,
    );
    await result.client.close();

    expect(probe.createdConfigs()[0]?.url).toBe("paseo+local://socket?path=%2Ftmp%2Fpaseo.sock");
  });

  it("passes direct TCP connection passwords into the client config", async () => {
    const { connectToDaemon } = await import("./test-daemon-connection");
    const result = await connectToDaemon(
      {
        id: "direct:lan:6767",
        type: "directTcp",
        endpoint: "lan:6767",
        password: "shared-secret",
      },
      undefined,
      probe.deps,
    );
    await result.client.close();

    expect(probe.createdConfigs()[0]?.password).toBe("shared-secret");
  });

  it("uses relay TLS from the stored connection", async () => {
    const { connectToDaemon } = await import("./test-daemon-connection");
    const tlsResult = await connectToDaemon(
      {
        id: "relay:wss:[::1]:443",
        type: "relay",
        relayEndpoint: "[::1]:443",
        useTls: true,
        daemonPublicKeyB64: "pubkey",
      },
      { serverId: "srv_probe_test" },
      probe.deps,
    );
    await tlsResult.client.close();

    const plainResult = await connectToDaemon(
      {
        id: "relay:relay.paseo.sh:443",
        type: "relay",
        relayEndpoint: "relay.paseo.sh:443",
        useTls: false,
        daemonPublicKeyB64: "pubkey",
      },
      { serverId: "srv_probe_test" },
      probe.deps,
    );
    await plainResult.client.close();

    expect(probe.createdConfigs()[0]?.url).toMatch(/^wss:\/\/\[::1\]\/ws\?/);
    expect(probe.createdConfigs()[1]?.url).toMatch(/^ws:\/\/relay\.paseo\.sh:443\/ws\?/);
  });

  it("surfaces auth rejection as an incorrect password", async () => {
    const { connectToDaemon } = await import("./test-daemon-connection");
    probe.failNextConnection(
      new Error("Transport closed (code 4001)"),
      "Transport closed (code 4001)",
    );

    await expect(
      connectToDaemon(
        {
          id: "direct:lan:6767",
          type: "directTcp",
          endpoint: "lan:6767",
          password: "wrong-secret",
        },
        undefined,
        probe.deps,
      ),
    ).rejects.toMatchObject({
      message: "Incorrect password",
    });
  });

  it("pre-mints the cloud workspace token before creating the client (outside the connect timeout)", async () => {
    const { connectToDaemon } = await import("./test-daemon-connection");

    // A deferred mint stands in for a slow token mint / access-token refresh.
    let releaseMint!: (result: MintWorkspaceTokenResult) => void;
    probe.mint.mockImplementationOnce(
      () =>
        new Promise<MintWorkspaceTokenResult>((resolve) => {
          releaseMint = resolve;
        }),
    );

    const pending = connectToDaemon(
      {
        id: "direct:ws-x",
        type: "directTcp",
        endpoint: "ws-x.dev:443",
        useTls: true,
        workspaceId: "ws_x",
      },
      undefined,
      probe.deps,
    );

    // Fix A: the mint (and any refresh it triggers) must complete BEFORE the
    // client is created — i.e. before connectAndProbe arms its 6s timer — so a
    // slow refresh can never eat the WS+hello connect budget.
    await vi.waitFor(() => expect(probe.mint).toHaveBeenCalledWith("ws_x"));
    expect(probe.createdClients.length).toBe(0);

    releaseMint({ status: "active", token: "wtok_live", expiresAt: 0 });
    const result = await pending;
    await result.client.close();

    expect(probe.createdClients.length).toBe(1);
    expect(probe.createdConfigs()[0]?.transportFactory).toBeDefined();
  });

  it("rejects the probe (no client created) when the workspace token mint is not active", async () => {
    const { connectToDaemon } = await import("./test-daemon-connection");
    probe.mint.mockResolvedValueOnce({ status: "resuming", retryAfterMs: 1500 });

    await expect(
      connectToDaemon(
        {
          id: "direct:ws-y",
          type: "directTcp",
          endpoint: "ws-y.dev:443",
          useTls: true,
          workspaceId: "ws_y",
        },
        undefined,
        probe.deps,
      ),
    ).rejects.toThrow(/status=resuming/);

    // Pre-mint failed before the timed connect, so no client is ever created;
    // the probe cycle treats this the same as any unreachable-host outcome.
    expect(probe.createdClients.length).toBe(0);
  });

  it("keeps generic transport failures generic when a password was supplied", async () => {
    const { connectToDaemon } = await import("./test-daemon-connection");
    probe.failNextConnection(new Error("Transport error"), "Transport error");

    await expect(
      connectToDaemon(
        {
          id: "direct:lan:6767",
          type: "directTcp",
          endpoint: "lan:6767",
          password: "shared-secret",
        },
        undefined,
        probe.deps,
      ),
    ).rejects.toMatchObject({
      message: "Transport error",
    });
  });
});
