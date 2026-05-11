import type {
  DaemonTransportFactory,
  WebSocketLike,
} from "@server/client/daemon-client-transport-types";
import { createWebSocketTransportFactory } from "@server/client/daemon-client-websocket-transport";

export function createWorkspaceTokenTransportFactory(
  workspaceToken: string,
): DaemonTransportFactory {
  const innerFactory = createWebSocketTransportFactory((url) => {
    const ws = new WebSocket(url, [`paseo.workspace.${workspaceToken}`]);
    return ws as unknown as WebSocketLike;
  });
  return (options) => innerFactory({ ...options, protocols: undefined });
}
