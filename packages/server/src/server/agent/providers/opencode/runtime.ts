import {
  createOpencodeClient,
  type OpencodeClient,
  type OpencodeClientConfig,
} from "@opencode-ai/sdk/v2/client";

export interface OpenCodeServerAcquisition {
  server: { port: number; url: string };
  release: () => void;
}

export interface OpenCodeRuntime {
  // D-3.5c — `launchEnv` carries the resolved scoped env (workspace +
  // project vars) for the spawning session. OpenCode uses a single shared
  // server process (one per daemon), so the overlay is applied when that
  // process boots — i.e. for the first session that starts it (or after a
  // forced refresh). This closes the forwarding gap (the server-manager
  // previously spawned with no overlays); see server-manager.ts:startServer.
  acquireServer(options: {
    force: boolean;
    launchEnv?: Record<string, string>;
  }): Promise<OpenCodeServerAcquisition>;
  ensureServerRunning(): Promise<{ port: number; url: string }>;
  createClient(options: { baseUrl: string; directory: string }): OpencodeClient;
  shutdown(): Promise<void>;
}

export function createSdkOpenCodeClient(options: {
  baseUrl: string;
  directory: string;
}): OpencodeClient {
  return createOpencodeClient(options satisfies OpencodeClientConfig & { directory: string });
}
