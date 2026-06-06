import { describe, expect, it } from "vitest";
import type { HostProfile } from "@/types/host-connection";
import { resolveWelcomeRedirectServerId } from "./welcome-redirect";

function makeHost(input: {
  serverId: string;
  connectionType: "directTcp" | "relay";
  workspaceId?: string;
}): HostProfile {
  const connectionId =
    input.connectionType === "directTcp" ? "direct:host:443" : "relay:relay.example:443";
  const connection =
    input.connectionType === "directTcp"
      ? {
          id: connectionId,
          type: "directTcp" as const,
          endpoint: "host:443",
          useTls: true,
          ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        }
      : {
          id: connectionId,
          type: "relay" as const,
          relayEndpoint: "relay.example:443",
          daemonPublicKeyB64: "key",
        };
  return {
    serverId: input.serverId,
    label: input.serverId,
    lifecycle: {},
    connections: [connection],
    preferredConnectionId: connectionId,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

describe("resolveWelcomeRedirectServerId", () => {
  it("returns null when no host is online", () => {
    expect(
      resolveWelcomeRedirectServerId({ anyOnlineServerId: null, hosts: [], isWeb: true }),
    ).toBeNull();
  });

  it("on web, does NOT redirect into a cloud workspace host (lets /orchestra/setup run)", () => {
    // Regression: a persisted cloud host (directTcp + workspaceId) coming online
    // must not hijack the Connect-to-Orchestra create-workspace flow.
    const cloudHost = makeHost({
      serverId: "ws_74d480de",
      connectionType: "directTcp",
      workspaceId: "ws_74d480de",
    });
    expect(
      resolveWelcomeRedirectServerId({
        anyOnlineServerId: "ws_74d480de",
        hosts: [cloudHost],
        isWeb: true,
      }),
    ).toBeNull();
  });

  it("on web, still redirects into a non-cloud (relay) host", () => {
    const relayHost = makeHost({ serverId: "srv_local", connectionType: "relay" });
    expect(
      resolveWelcomeRedirectServerId({
        anyOnlineServerId: "srv_local",
        hosts: [relayHost],
        isWeb: true,
      }),
    ).toBe("srv_local");
  });

  it("on native, redirects into a cloud host (unchanged jump-straight-in behavior)", () => {
    const cloudHost = makeHost({
      serverId: "ws_74d480de",
      connectionType: "directTcp",
      workspaceId: "ws_74d480de",
    });
    expect(
      resolveWelcomeRedirectServerId({
        anyOnlineServerId: "ws_74d480de",
        hosts: [cloudHost],
        isWeb: false,
      }),
    ).toBe("ws_74d480de");
  });
});
