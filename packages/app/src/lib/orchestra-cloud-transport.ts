import type {
  DaemonTransport,
  DaemonTransportFactory,
  WebSocketFactory,
  WebSocketLike,
} from "@getpaseo/client/internal/daemon-client-transport-types";
import { createWebSocketTransportFactory } from "@getpaseo/client/internal/daemon-client-websocket-transport";

export function createWorkspaceTokenTransportFactory(
  workspaceToken: string,
): DaemonTransportFactory {
  const innerFactory = createWebSocketTransportFactory((url) => {
    const ws = new WebSocket(url, [`paseo.workspace.${workspaceToken}`]);
    return ws as unknown as WebSocketLike;
  });
  return (options) => innerFactory({ ...options, protocols: undefined });
}

// Mints a fresh workspace token for every connect attempt. Token is held only
// in the closure of one transport instance — never persisted, never reused
// across reconnects. Per saas-auth.md "Workspace token model".
export function createWorkspaceTokenRefreshingTransportFactory(input: {
  tokenProvider: () => Promise<string>;
  webSocketFactory?: WebSocketFactory;
}): DaemonTransportFactory {
  return (options) => {
    interface PendingClose {
      code: number | undefined;
      reason: string | undefined;
    }
    let inner: DaemonTransport | null = null;
    let closed = false;
    const closeState: { pending: PendingClose | null } = { pending: null };
    const openHandlers = new Set<() => void>();
    const closeHandlers = new Set<(event?: unknown) => void>();
    const errorHandlers = new Set<(event?: unknown) => void>();
    const messageHandlers = new Set<(data: unknown) => void>();

    void (async () => {
      let token: string;
      try {
        token = await input.tokenProvider();
      } catch (err) {
        if (closed) return;
        for (const h of errorHandlers) h(err);
        for (const h of closeHandlers) h();
        return;
      }
      if (closed) return;
      const wsFactory: WebSocketFactory =
        input.webSocketFactory ??
        ((url) => {
          const ws = new WebSocket(url, [`paseo.workspace.${token}`]);
          return ws as unknown as WebSocketLike;
        });
      const factory = createWebSocketTransportFactory((url, opts) =>
        wsFactory(url, { ...opts, protocols: [`paseo.workspace.${token}`] }),
      );
      const transport = factory({ ...options, protocols: undefined });
      inner = transport;
      for (const h of openHandlers) transport.onOpen(h);
      for (const h of closeHandlers) transport.onClose(h);
      for (const h of errorHandlers) transport.onError(h);
      for (const h of messageHandlers) transport.onMessage(h);
      if (closeState.pending) {
        transport.close(closeState.pending.code, closeState.pending.reason);
      }
    })();

    return {
      send: (data) => {
        if (!inner) {
          throw new Error("WebSocket not open (workspace token fetch in flight)");
        }
        inner.send(data);
      },
      close: (code, reason) => {
        closed = true;
        if (inner) {
          inner.close(code, reason);
        } else {
          closeState.pending = { code, reason };
        }
      },
      onOpen: (handler) => {
        if (inner) return inner.onOpen(handler);
        openHandlers.add(handler);
        return () => {
          openHandlers.delete(handler);
        };
      },
      onClose: (handler) => {
        if (inner) return inner.onClose(handler);
        closeHandlers.add(handler);
        return () => {
          closeHandlers.delete(handler);
        };
      },
      onError: (handler) => {
        if (inner) return inner.onError(handler);
        errorHandlers.add(handler);
        return () => {
          errorHandlers.delete(handler);
        };
      },
      onMessage: (handler) => {
        if (inner) return inner.onMessage(handler);
        messageHandlers.add(handler);
        return () => {
          messageHandlers.delete(handler);
        };
      },
    };
  };
}

// Like the refreshing factory, but the FIRST connect uses a token that was
// already minted OUTSIDE the connect timeout (fix A: the workspace-token mint +
// access-token refresh must not run inside the 6s connect deadline, or a slow
// refresh opens the WS too late for the `hello` handshake to finish → stuck
// "connecting"). Subsequent connects (reconnects) fall back to `tokenProvider`,
// re-minting a fresh short-lived token — the token is never reused across
// reconnects (same invariant as above).
export function createSeededWorkspaceTokenTransportFactory(input: {
  initialToken: string;
  tokenProvider: () => Promise<string>;
  webSocketFactory?: WebSocketFactory;
}): DaemonTransportFactory {
  let consumed = false;
  return createWorkspaceTokenRefreshingTransportFactory({
    ...(input.webSocketFactory ? { webSocketFactory: input.webSocketFactory } : {}),
    tokenProvider: async () => {
      if (!consumed) {
        consumed = true;
        return input.initialToken;
      }
      return input.tokenProvider();
    },
  });
}
