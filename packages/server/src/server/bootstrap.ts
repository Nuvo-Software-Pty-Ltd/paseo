import express from "express";
import { createServer as createHTTPServer, type IncomingMessage, type ServerResponse } from "http";
import { constants, existsSync, unlinkSync } from "fs";
import { open } from "fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import { hostname as getHostname } from "node:os";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Logger } from "pino";
import { z } from "zod";
import { createBranchChangeRouteHandler } from "./script-route-branch-handler.js";

export type ListenTarget =
  | { type: "tcp"; host: string; port: number }
  | { type: "socket"; path: string }
  | { type: "pipe"; path: string };

function resolveBoundListenTarget(
  listenTarget: ListenTarget,
  httpServer: ReturnType<typeof createHTTPServer>,
): ListenTarget {
  if (listenTarget.type !== "tcp") {
    return listenTarget;
  }

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP server did not expose a TCP address after listening");
  }

  return {
    type: "tcp",
    host: listenTarget.host,
    port: address.port,
  };
}

// Matches a Windows drive-letter path like C:\ or D:\
const WINDOWS_DRIVE_RE = /^[A-Za-z]:\\/;

export function parseListenString(listen: string): ListenTarget {
  // 1. Windows named pipes: \\.\pipe\... or pipe://...
  if (listen.startsWith("\\\\.\\pipe\\") || listen.startsWith("pipe://")) {
    return {
      type: "pipe",
      path: listen.startsWith("pipe://") ? listen.slice("pipe://".length) : listen,
    };
  }
  // 2. Explicit unix:// prefix
  if (listen.startsWith("unix://")) {
    return { type: "socket", path: listen.slice(7) };
  }
  // 3. Reject Windows absolute drive paths — they are not Unix sockets
  if (WINDOWS_DRIVE_RE.test(listen)) {
    throw new Error(`Invalid listen string (Windows path is not a valid listen target): ${listen}`);
  }
  // 4. POSIX absolute path (/ or ~) — Unix socket
  if (listen.startsWith("/") || listen.startsWith("~")) {
    return { type: "socket", path: listen };
  }
  // 5. Pure numeric — TCP port on 127.0.0.1
  const trimmed = listen.trim();
  if (/^\d+$/.test(trimmed)) {
    const port = parseInt(trimmed, 10);
    return { type: "tcp", host: "127.0.0.1", port };
  }
  // 6. host:port — TCP
  if (listen.includes(":")) {
    const lastColonIdx = listen.lastIndexOf(":");
    const host = listen.slice(0, lastColonIdx);
    const portStr = listen.slice(lastColonIdx + 1);
    const parsedPort = parseInt(portStr, 10);
    if (!Number.isFinite(parsedPort)) {
      throw new Error(`Invalid port in listen string: ${listen}`);
    }
    const cleanHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    return { type: "tcp", host: cleanHost || "127.0.0.1", port: parsedPort };
  }
  throw new Error(`Invalid listen string: ${listen}`);
}

function formatListenTarget(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget) {
    return null;
  }
  if (listenTarget.type === "tcp") {
    return `${listenTarget.host}:${listenTarget.port}`;
  }
  return listenTarget.path;
}

import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import { createGitHubService } from "../services/github-service.js";
import {
  createPaseoWorktree as createRegisteredPaseoWorktree,
  createLocalCheckoutWorkspace,
} from "./paseo-worktree-service.js";
import {
  createPaseoWorktreeWorkflow,
  type CreatePaseoWorktreeWorkflowDependencies,
} from "./worktree-session.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import type { OpenAiSpeechProviderConfig } from "./speech/providers/openai/config.js";
import type { LocalSpeechProviderConfig } from "./speech/providers/local/config.js";
import type { RequestedSpeechProviders } from "./speech/speech-types.js";
import { createSpeechService } from "./speech/speech-runtime.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage, type AgentStore } from "./agent/agent-storage.js";
import { DynamoAgentStore } from "./agent/dynamo-agent-store.js";
import {
  attachAgentStoragePersistence,
  attachProviderTranscriptCapture,
  attachWorkspaceSnapshotCapture,
} from "./persistence-hooks.js";
import { createAgentMcpServer } from "./agent/mcp-server.js";
import { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import { bootstrapWorkspaceRegistries } from "./workspace-registry-bootstrap.js";
// Upstream added WorkspaceReconciliationService; cloud keeps the wider
// registry import set (InMemory*/FileBackedWorkspaceContainerRegistry +
// interface types) because cloud mode swaps in the InMemory*/Dynamo-backed
// variants. Cloud uses ChatService (+ injected ChatStore), not upstream's
// FileBackedChatService.
import { WorkspaceReconciliationService } from "./workspace-reconciliation-service.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceContainerRegistry,
  FileBackedWorkspaceRegistry,
  InMemoryWorkspaceContainerRegistry,
  InMemoryWorkspaceRegistry,
  type ProjectRegistry,
  type WorkspaceContainerRegistry,
  type WorkspaceRegistry,
} from "./workspace-registry.js";
import { DynamoProjectStore } from "./project/dynamo-project-store.js";
import { FileBackedEnvVarStore, type EnvVarStore } from "./env/env-var-store.js";
import { DynamoEnvVarStore } from "./env/dynamo-env-var-store.js";
import { createScopedEnvResolver, resolveAmbientContainerId } from "./env/scoped-env-resolver.js";
import { createProjectForCwdResolver } from "./env/project-for-cwd.js";
import { ChatService } from "./chat/chat-service.js";
import { FileBackedChatStore, type ChatStore } from "./chat/chat-store.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { LoopService } from "./loop-service.js";
import { FileBackedLoopStore, type LoopStore } from "./loop-store.js";
import { ScheduleService } from "./schedule/service.js";
import { FileBackedScheduleStore, type ScheduleStore } from "./schedule/store.js";
import { FileBackedWebhookTriggerStore, type WebhookTriggerStore } from "./trigger/store.js";
import { DynamoWebhookTriggerStore } from "./trigger/dynamo-store.js";
import { FileBackedTriggerSecretStore } from "./trigger/secret-store.js";
import { TriggerService } from "./trigger/service.js";
import {
  CloudTriggerProvisioner,
  SelfHostTriggerProvisioner,
  type TriggerProvisioner,
} from "./trigger/provisioner.js";
import { createSelfHostWebhookReceiver } from "./trigger/self-host-receiver.js";
import { DaemonConfigStore } from "./daemon-config-store.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";
import { resolveWorkspaceIdForPath } from "./resolve-workspace-id-for-path.js";
import {
  archivePersistedWorkspaceRecord,
  unarchivePersistedWorkspaceRecord,
  type ActiveWorkspaceRef,
} from "./workspace-archive-service.js";
import { setupAutoArchiveOnMerge } from "./auto-archive-on-merge/index.js";
import { wrapSessionMessage, type SessionOutboundMessage } from "./messages.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import { createConfiguredTerminalManager } from "../terminal/terminal-manager-factory.js";
import { applyTerminalAgentHookSetting } from "../terminal/agent-hooks/terminal-agent-hook-setting.js";
import { createConnectionOfferV2, encodeOfferToFragmentUrl } from "./connection-offer.js";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { startRelayTransport, type RelayTransportController } from "./relay-transport.js";
import type { PushNotificationSender } from "./push/notifications.js";
import { getOrCreateServerId } from "./server-id.js";
import { resolveDaemonVersion } from "./daemon-version.js";
import type { AgentClient, AgentProvider } from "./agent/agent-sdk-types.js";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
} from "./agent/provider-launch-config.js";
import type { PersistedConfig } from "./persisted-config.js";
import { createServiceProxySubsystem, type ServiceProxySubsystem } from "./service-proxy.js";
import { ScriptHealthMonitor } from "./script-health-monitor.js";
import { createScriptStatusEmitter } from "./script-status-projection.js";
import { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import {
  createManagedProcessRegistry,
  createSystemManagedProcessTable,
  type ManagedProcessRegistry,
} from "./managed-processes/managed-processes.js";
import { terminateWithTreeKill } from "../utils/tree-kill.js";
import { isHostnameAllowed, type HostnamesConfig } from "./hostnames.js";
import {
  bearerMatchesCapabilityToken,
  createRequireBearerMiddleware,
  createRequireWorkspaceMiddleware,
  isAgentMcpRequestAuthorized,
  type DaemonAuthConfig,
  type WorkspaceAuthCallback,
} from "./auth.js";
import { createJwksWorkspaceAuthCallback } from "./cloud-auth.js";
import { createCloudTurnEndHook } from "./cloud-turn-end-hook.js";
import { maybeExposeGithubTokenToEnv } from "./cloud-clone.js";
import { ensureCloudWorkspaceRepoCloned } from "./cloud-workspace-repair.js";
import { buildGithubTokenEnvDefaults } from "./cloud-github-token.js";
import { materializeGitCredentialHelper } from "./cloud-git-credential.js";
import { ensureToolchainDirs, isPaseoCloudMode } from "./paseo-env.js";
import { createInternalRoutes } from "./internal-routes.js";
import {
  DynamoPermissionStore,
  FileBackedPermissionStore,
  type PermissionStore,
} from "./agent/permission-store.js";
import { DynamoChatStore } from "./chat/dynamo-chat-store.js";
import { DynamoLoopStore } from "./dynamo-loop-store.js";
import { DynamoScheduleStore } from "./schedule/dynamo-store.js";
import { DynamoAgentTimelineStore } from "./agent/dynamo-agent-timeline-store.js";
import type { AgentTimelineStore } from "./agent/agent-timeline-store-types.js";
import { buildCloudModeDynamoLike } from "./cloud-dynamo-adapter.js";
import { resolveCloudStateTableName, type DynamoLike } from "./cloud-dynamo-client.js";
import { fireDaemonVersionBeacon, resolveDaemonImageTag } from "./cloud-version-beacon.js";
import {
  startHeartbeatLoop,
  type HeartbeatLoopController,
  type HeartbeatSessionRegistry,
} from "./cloud-heartbeat.js";

const MAX_MCP_DEBUG_BATCH_ITEMS = 10;
const REDACTED_LOG_VALUE = "[redacted]";
const DOWNLOAD_OPEN_FLAGS =
  process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;

function formatHostForHttpUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function resolveAgentMcpClientHost(host: string): string {
  if (host === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (host === "::" || host === "[::]") {
    return "::1";
  }
  return host;
}

function createAgentMcpBaseUrl(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  const host = resolveAgentMcpClientHost(listenTarget.host);
  return new URL(
    "/mcp/agents",
    `http://${formatHostForHttpUrl(host)}:${listenTarget.port}`,
  ).toString();
}

function createTerminalActivityUrl(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  const host = resolveAgentMcpClientHost(listenTarget.host);
  return new URL(
    "/api/terminal-activity",
    `http://${formatHostForHttpUrl(host)}:${listenTarget.port}`,
  ).toString();
}

const TerminalActivityReportSchema = z.object({
  terminalId: z.string().min(1),
  token: z.string().min(1),
  state: z.enum(["running", "idle", "needs-input"]),
});

const TERMINAL_ACTIVITY_STATE_MAP = {
  running: "working",
  idle: "idle",
  "needs-input": "attention",
} as const;

const LOOPBACK_REMOTE_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  return remoteAddress !== undefined && LOOPBACK_REMOTE_ADDRESSES.has(remoteAddress);
}

export function createTerminalActivityRouteHandler(
  terminalManager: TerminalManager,
): express.RequestHandler {
  return async (req, res) => {
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const parsed = TerminalActivityReportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid terminal activity report" });
      return;
    }

    const validation = terminalManager.validateTerminalActivityToken(
      parsed.data.terminalId,
      parsed.data.token,
    );
    if (validation !== "valid") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    try {
      const updated = await terminalManager.setTerminalActivity(
        parsed.data.terminalId,
        TERMINAL_ACTIVITY_STATE_MAP[parsed.data.state],
      );
      if (!updated) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      res.status(204).end();
    } catch {
      res.status(500).json({ error: "Failed to update terminal activity" });
    }
  };
}

function summarizeAgentMcpDebugMessage(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      type: body === null ? "null" : typeof body,
    };
  }

  const record = body as Record<string, unknown>;
  const method = typeof record.method === "string" ? record.method : undefined;
  return {
    type: "object",
    ...(typeof record.jsonrpc === "string" ? { jsonrpc: record.jsonrpc } : {}),
    ...(method ? { method } : {}),
    hasId: Object.prototype.hasOwnProperty.call(record, "id"),
    hasParams: Object.prototype.hasOwnProperty.call(record, "params"),
  };
}

function summarizeAgentMcpDebugBody(body: unknown): Record<string, unknown> {
  if (!Array.isArray(body)) {
    return summarizeAgentMcpDebugMessage(body);
  }

  const messages = body.slice(0, MAX_MCP_DEBUG_BATCH_ITEMS).map(summarizeAgentMcpDebugMessage);
  return {
    type: "batch",
    count: body.length,
    messages,
    ...(body.length > messages.length ? { omitted: body.length - messages.length } : {}),
  };
}

export type PaseoOpenAIConfig = OpenAiSpeechProviderConfig;
export type PaseoLocalSpeechConfig = LocalSpeechProviderConfig;

export interface PaseoSpeechSttLanguages {
  dictation: string;
  voice: string;
}

export interface PaseoSpeechConfig {
  providers: RequestedSpeechProviders;
  sttLanguages?: PaseoSpeechSttLanguages;
  local?: PaseoLocalSpeechConfig;
}

export type DaemonLifecycleIntent =
  | {
      type: "shutdown";
      clientId: string;
      requestId: string;
    }
  | {
      type: "restart";
      clientId: string;
      requestId: string;
      reason?: string;
    };

export interface PaseoDaemonConfig {
  listen: string;
  paseoHome: string;
  worktreesRoot?: string;
  corsAllowedOrigins: string[];
  allowedHosts?: HostnamesConfig;
  hostnames?: HostnamesConfig;
  mcpEnabled?: boolean;
  mcpInjectIntoAgents?: boolean;
  autoArchiveAfterMerge?: boolean;
  enableTerminalAgentHooks?: boolean;
  appendSystemPrompt?: string;
  terminalProfiles?: TerminalProfile[];
  staticDir: string;
  mcpDebug: boolean;
  isDev?: boolean;
  agentClients: Partial<Record<AgentProvider, AgentClient>>;
  agentStoragePath: string;
  relayEnabled?: boolean;
  relayEndpoint?: string;
  relayPublicEndpoint?: string;
  relayUseTls?: boolean;
  relayPublicUseTls?: boolean;
  serviceProxy?: {
    publicBaseUrl: string | null;
    standaloneListen: string | null;
  };
  appBaseUrl?: string;
  auth?: DaemonAuthConfig;
  openai?: PaseoOpenAIConfig;
  speech?: PaseoSpeechConfig;
  voiceLlmProvider?: AgentProvider | null;
  voiceLlmProviderExplicit?: boolean;
  voiceLlmModel?: string | null;
  dictationFinalTimeoutMs?: number;
  downloadTokenTtlMs?: number;
  agentProviderSettings?: AgentProviderRuntimeSettingsMap;
  metadataGeneration?: {
    providers?: Array<{
      provider: string;
      model?: string;
      thinkingOptionId?: string;
    }>;
  };
  providerOverrides?: Record<string, ProviderOverride>;
  log?: PersistedConfig["log"];
  onLifecycleIntent?: (intent: DaemonLifecycleIntent) => void;
  pushNotificationSender?: PushNotificationSender;
  managedProcesses?: ManagedProcessRegistry;
}

export interface PaseoDaemon {
  config: PaseoDaemonConfig;
  agentManager: AgentManager;
  agentStorage: AgentStore;
  terminalManager: TerminalManager;
  serviceProxy: ServiceProxySubsystem;
  scriptRuntimeStore: WorkspaceScriptRuntimeStore;
  start(): Promise<void>;
  stop(): Promise<void>;
  getListenTarget(): ListenTarget | null;
}

function createBootstrapManagedProcessRegistry(
  config: Pick<PaseoDaemonConfig, "paseoHome" | "managedProcesses">,
  logger: Logger,
): ManagedProcessRegistry {
  if (config.managedProcesses) {
    return config.managedProcesses;
  }

  return createManagedProcessRegistry({
    paseoHome: config.paseoHome,
    processTable: createSystemManagedProcessTable(),
    terminateProcess: terminateWithTreeKill,
    logger,
  });
}

async function reconcileManagedProcessLedger(
  managedProcesses: ManagedProcessRegistry,
  logger: Logger,
): Promise<void> {
  const reapResult = await managedProcesses.reapStale();
  if (reapResult.checked > 0 || reapResult.errors.length > 0) {
    logger.info(reapResult, "Managed helper process ledger reconciled");
  }
}

// eslint-disable-next-line complexity
export async function createPaseoDaemon(
  config: PaseoDaemonConfig,
  rootLogger: Logger,
): Promise<PaseoDaemon> {
  const logger = rootLogger.child({ module: "bootstrap" });
  const bootstrapStart = performance.now();
  const elapsed = () => `${(performance.now() - bootstrapStart).toFixed(0)}ms`;
  const daemonVersion = resolveDaemonVersion(import.meta.url);
  // Materialize the toolchain prefix tree (TMPDIR + tool caches) before anything
  // spawns: /workspace is tmpfs and the cloud RunTask injects PASEO_TOOLCHAIN_PREFIX
  // but never creates the tree, so the Claude CLI's per-run settings write into
  // TMPDIR ENOENTs without it. No-op on-host (prefix unset); best-effort (never throws).
  await ensureToolchainDirs(process.env, logger);
  const daemonConfigStore = new DaemonConfigStore(
    config.paseoHome,
    {
      mcp: { injectIntoAgents: config.mcpInjectIntoAgents ?? true },
      providers: Object.fromEntries(
        Object.entries(config.providerOverrides ?? {}).map(([providerId, override]) => [
          providerId,
          {
            ...(override.enabled !== undefined ? { enabled: override.enabled } : {}),
            ...(override.additionalModels ? { additionalModels: override.additionalModels } : {}),
          },
        ]),
      ),
      metadataGeneration: {
        providers: config.metadataGeneration?.providers ?? [],
      },
      autoArchiveAfterMerge: config.autoArchiveAfterMerge ?? false,
      enableTerminalAgentHooks: config.enableTerminalAgentHooks ?? false,
      appendSystemPrompt: config.appendSystemPrompt ?? "",
      ...(config.terminalProfiles !== undefined
        ? { terminalProfiles: config.terminalProfiles }
        : {}),
    },
    logger,
  );

  const serverId = getOrCreateServerId(config.paseoHome, { logger });
  const daemonKeyPair = await loadOrCreateDaemonKeyPair(config.paseoHome, logger);
  const managedProcesses = createBootstrapManagedProcessRegistry(config, logger);
  // Reconcile the helper-process ledger in the background so it never blocks the
  // daemon from coming up; terminating a live leftover can take a few seconds.
  // Best-effort, so a failure is logged here rather than crashing startup.
  void reconcileManagedProcessLedger(managedProcesses, logger).catch((error) => {
    logger.warn({ err: error }, "Failed to reconcile managed helper process ledger");
  });
  let relayTransport: RelayTransportController | null = null;
  let heartbeatController: HeartbeatLoopController | null = null;

  const staticDir = config.staticDir;
  const downloadTokenTtlMs = config.downloadTokenTtlMs ?? 60000;

  const downloadTokenStore = new DownloadTokenStore({
    ttlMs: downloadTokenTtlMs,
  });

  // Capability token authenticating the daemon's own agents to the loopback
  // Agent MCP endpoint (/mcp/agents). Random per daemon run, injected only into
  // local agent configs and the daemon's own MCP client — never sent to remote
  // clients — so it cannot be replayed off-box. This lets the injected MCP
  // authenticate even when the daemon password is set via the app (hash only,
  // no plaintext available). Mirrors the /api/files/download capability-token
  // pattern.
  const agentMcpAuthToken = randomUUID();

  const listenTarget = parseListenString(config.listen);

  const app = express();
  let boundListenTarget: ListenTarget | null = null;
  // Cloud mode assigns InMemoryWorkspaceRegistry here, so the binding must be
  // typed to the interface, not upstream's concrete FileBackedWorkspaceRegistry.
  let workspaceRegistry: WorkspaceRegistry | null = null;
  const terminalManager = createConfiguredTerminalManager({
    getTerminalActivityUrl: () => createTerminalActivityUrl(boundListenTarget),
  });
  applyTerminalAgentHookSetting({ store: daemonConfigStore, logger });

  const serviceProxyPublicBaseUrl = config.serviceProxy?.publicBaseUrl
    ? config.serviceProxy.publicBaseUrl
    : null;
  const serviceProxy = createServiceProxySubsystem({
    logger,
    publicBaseUrl: serviceProxyPublicBaseUrl,
  });
  const scriptRuntimeStore = new WorkspaceScriptRuntimeStore();
  const configuredHostnames = config.hostnames ?? config.allowedHosts;
  let wsServer: VoiceAssistantWebSocketServer | null = null;
  let serviceProxyListenTarget: ListenTarget | null = null;
  const scriptHealthMonitor = new ScriptHealthMonitor({
    serviceProxy,
    onChange: createScriptStatusEmitter({
      sessions: () =>
        wsServer?.listActiveSessions().map((session) => ({
          emit: (message) => session.emitServerMessage(message),
        })) ?? [],
      serviceProxy,
      runtimeStore: scriptRuntimeStore,
      daemonPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
      resolveWorkspaceDirectory: async (workspaceId) =>
        (await workspaceRegistry?.get(workspaceId))?.cwd ?? null,
      logger,
      serviceProxyPublicBaseUrl,
    }),
  });
  const handleBranchChange = createBranchChangeRouteHandler({
    serviceProxy,
    onRoutesChanged: (workspaceId) => {
      scriptHealthMonitor.invalidateWorkspace(workspaceId);
    },
    logger,
  });

  // Service proxy classifies service hosts before daemon auth/route fallthrough.
  // Registered service hosts proxy directly; known service namespaces without a
  // route return 404 and never reach daemon APIs.
  app.use(serviceProxy.middleware());

  // Host allowlist / DNS rebinding protection (vite-like semantics).
  // For non-TCP (unix sockets), skip host validation.
  if (listenTarget.type === "tcp") {
    app.use((req, res, next) => {
      const hostHeader = typeof req.headers.host === "string" ? req.headers.host : undefined;
      if (!isHostnameAllowed(hostHeader, configuredHostnames)) {
        res.status(403).json({ error: "Invalid Host header" });
        return;
      }
      next();
    });
  }

  // CORS - allow same-origin + configured origins
  const allowedOrigins = new Set([
    ...config.corsAllowedOrigins,
    // Packaged desktop renderers use the custom paseo:// protocol scheme.
    "paseo://app",
    // For TCP, add localhost variants
    ...(listenTarget.type === "tcp"
      ? [
          `http://${listenTarget.host}:${listenTarget.port}`,
          `http://localhost:${listenTarget.port}`,
          `http://127.0.0.1:${listenTarget.port}`,
        ]
      : []),
  ]);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.has("*") || allowedOrigins.has(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Upstream's terminal-activity route is local, token-gated, and
  // deliberately mounted BEFORE any auth middleware so it skips daemon auth.
  // It must precede the cloud workspace-token / bearer middleware below.
  app.post(
    "/api/terminal-activity",
    express.json(),
    createTerminalActivityRouteHandler(terminalManager),
  );

  // Internal HMAC-auth'd routes (auth-service → daemon RPC). Mounted BEFORE
  // the workspace-token middleware so they use their own auth mechanism.
  // Only enabled in cloud mode; on-host daemon ignores these routes.
  // Capture the internal HMAC key + flag so the post-service route
  // mount (T-15 / T-16, after scheduleService is built below) reuses
  // the same value. clone-repo is registered here (pre-service) as in
  // the D-2 deploy; schedule-fire and file-download-internal mount
  // later in the boot sequence once scheduleService exists.
  let internalHmacKeyForLateMount: string | null = null;
  if (isPaseoCloudMode()) {
    const internalHmacKey = process.env.ORCHESTRA_INTERNAL_HMAC_KEY;
    if (internalHmacKey && internalHmacKey.trim().length > 0) {
      app.use(createInternalRoutes({ hmacKey: internalHmacKey, logger }));
      internalHmacKeyForLateMount = internalHmacKey;
      logger.info("Internal HMAC-auth'd clone-repo route registered (cloud mode)");
    } else {
      logger.warn(
        "ORCHESTRA_INTERNAL_HMAC_KEY not set — internal routes (clone-repo) disabled. " +
          "The auth service will not be able to trigger repo clones on this daemon.",
      );
    }
  }

  // Cloud-mode swaps the bcrypt-Bearer middleware for workspace-token (JWT)
  // validation. The JWKS URL must be present at boot — fail loud rather than
  // fall through to the on-host bcrypt path, which would silently accept any
  // request with no daemon password configured. (F11: one mode discriminator;
  // F7: no silent fallback.)
  let workspaceAuthCallback: WorkspaceAuthCallback | null = null;
  if (isPaseoCloudMode()) {
    const jwksUrl = process.env.ORCHESTRA_AUTH_JWKS_URL;
    if (!jwksUrl || jwksUrl.trim().length === 0) {
      throw new Error(
        "PASEO_CLOUD_MODE=1 requires ORCHESTRA_AUTH_JWKS_URL to be set " +
          "(workspace-token validation cannot start without the auth service's JWKS).",
      );
    }
    const expectedWorkspaceId = process.env.PASEO_WORKSPACE_ID?.trim();
    const expectedAccountId = process.env.PASEO_ACCOUNT_ID?.trim();
    if (!expectedWorkspaceId) {
      throw new Error(
        "PASEO_CLOUD_MODE=1 requires PASEO_WORKSPACE_ID to be set " +
          "(daemon must know its own workspace to reject cross-tenant tokens).",
      );
    }
    if (!expectedAccountId) {
      throw new Error(
        "PASEO_CLOUD_MODE=1 requires PASEO_ACCOUNT_ID to be set " +
          "(daemon must know its own account to reject cross-tenant tokens).",
      );
    }
    const jwksAuthCallback = createJwksWorkspaceAuthCallback({
      jwksUrl,
      logger,
      expectedWorkspaceId,
      expectedAccountId,
    });
    workspaceAuthCallback = jwksAuthCallback;
    logger.info({ jwksUrl }, "Cloud-mode workspace-token auth enabled");
    // Fire-and-forget JWKS pre-warm: triggers the outbound JWKS fetch now so
    // the first user-driven WS upgrade doesn't pay JWKS cold-start latency
    // (which previously caused a one-time WS probe timeout on fresh daemon
    // tasks). Failures are logged but non-fatal — a transient auth-service
    // outage at boot must not kill the daemon container.
    void jwksAuthCallback.prewarm();
    logger.info("JWKS pre-warm scheduled");
    // Daemon-version beacon: fire-and-forget POST to the auth service with
    // the CLI + SDK + image-tag triple this container is running. Operators
    // query the auth service record (versions#daemon) when triaging which
    // daemon is on the wire. Failure to deliver is logged but non-fatal —
    // a transient auth-service outage at boot must not kill the daemon.
    fireDaemonVersionBeacon({ logger });
    app.use(
      createRequireWorkspaceMiddleware(workspaceAuthCallback, {
        onReject: (context) => {
          logger.warn(context, "Rejected HTTP request with invalid workspace token");
        },
        // T-10: /mcp/agents must reject a cross-tenant workspace JWT, so it is
        // NOT bypassed by the workspace gate. The daemon's own agents reach it
        // over loopback with the capability token (no JWT) — admit those here;
        // the route handler re-authorizes via isAgentMcpRequestAuthorized. A
        // cross-tenant attacker lacks the capability token and still hits the
        // JWT path (→ 401 on workspace_id mismatch).
        isCapabilityAuthorized: (req) =>
          req.path === "/mcp/agents" &&
          bearerMatchesCapabilityToken(req.header("authorization"), agentMcpAuthToken),
      }),
    );
  } else {
    app.use(
      createRequireBearerMiddleware(config.auth, (context) => {
        logger.warn(context, "Rejected HTTP request with invalid daemon password");
      }),
    );
  }

  // BYO-runtimes L0 — opt-in (ORCHESTRA_EXPOSE_GITHUB_TOKEN=1, default off)
  // exposure of the account GitHub token to workspace subprocesses (agent /
  // terminals / worktree.setup) so toolchain managers like mise/asdf avoid
  // GitHub's 60/hr unauthenticated rate limit. Self-guards on cloud mode +
  // flag + account id; never throws.
  await maybeExposeGithubTokenToEnv({ logger });

  // Git channel of the GitHub token-refresh lifecycle (extracted to keep
  // createPaseoDaemon under the oxlint complexity ceiling). Returns the loopback
  // credential-route nonce when the helper was materialized, else undefined.
  const gitCredentialNonce = await maybeMaterializeGitCredentialHelper(listenTarget, logger);
  // NOTE: upstream's standalone createRequireBearerMiddleware mount is the
  // `else` arm of the isPaseoCloudMode() branch above (self-host bearer auth),
  // so it is not re-emitted here. Upstream's /api/terminal-activity route was
  // hoisted above the auth middleware (see top of this block).

  // Middleware. The self-host webhook receiver (D-3.5d, /hooks/*) needs the
  // RAW request bytes to verify its per-trigger HMAC signature, so the
  // global JSON parser must NOT consume those bodies — the receiver mounts
  // its own raw-text parser scoped to /hooks. This /hooks-aware parser
  // REPLACES upstream's plain `app.use(express.json())` (which would otherwise
  // consume /hooks bodies before this skip-parser runs).
  app.use((req, res, next) => {
    if (req.path.startsWith("/hooks/")) {
      next();
      return;
    }
    express.json()(req, res, next);
  });

  // Serve static files from public directory
  app.use("/public", express.static(staticDir));

  // Health check endpoint
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/status", (_req, res) => {
    res.json({
      status: "server_info",
      serverId,
      hostname: getHostname(),
      version: daemonVersion,
      listen: formatListenTarget(boundListenTarget ?? listenTarget),
    });
  });

  const handleFileDownload = async (req: express.Request, res: express.Response): Promise<void> => {
    const token =
      typeof req.query.token === "string" && req.query.token.trim().length > 0
        ? req.query.token.trim()
        : null;

    if (!token) {
      res.status(400).json({ error: "Missing download token" });
      return;
    }

    const entry = downloadTokenStore.consumeToken(token);
    if (!entry) {
      res.status(403).json({ error: "Invalid or expired token" });
      return;
    }

    let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fileHandle = await open(entry.absolutePath, DOWNLOAD_OPEN_FLAGS);
      const fileStats = await fileHandle.stat();
      if (!fileStats.isFile()) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      const safeFileName = entry.fileName.replace(/["\r\n]/g, "_");
      res.setHeader("Content-Type", entry.mimeType);
      res.setHeader("Content-Disposition", `attachment; filename="${safeFileName}"`);
      res.setHeader("Content-Length", fileStats.size.toString());

      const stream = fileHandle.createReadStream();
      fileHandle = null;
      stream.on("error", (err) => {
        logger.error({ err }, "Failed to stream download");
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to read file" });
        } else {
          res.end();
        }
      });
      stream.pipe(res);
    } catch (err) {
      logger.error({ err }, "Failed to download file");
      if (!res.headersSent) {
        res.status(404).json({ error: "File not found" });
      }
    } finally {
      await fileHandle?.close().catch(() => undefined);
    }
  };

  app.get("/api/files/download", (req, res) => {
    void handleFileDownload(req, res);
  });

  const httpServer = createHTTPServer(app);

  // Script proxy WebSocket upgrade handler — must be registered before the
  // VoiceAssistantWebSocketServer attaches its own "upgrade" listener so that
  // script-bound upgrades are forwarded first. The handler is a no-op for
  // requests that don't match a registered script route.
  httpServer.on("upgrade", serviceProxy.upgradeHandler({ passthroughUnknown: true }));

  if (config.serviceProxy?.standaloneListen) {
    serviceProxyListenTarget = parseListenString(config.serviceProxy.standaloneListen);
  }

  workspaceRegistry = buildWorkspaceRegistry(config.paseoHome, logger);
  const workspaceContainerRegistry = buildWorkspaceContainerRegistry(config.paseoHome, logger);
  // D-3.10 — cloud-mode daemon persistence. Each of the original four
  // Day-1 surfaces (chat, permission, loop, schedule) picks DynamoStore
  // in cloud mode and FileBacked* on-host. See `buildD3DaemonStores`
  // for the construction and the schema doc at
  // paseo-cloud-daemon/30-state/dynamo-store-schema.md.
  //
  // D-3.10 follow-up 2: in cloud mode the bootstrap hard-fails if
  // either (a) `buildD3DaemonStores` throws (SDK/credential failure)
  // or (b) the post-construction self-probe rejects with
  // AccessDeniedException / transport error. Helper logs the FATAL
  // line at the source then re-throws; daemon-worker's main() catch
  // calls exitAfterPinoFlush() → process.exit(1). On-host mode skips
  // both gates entirely.
  //
  // D-3.12 (UAT follow-ups #3 + #4) — buildD3DaemonStores now also
  // owns construction of agent + project stores. On-host: AgentStorage
  // + FileBackedProjectRegistry (file-backed). Cloud: DynamoAgentStore
  // + DynamoProjectStore (`<ws>#agent#metadata` + `<ws>#project`
  // partitions). The previous file-backed wiring at this site lost
  // agent metadata + project lists on every ECS task replacement.
  const d3Stores = await buildAndProbeD3DaemonStores({
    paseoHome: config.paseoHome,
    agentStoragePath: config.agentStoragePath,
    logger,
  });
  // Cloud-vs-file-backed stores come from buildAndProbeD3DaemonStores above
  // (Dynamo* in cloud, FileBacked* on-host). terminalManager is already
  // constructed earlier (with getTerminalActivityUrl) — do not re-declare it.
  const agentStorage = d3Stores.agent;
  const projectRegistry = d3Stores.project;
  const chatService = new ChatService({ store: d3Stores.chat, logger });
  const github = createGitHubService();
  const workspaceGitService = new WorkspaceGitServiceImpl({
    logger,
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    deps: {
      github,
    },
  });
  const providerSnapshotLogger = logger.child({ module: "provider-snapshot-manager" });
  const providerSnapshotManager = new ProviderSnapshotManager({
    logger: providerSnapshotLogger,
    runtimeSettings: config.agentProviderSettings,
    providerOverrides: config.providerOverrides,
    workspaceGitService,
    managedProcesses,
    isDev: config.isDev === true,
    extraClients: config.agentClients,
  });
  // D-3.5c — the ONE shared scoped-env resolver (DECISION P-2). Built once
  // here and injected into BOTH the agent injection site (AgentManager →
  // buildLaunchContext) and the terminal injection site (Session →
  // TerminalSessionController), so resolution is byte-identical for the
  // same cwd. Open-core: no cloud branch — only the store backing it
  // (file vs Dynamo) differs, swapped at construction in buildD3DaemonStores.
  const resolveScopedEnv = createScopedEnvResolver({
    envStore: d3Stores.envVar,
    resolveProjectForCwd: createProjectForCwdResolver({
      projectRegistry,
      getCheckout: (cwd) => workspaceGitService.getCheckout(cwd),
    }),
    ambientContainerId: () => resolveAmbientContainerId(),
    // Env channel of the GitHub token-refresh lifecycle — a FRESH
    // GITHUB_TOKEN/GH_TOKEN per spawn (self-gated to cloud + exposure flag;
    // {} otherwise; never throws). The git channel is handled separately by the
    // credential helper + clean clones.
    githubTokenDefaults: buildGithubTokenEnvDefaults(logger),
    logger,
  });
  // T-4 (D-3) — durable permission queue. On-host gets
  // FileBackedPermissionStore for parity (new directory under
  // $PASEO_HOME/permissions/). Cloud-mode (D-3.10) gets
  // DynamoPermissionStore routing writes to the `<ws>#permission`
  // partition; survives container restart and works across instance
  // replacement. (Pre-D-3.10 the bootstrap unconditionally wired
  // FileBackedPermissionStore — see paseo-cloud-daemon LEARNINGS
  // 2026-05-29 for the gap and D-3.10 fix.) Constructed by
  // `buildD3DaemonStores` above.
  const permissionStore = d3Stores.permission;
  const initialAgentManagerState = providerSnapshotManager.getAgentManagerProviderState();
  const agentManager = new AgentManager({
    clients: initialAgentManagerState.clients,
    providerDefinitions: initialAgentManagerState.providerDefinitions,
    registry: agentStorage,
    // Cloud-mode AgentManager wiring (turn-end fan-out hook, durable permission
    // + timeline stores, shared scoped-env resolver) merged with upstream's
    // new options (appendSystemPrompt, workspace-state callback, MCP auth token).
    onAgentTurnEnd: buildCloudTurnEndHook(logger),
    permissionStore,
    durableTimelineStore: d3Stores.agentTimeline,
    resolveScopedEnv,
    appendSystemPrompt: config.appendSystemPrompt,
    onWorkspaceStateMayHaveChanged: ({ cwd }) => {
      workspaceGitService.onWorkspaceStateMayHaveChanged(cwd);
    },
    mcpAuthToken: agentMcpAuthToken,
    logger,
  });

  const detachAgentStoragePersistence = attachAgentStoragePersistence(
    logger,
    agentManager,
    agentStorage,
  );
  // Cloud mode: persist each provider transcript to S3 after every settled turn
  // so conversations survive a daemon restart. attachProviderTranscriptCapture
  // no-ops in local mode, so this is byte-for-byte unchanged off-cloud.
  const detachProviderTranscriptCapture = attachProviderTranscriptCapture(logger, agentManager);
  // Cloud mode: snapshot the workspace git working-tree delta to S3 (turn-settle
  // + periodic + shutdown flush) so uncommitted work survives a recycle —
  // /workspace is tmpfs. Gated on isWorkspaceSnapshotEnabled() (cloud + deploy
  // flag), so this no-ops off-cloud.
  const detachWorkspaceSnapshotCapture = attachWorkspaceSnapshotCapture(logger, agentManager);
  await agentStorage.initialize();
  logger.info({ elapsed: elapsed() }, "Agent storage initialized");
  const cloudMigration = resolveCloudMigrationContext();
  await bootstrapWorkspaceRegistries({
    paseoHome: config.paseoHome,
    agentStorage,
    projectRegistry,
    workspaceRegistry,
    workspaceContainerRegistry,
    workspaceGitService,
    logger,
    containerWorkspaceId: cloudMigration.containerWorkspaceId,
    migrationRepoUrlSeed: cloudMigration.migrationRepoUrlSeed,
  });
  logger.info({ elapsed: elapsed() }, "Workspace registries bootstrapped");
  const workspaceReconciliation = new WorkspaceReconciliationService({
    projectRegistry,
    workspaceRegistry,
    logger,
    workspaceGitService,
  });
  void (async () => {
    try {
      const result = await workspaceReconciliation.runOnce();
      logger.info(
        {
          elapsed: elapsed(),
          changeCount: result.changesApplied.length,
        },
        "Workspace registries reconciled",
      );
    } catch (error) {
      logger.error({ err: error }, "Background workspace reconciliation failed");
    }
  })();
  await chatService.initialize();
  logger.info({ elapsed: elapsed() }, "Chat service initialized");
  const checkoutDiffManager = new CheckoutDiffManager({
    logger,
    paseoHome: config.paseoHome,
    workspaceGitService,
  });
  // D-3.10 — cloud-mode loops persist to DDB under <ws>#loop. Meta
  // row carries the full LoopRecord; per-step rows mirror logs[] in
  // the cloud-shared canonical shape. See
  // paseo-cloud-daemon/30-state/dynamo-store-schema.md § Loop.
  const loopService = new LoopService({
    store: d3Stores.loop,
    logger,
    agentManager,
    providerSnapshotManager,
  });
  await loopService.initialize();
  logger.info({ elapsed: elapsed() }, "Loop service initialized");
  // D-3.10 — cloud-mode schedules persist to DDB under <ws>#schedule
  // (meta + per-run rows) and notify lifecycle-worker on create/delete
  // so EventBridge Scheduler picks up the cadence. Sub-minute every
  // cadences are rejected at the daemon edge (D-3 synthesis OQ1).
  // See paseo-cloud-daemon/30-state/dynamo-store-schema.md § Schedule.
  const scheduleService = new ScheduleService({
    store: d3Stores.schedule,
    logger,
    agentManager,
    agentStorage,
    providerSnapshotManager,
  });
  await scheduleService.start();
  agentManager.setAgentArchivedCallback(async (agentId) => {
    try {
      await scheduleService.deleteForAgent(agentId);
    } catch (error) {
      logger.warn({ err: error, agentId }, "Failed to delete schedules for archived agent");
    }
  });
  logger.info({ elapsed: elapsed() }, "Schedule service initialized");

  // D-3.5d — webhook triggers. Construction + self-host receiver mount are
  // extracted to a helper to keep createPaseoDaemon under the complexity
  // ceiling. The provisioner is the ONLY cloud/self-host discriminator.
  const triggerService = buildTriggerService(app, {
    paseoHome: config.paseoHome,
    logger,
    agentManager,
    agentStorage,
    store: d3Stores.trigger,
  });
  logger.info({ elapsed: elapsed() }, "Trigger service initialized");

  // T-15 / T-16 (D-3) + D-3.5d webhook-fire: mount the schedule-fire +
  // webhook-fire + file-download-internal routes now that the services are
  // constructed. Extracted helper keeps createPaseoDaemon under the
  // per-function complexity ceiling.
  mountLateInternalRoutes(
    app,
    logger,
    internalHmacKeyForLateMount,
    scheduleService,
    triggerService,
    gitCredentialNonce,
  );
  logger.info({ elapsed: elapsed() }, "Loading persisted agent registry");
  const persistedRecords = await agentStorage.list();
  // T-5 (D-3) — container-boot rehydration. Cloud-mode rehydrates
  // the in-memory state of services from durable stores BEFORE the
  // wsServer accepts connections. On-host: ChatService /
  // LoopService / ScheduleService load lazily on first list/inspect
  // call; permission queue rehydrates from FileBacked store. On-host
  // call is effectively a no-op for empty state.
  await runCloudBootRehydration({ agentManager, chatService, loopService, logger });
  logger.info(
    { elapsed: elapsed() },
    `Agent registry loaded (${persistedRecords.length} record${persistedRecords.length === 1 ? "" : "s"}); agents will initialize on demand`,
  );
  logger.info(
    "Voice mode configured for agent-scoped resume flow (no dedicated voice assistant provider)",
  );
  logger.info({ elapsed: elapsed() }, "Preparing voice and MCP runtime");

  const archiveWorkspaceRecordExternal = async (workspaceId: string) => {
    const sessions = wsServer?.listActiveSessions() ?? [];
    if (sessions.length > 0) {
      await Promise.all(
        sessions.map((session) => session.archiveWorkspaceRecordForExternalMutation(workspaceId)),
      );
      return;
    }

    await archivePersistedWorkspaceRecord({
      workspaceId,
      workspaceRegistry,
    });
  };
  // external path→workspace adapter, not ownership: archive-by-path requests that
  // arrive with a worktree path and no workspaceId (old clients / CLI).
  const findWorkspaceIdForCwdExternal = async (cwd: string): Promise<string | null> => {
    return resolveWorkspaceIdForPath(cwd, await workspaceRegistry.list());
  };
  const ensureWorkspaceForCreateExternal = async (cwd: string): Promise<string> => {
    const workspace = await createLocalCheckoutWorkspace(
      { cwd },
      { projectRegistry, workspaceRegistry, workspaceGitService },
    );
    return workspace.workspaceId;
  };
  const listActiveWorkspacesExternal = async (): Promise<ActiveWorkspaceRef[]> => {
    const workspaces = await workspaceRegistry.list();
    return workspaces
      .filter((workspace) => !workspace.archivedAt)
      .map((workspace) => ({
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        kind: workspace.kind,
      }));
  };
  const markWorkspaceArchivingExternal = (workspaceIds: Iterable<string>, archivingAt: string) => {
    const workspaceIdList = Array.from(workspaceIds);
    for (const session of wsServer?.listActiveSessions() ?? []) {
      session.markWorkspaceArchivingForExternalMutation(workspaceIdList, archivingAt);
    }
  };
  const clearWorkspaceArchivingExternal = (workspaceIds: Iterable<string>) => {
    const workspaceIdList = Array.from(workspaceIds);
    for (const session of wsServer?.listActiveSessions() ?? []) {
      session.clearWorkspaceArchivingForExternalMutation(workspaceIdList);
    }
  };
  const emitWorkspaceUpdatesExternal = async (workspaceIds: Iterable<string>) => {
    const workspaceIdList = Array.from(workspaceIds);
    await Promise.all(
      (wsServer?.listActiveSessions() ?? []).map((session) =>
        session.emitWorkspaceUpdatesForExternalWorkspaceIds(workspaceIdList),
      ),
    );
  };
  const emitExternalSessionMessage = (message: SessionOutboundMessage) => {
    wsServer?.broadcast(wrapSessionMessage(message));
  };

  // Shared Paseo-worktree workflow deps — used by the agent MCP `create_worktree`
  // tool AND by the automation (schedule/trigger) dedicated-worktree creator, so
  // the worktree-creation path is assembled once. Lazy closures over `wsServer`
  // (assigned later) match the external adapters above. The return-type
  // annotation gives the literal contextual typing (callback params inferred).
  const buildPaseoWorktreeWorkflowDeps = (): CreatePaseoWorktreeWorkflowDependencies => ({
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    createPaseoWorktree: async (workflowInput, workflowOptions) => {
      return createRegisteredPaseoWorktree(workflowInput, {
        github,
        ...(workflowOptions?.resolveDefaultBranch
          ? { resolveDefaultBranch: workflowOptions.resolveDefaultBranch }
          : {}),
        projectRegistry,
        workspaceRegistry,
        workspaceGitService,
      });
    },
    warmWorkspaceGitData: async (workspace) => {
      await Promise.all(
        wsServer
          ?.listActiveSessions()
          .map((session) => session.warmWorkspaceGitDataForWorkspace(workspace)) ?? [],
      );
    },
    emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
      await emitWorkspaceUpdatesExternal([workspaceId]);
    },
    cacheWorkspaceSetupSnapshot: () => {},
    emit: emitExternalSessionMessage,
    sessionLogger: logger,
    terminalManager,
    archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
    serviceProxy,
    scriptRuntimeStore,
    getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
    getDaemonTcpHost: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
    serviceProxyPublicBaseUrl,
    onScriptsChanged: null,
  });

  // Per-run worktree retention: archive the oldest sibling worktrees (those
  // sharing the routine's per-run branch prefix) beyond `keep`. Keeps the
  // active list / registry from growing without bound when a routine uses
  // "fresh-worktree-per-run". (Dir removal for self-host is a follow-up; cloud
  // worktree dirs are tmpfs and reclaimed on recycle.)
  const prunePerRunWorktrees = async (branchPrefix: string, keep: number): Promise<void> => {
    const siblings = (await workspaceRegistry.list())
      .filter(
        (w) => !w.archivedAt && w.kind === "worktree" && (w.branch ?? "").startsWith(branchPrefix),
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const excess = siblings.slice(0, Math.max(0, siblings.length - keep));
    for (const workspace of excess) {
      try {
        await archiveWorkspaceRecordExternal(workspace.workspaceId);
      } catch (error) {
        logger.warn(
          { err: error, workspaceId: workspace.workspaceId },
          "Failed to prune old per-run routine worktree",
        );
      }
    }
    if (excess.length > 0) {
      logger.info({ pruned: excess.length, keep }, "Pruned old per-run routine worktrees");
    }
  };

  // Dedicated-worktree creator injected into the schedule + trigger services.
  // Idempotent by the deterministic per-routine branch: "dedicated-worktree"
  // reuses the existing record (stable branch); "fresh-worktree-per-run" always
  // creates (unique per-run branch) then prunes. After a cloud recycle the
  // in-memory registry + tmpfs worktree are gone, so it self-heals by recreating.
  const createDedicatedWorktree = async (input: {
    sourceCwd: string;
    slug: string;
    branchName: string;
    retention?: { siblingBranchPrefix: string; keep: number };
  }): Promise<{ cwd: string; workspaceId: string; created: boolean }> => {
    const existing = (await workspaceRegistry.list()).find(
      (w) => !w.archivedAt && w.kind === "worktree" && w.branch === input.branchName,
    );
    if (existing) {
      return { cwd: existing.cwd, workspaceId: existing.workspaceId, created: false };
    }
    const result = await createPaseoWorktreeWorkflow(buildPaseoWorktreeWorkflowDeps(), {
      cwd: input.sourceCwd,
      worktreeSlug: input.slug,
      branchName: input.branchName,
    });
    if (input.retention) {
      await prunePerRunWorktrees(input.retention.siblingBranchPrefix, input.retention.keep);
    }
    return {
      cwd: result.workspace.cwd,
      workspaceId: result.workspace.workspaceId,
      created: result.created,
    };
  };

  // Auto-unarchive adapter injected into the schedule + trigger services. Resolves
  // the spawn's target workspace (by id when known, else by cwd — prefer worktree
  // then most-recently-updated) and, if archived, clears archivedAt + emits a
  // workspace_update upsert. Returns the resolved workspaceId for agent
  // attribution even when no unarchive was needed (the common reuse case); null
  // when nothing matches (caller then spawns cwd-only).
  const unarchiveAutomationWorkspace = async (input: {
    workspaceId?: string;
    cwd: string;
  }): Promise<{ workspaceId: string } | null> => {
    const workspaces = await workspaceRegistry.list();
    let target = input.workspaceId
      ? workspaces.find((w) => w.workspaceId === input.workspaceId)
      : undefined;
    if (!target) {
      const targetCwd = path.resolve(input.cwd);
      target = workspaces
        .filter((w) => path.resolve(w.cwd) === targetCwd)
        .sort((a, b) => {
          if (a.kind === "worktree" && b.kind !== "worktree") return -1;
          if (b.kind === "worktree" && a.kind !== "worktree") return 1;
          return a.updatedAt < b.updatedAt ? 1 : -1;
        })[0];
    }
    if (!target) {
      return null;
    }
    if (target.archivedAt) {
      const restored = await unarchivePersistedWorkspaceRecord({
        workspaceId: target.workspaceId,
        workspaceRegistry,
      });
      if (restored) {
        await emitWorkspaceUpdatesExternal([target.workspaceId]);
      }
    }
    return { workspaceId: target.workspaceId };
  };

  // Re-clone a routine's source repo when a recycle wiped its tmpfs clone, before
  // a worktree is branched off it. Reuses the exact repair the interactive open /
  // create-worktree handlers run (cloud-workspace-repair.ts). Idempotent no-op
  // on-host / when the repo is already present.
  const repairMissingWorkspaceRepo = (cwd: string): Promise<void> =>
    ensureCloudWorkspaceRepoCloned({ cwd, projectRegistry, logger });

  // Late setter-injection (services are constructed above, before these adapters
  // exist; the adapters close over the later-assigned wsServer). A daemon that
  // skips this still fires reuse-mode routines; non-"reuse" modes then error.
  scheduleService.setDedicatedWorktreeCreator(createDedicatedWorktree);
  scheduleService.setWorkspaceUnarchiver(unarchiveAutomationWorkspace);
  scheduleService.setWorkspaceRepoRepairer(repairMissingWorkspaceRepo);
  triggerService.setDedicatedWorktreeCreator(createDedicatedWorktree);
  triggerService.setWorkspaceUnarchiver(unarchiveAutomationWorkspace);
  triggerService.setWorkspaceRepoRepairer(repairMissingWorkspaceRepo);

  setupAutoArchiveOnMerge({
    paseoHome: config.paseoHome,
    paseoWorktreesBaseRoot: config.worktreesRoot,
    daemonConfigStore,
    workspaceGitService,
    github,
    agentManager,
    agentStorage,
    terminalManager,
    logger,
    findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
    listActiveWorkspaces: listActiveWorkspacesExternal,
    archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
    markWorkspaceArchiving: markWorkspaceArchivingExternal,
    clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
    emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
  });

  const mcpEnabled = config.mcpEnabled ?? true;
  let agentMcpBaseUrl: string | null = null;
  if (mcpEnabled) {
    const agentMcpRoute = "/mcp/agents";

    const createAgentMcpSession = async (callerAgentId?: string) => {
      const agentMcpServer = await createAgentMcpServer({
        agentManager,
        agentStorage,
        terminalManager,
        getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
        scheduleService,
        providerSnapshotManager,
        github,
        workspaceGitService,
        findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
        listActiveWorkspaces: listActiveWorkspacesExternal,
        archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
        emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
        markWorkspaceArchiving: markWorkspaceArchivingExternal,
        clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
        ensureWorkspaceForCreate: ensureWorkspaceForCreateExternal,
        createPaseoWorktree: async (input, serviceOptions) => {
          return createPaseoWorktreeWorkflow(
            buildPaseoWorktreeWorkflowDeps(),
            input,
            serviceOptions,
          );
        },
        paseoHome: config.paseoHome,
        worktreesRoot: config.worktreesRoot,
        callerAgentId,
        enableVoiceTools: false,
        resolveSpeakHandler: (agentId) => wsServer?.resolveVoiceSpeakHandler(agentId) ?? null,
        resolveCallerContext: (agentId) => wsServer?.resolveVoiceCallerContext(agentId) ?? null,
        logger,
      });

      // Stateless mode: each HTTP request builds a fresh server + transport that is
      // torn down when the response closes, so no per-session state is retained between
      // requests. The agent control plane only lists and calls tools, neither of which
      // needs cross-request state, so sessions would only pin memory for the life of the
      // daemon (agents that exit without a clean DELETE never get reaped).
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // NOTE: We enforce a Vite-like host allowlist at the app/websocket layer.
        // StreamableHTTPServerTransport's built-in check requires exact Host header matches.
        enableDnsRebindingProtection: false,
      });
      Object.assign(transport, {
        onerror: (err: Error) => {
          logger.error({ err }, "Agent MCP transport error");
        },
      });

      await agentMcpServer.connect(transport);
      return { server: agentMcpServer, transport };
    };

    const runAgentMcpRequest = async (
      req: express.Request,
      res: express.Response,
    ): Promise<void> => {
      // This route is exempt from the global daemon-password middleware, so it
      // authenticates here using the injected capability token (or a valid
      // daemon password). Without this, a password-protected daemon would be
      // wide open on its agent control plane.
      if (
        !(await isAgentMcpRequestAuthorized({
          password: config.auth?.password,
          capabilityToken: agentMcpAuthToken,
          authorizationHeader: req.header("authorization"),
        }))
      ) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      // The daemon's own agents reach this route over loopback with the
      // capability token (no workspace JWT). The cloud workspace middleware
      // admits those (isCapabilityAuthorized) without setting req.workspaceAuth,
      // so the workspace-binding check below must not demand a JWT for them.
      const authedViaCapabilityToken = bearerMatchesCapabilityToken(
        req.header("authorization"),
        agentMcpAuthToken,
      );
      if (config.mcpDebug) {
        logger.debug(
          {
            method: req.method,
            url: req.originalUrl,
            sessionId: req.header("mcp-session-id"),
            authorization: req.header("authorization") ? REDACTED_LOG_VALUE : undefined,
            body: summarizeAgentMcpDebugBody(req.body),
          },
          "Agent MCP request",
        );
      }
      // Defense-in-depth: in cloud mode the require-workspace middleware (mounted
      // above) rejects a cross-tenant workspace JWT before it reaches here and
      // attaches the validated claim. A non-capability caller must therefore
      // carry a workspace JWT whose workspace_id is the daemon's bound tenant.
      // F3: we never look at a workspaceId on the wire — only the JWT-derived
      // claim attached by the middleware.
      if (isPaseoCloudMode() && !authedViaCapabilityToken && !req.workspaceAuth?.workspaceId) {
        res.status(401).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "workspace token required",
          },
          id: null,
        });
        return;
      }
      try {
        // Stateless: GET (standalone SSE) and DELETE (session termination) have no
        // meaning without sessions. The MCP client tolerates 405 on the GET stream
        // and never issues a DELETE because it is never handed a session id.
        if (req.method !== "POST") {
          res.status(405).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Method not allowed",
            },
            id: null,
          });
          return;
        }
        const callerAgentIdRaw = req.query.callerAgentId;
        let callerAgentId: string | undefined;
        if (typeof callerAgentIdRaw === "string") {
          callerAgentId = callerAgentIdRaw;
        } else if (Array.isArray(callerAgentIdRaw) && typeof callerAgentIdRaw[0] === "string") {
          callerAgentId = callerAgentIdRaw[0];
        }
        const { server, transport } = await createAgentMcpSession(callerAgentId);
        res.on("close", () => {
          void transport.close();
          void server.close();
        });

        await transport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          req.body,
        );
      } catch (err) {
        logger.error({ err }, "Failed to handle Agent MCP request");
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal MCP server error",
            },
            id: null,
          });
        }
      }
    };

    const handleAgentMcpRequest: express.RequestHandler = (req, res) => {
      void runAgentMcpRequest(req, res);
    };

    app.post(agentMcpRoute, handleAgentMcpRequest);
    app.get(agentMcpRoute, handleAgentMcpRequest);
    app.delete(agentMcpRoute, handleAgentMcpRequest);
    logger.info({ route: agentMcpRoute }, "Agent MCP server mounted on main app");
  } else {
    logger.info("Agent MCP HTTP endpoint disabled");
  }

  const speechService = createSpeechService({
    logger,
    openaiConfig: config.openai,
    speechConfig: config.speech,
  });
  logger.info({ elapsed: elapsed() }, "Speech service created");

  logger.info({ elapsed: elapsed() }, "Bootstrap complete, ready to start listening");

  const start = async () => {
    // NOTE (merge): HEAD's pre-upstream start() body was discarded in favor of
    // upstream's try/catch + service-proxy-standalone structure below. The
    // cloud-specific bits HEAD carried are re-applied onto upstream's body:
    //   - the 5 cloud wsServer params (workspaceAuthCallback,
    //     workspaceContainerRegistry, resolveScopedEnv, d3Stores.envVar,
    //     triggerService) appended AFTER serviceProxyPublicBaseUrl, and
    //   - the cloud heartbeat block inside logAndResolve.
    let mainStarted = false;
    try {
      if (serviceProxyListenTarget) {
        const boundServiceProxyTarget = await serviceProxy.startStandalone({
          listenTarget: serviceProxyListenTarget,
        });
        serviceProxyListenTarget = boundServiceProxyTarget;
        logger.info(
          {
            listen: formatListenTarget(serviceProxyListenTarget),
            publicBaseUrl: serviceProxyPublicBaseUrl,
            elapsed: elapsed(),
          },
          "Service proxy listening",
        );
      }

      // Start main HTTP server
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          httpServer.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          httpServer.off("error", onError);
          mainStarted = true;
          const logAndResolve = async () => {
            boundListenTarget = resolveBoundListenTarget(listenTarget, httpServer);
            const mcpBaseUrl = mcpEnabled ? createAgentMcpBaseUrl(boundListenTarget) : null;
            agentMcpBaseUrl = config.mcpInjectIntoAgents === false ? null : mcpBaseUrl;
            agentManager.setMcpBaseUrl(agentMcpBaseUrl);
            daemonConfigStore.onFieldChange("mcp.injectIntoAgents", (value) => {
              agentManager.setMcpBaseUrl(value ? mcpBaseUrl : null);
            });
            daemonConfigStore.onFieldChange("appendSystemPrompt", (value) => {
              agentManager.setAppendSystemPrompt(typeof value === "string" ? value : "");
            });
            const relayEnabled = config.relayEnabled ?? true;
            const relayEndpoint = config.relayEndpoint ?? "relay.paseo.sh:443";
            const relayPublicEndpoint = config.relayPublicEndpoint ?? relayEndpoint;
            const relayUseTls = config.relayUseTls ?? relayEndpoint === "relay.paseo.sh:443";
            const relayPublicUseTls = config.relayPublicUseTls ?? relayUseTls;
            const appBaseUrl = config.appBaseUrl ?? "https://app.paseo.sh";

            if (boundListenTarget.type === "tcp") {
              logger.info(
                {
                  host: boundListenTarget.host,
                  port: boundListenTarget.port,
                  authRequired: !!config.auth?.password,
                  elapsed: elapsed(),
                },
                `Server listening on http://${boundListenTarget.host}:${boundListenTarget.port}`,
              );
            } else {
              logger.info(
                {
                  path: boundListenTarget.path,
                  authRequired: !!config.auth?.password,
                  elapsed: elapsed(),
                },
                `Server listening on ${boundListenTarget.path}`,
              );
            }
            if (config.auth?.password) {
              logger.info("Daemon password authentication enabled");
            }

            wsServer = new VoiceAssistantWebSocketServer(
              httpServer,
              logger,
              serverId,
              agentManager,
              agentStorage,
              downloadTokenStore,
              config.paseoHome,
              daemonConfigStore,
              mcpBaseUrl,
              { allowedOrigins, hostnames: configuredHostnames },
              config.auth,
              speechService,
              terminalManager,
              {
                finalTimeoutMs: config.dictationFinalTimeoutMs,
              },
              daemonVersion,
              (intent) => {
                try {
                  config.onLifecycleIntent?.(intent);
                } catch (error) {
                  logger.error({ err: error, intent }, "Failed to handle daemon lifecycle intent");
                }
              },
              projectRegistry,
              workspaceRegistry,
              chatService,
              loopService,
              scheduleService,
              checkoutDiffManager,
              serviceProxy,
              scriptRuntimeStore,
              handleBranchChange,
              () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
              () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
              (hostname) => scriptHealthMonitor.getHealthForHostname(hostname),
              workspaceGitService,
              github,
              config.pushNotificationSender,
              providerSnapshotManager,
              {
                listen: formatListenTarget(boundListenTarget ?? listenTarget),
                worktreesRoot: config.worktreesRoot,
                appBaseUrl: config.appBaseUrl,
                relay: {
                  enabled: relayEnabled,
                  endpoint: relayEndpoint,
                  publicEndpoint: relayPublicEndpoint,
                  useTls: relayUseTls,
                  publicUseTls: relayPublicUseTls,
                },
              },
              serviceProxyPublicBaseUrl,
              // Cloud-mode positional params, appended AFTER upstream's three
              // (providerSnapshotManager, daemonRuntimeConfig,
              // serviceProxyPublicBaseUrl) to match VoiceAssistantWebSocketServer's
              // constructor (see websocket-server.ts).
              workspaceAuthCallback,
              workspaceContainerRegistry,
              resolveScopedEnv,
              d3Stores.envVar,
              triggerService,
            );

            if (relayEnabled) {
              const offer = await createConnectionOfferV2({
                serverId,
                daemonPublicKeyB64: daemonKeyPair.publicKeyB64,
                relay: {
                  endpoint: relayPublicEndpoint,
                  useTls: relayPublicUseTls,
                },
              });

              encodeOfferToFragmentUrl({ offer, appBaseUrl });

              relayTransport?.stop().catch(() => undefined);
              relayTransport = startRelayTransport({
                logger,
                attachSocket: (ws, metadata) => {
                  if (!wsServer) {
                    throw new Error("WebSocket server not initialized");
                  }
                  return wsServer.attachExternalSocket(ws, metadata);
                },
                relayEndpoint,
                relayUseTls,
                serverId,
                daemonKeyPair: daemonKeyPair.keyPair,
              });
            }

            // Cloud-mode workspace heartbeat (T-4). Started after wsServer is
            // constructed so the session registry can observe live state.
            if (wsServer) {
              heartbeatController = maybeStartCloudHeartbeat({
                wsServer,
                agentManager,
                loopService,
                scheduleService,
                logger,
              });
            }
          };

          logAndResolve().then(resolve, reject);
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);

        if (listenTarget.type === "tcp") {
          httpServer.listen(listenTarget.port, listenTarget.host);
        } else {
          if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
            unlinkSync(listenTarget.path);
          }
          httpServer.listen(listenTarget.path);
        }
      });

      // Start speech service after listening so synchronous Sherpa native
      // model loading doesn't block the server from accepting connections.
      speechService.start();
      scriptHealthMonitor.start();
    } catch (error) {
      await serviceProxy.stopStandalone().catch(() => undefined);
      if (mainStarted) {
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
      throw error;
    }
  };

  const stop = async () => {
    scriptHealthMonitor.stop();
    // Halt the heartbeat loop BEFORE closing agents/sessions — the loop
    // observes session-registry state, and closing first would log
    // misleading "0 active" heartbeats on the way out.
    heartbeatController?.stop();
    heartbeatController = null;
    await closeAllAgents(logger, agentManager);
    await agentManager.flush().catch(() => undefined);
    detachAgentStoragePersistence();
    detachProviderTranscriptCapture();
    // Final best-effort workspace snapshot (agents are now closed, so the tree
    // is quiescent) before stop continues teardown. Awaited so a graceful
    // shutdown flushes the latest delta; a SIGKILL past stopTimeout still only
    // loses since-the-last-periodic-snapshot.
    await detachWorkspaceSnapshotCapture();
    await agentStorage.flush().catch(() => undefined);
    await providerSnapshotManager.shutdown();
    terminalManager.killAll();
    speechService.stop();
    await scheduleService.stop().catch(() => undefined);
    await relayTransport?.stop().catch(() => undefined);
    if (wsServer) {
      await wsServer.close();
    }
    await serviceProxy.stopStandalone();
    // Force-drop remaining sockets so httpServer.close() resolves promptly.
    // We've already closed wsServer (which sent ws-layer close frames) and
    // stopped every other service, so anything still attached is a TCP
    // socket whose higher-level shutdown hasn't fully released it (e.g.
    // upgraded WS sockets in the closing handshake, or HTTP keep-alive
    // sockets in CLOSE_WAIT). closeIdleConnections() does not catch
    // upgraded sockets, so we use closeAllConnections() here.
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    // Clean up socket files
    if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
      unlinkSync(listenTarget.path);
    }
  };

  return {
    config,
    agentManager,
    agentStorage,
    terminalManager,
    serviceProxy,
    scriptRuntimeStore,
    start,
    stop,
    getListenTarget: () => boundListenTarget,
  };
}

async function closeAllAgents(logger: Logger, agentManager: AgentManager): Promise<void> {
  const agents = agentManager.listAgents();
  await Promise.all(
    agents.map(async (agent) => {
      try {
        await agentManager.closeAgent(agent.id);
      } catch (err) {
        logger.error({ err, agentId: agent.id }, "Failed to close agent");
      }
    }),
  );
}

// On-host mode skips this entirely — heartbeat is cloud-mode-only. Returns
// null when cloud-mode is off, when required env vars are missing, or when
// the wsServer is not ready (the caller already gates on the last).
//
// PLAN-cdk-infra sets PASEO_WORKSPACE_ID in the per-workspace ECS task
// definition; without it the daemon does not know which workspace's
// heartbeat to write, so we warn-and-skip rather than write a wrong row.
/**
 * T-5 (D-3) — container-boot rehydration. Runs after services are
 * constructed and before `wsServer.start()` accepts connections.
 *
 * What rehydrates:
 *   - `agentManager.rehydratePendingPermissions()` — reads the
 *     durable PermissionStore (FileBacked or Dynamo) and re-populates
 *     each agent's `pendingPermissions: Map`.
 *   - `chatService.initialize()` + `loopService.initialize()` — these
 *     already exist on-host and lazy-load the store; calling them at
 *     boot warms the cache.
 *
 * Bounded time: if the rehydration takes >10s, log warn and continue
 * (the heartbeat lateness is preferable to never starting). Today's
 * stores are bounded by per-workspace data size so this should be a
 * sub-second operation in practice.
 *
 * Schedule service rehydration is implicit — `scheduleService.start()`
 * (already called above) recovers interrupted runs.
 */
async function runCloudBootRehydration(deps: {
  agentManager: AgentManager;
  chatService: ChatService;
  loopService: LoopService;
  logger: Logger;
}): Promise<void> {
  const started = Date.now();
  try {
    await deps.agentManager.rehydratePendingPermissions();
  } catch (err) {
    deps.logger.warn({ err }, "rehydratePendingPermissions failed (continuing)");
  }
  // chatService + loopService already initialize lazily — call them
  // here so the first WS RPC doesn't pay the I/O latency. Both are
  // idempotent (already-initialized = no-op).
  try {
    await deps.chatService.initialize();
  } catch (err) {
    deps.logger.warn({ err }, "chatService.initialize at boot failed (continuing)");
  }
  try {
    await deps.loopService.initialize();
  } catch (err) {
    deps.logger.warn({ err }, "loopService.initialize at boot failed (continuing)");
  }
  const elapsedMs = Date.now() - started;
  if (elapsedMs > 10_000) {
    deps.logger.warn({ elapsedMs }, "Boot rehydration took >10s");
  } else {
    deps.logger.info({ elapsedMs }, "Boot rehydration completed");
  }
}

// D-3.5d — build the TriggerService and (self-host only) mount its public
// /hooks receiver. The provisioner is the ONLY cloud/self-host
// discriminator: an injected internal URL → cloud register hook; its
// absence → local secret generation + the self-host receiver. No
// `if (cloud)` branch (mirrors the schedule store's lifecycle-URL seam).
function buildTriggerService(
  app: express.Express,
  deps: {
    paseoHome: string;
    logger: Logger;
    agentManager: AgentManager;
    agentStorage: AgentStore;
    store: WebhookTriggerStore;
  },
): TriggerService {
  const { logger } = deps;
  // Registration is auth-owned (VERIFY-3.5d #4): the provisioner HMAC-POSTs
  // the `/api/auth-internal/*` register/rotate/deregister routes, so it
  // needs the auth-internal URL. Fall back to the lifecycle URL only if
  // auth's is unset (it is the one set on the cloud daemon today).
  const cloudInternalUrl =
    process.env.ORCHESTRA_AUTH_INTERNAL_URL?.trim() ||
    process.env.ORCHESTRA_LIFECYCLE_INTERNAL_URL?.trim();
  const internalHmacKey = process.env.ORCHESTRA_INTERNAL_HMAC_KEY?.trim();
  const workspaceId = isPaseoCloudMode() ? process.env.PASEO_WORKSPACE_ID?.trim() : undefined;
  const accountId = isPaseoCloudMode() ? process.env.PASEO_ACCOUNT_ID?.trim() : undefined;
  const useCloudProvisioner = Boolean(
    cloudInternalUrl && internalHmacKey && workspaceId && accountId,
  );
  const secretStore = useCloudProvisioner
    ? null
    : new FileBackedTriggerSecretStore(path.join(deps.paseoHome, "triggers", "secrets"));
  const provisioner: TriggerProvisioner =
    cloudInternalUrl && internalHmacKey && workspaceId && accountId
      ? new CloudTriggerProvisioner({
          internalUrl: cloudInternalUrl,
          hmacKey: internalHmacKey,
          workspaceId,
          accountId,
          logger,
        })
      : new SelfHostTriggerProvisioner(
          process.env.PASEO_WEBHOOK_BASE_URL?.trim() || "http://localhost:6767",
          // secretStore is non-null on this branch by construction.
          secretStore as FileBackedTriggerSecretStore,
        );
  const triggerService = new TriggerService({
    store: deps.store,
    provisioner,
    logger,
    agentManager: deps.agentManager,
    agentStorage: deps.agentStorage,
  });
  // Self-host: mount the public /hooks/:webhookId receiver. Bypasses the
  // daemon-password gate (auth.ts shouldBypassBearerAuth) and the global
  // JSON parser; authenticates each request by its per-trigger signature.
  if (secretStore) {
    app.use(createSelfHostWebhookReceiver({ triggerService, secretStore, logger }));
    logger.info("Self-host webhook receiver mounted at /hooks/:webhookId");
  }
  return triggerService;
}

// Git channel of the GitHub token-refresh lifecycle. When token exposure is
// enabled in cloud mode, materialize a git credential helper so raw git uses a
// FRESH token per operation (clean clones + the nonce-gated loopback
// /api/internal/git-credential route) instead of a boot-frozen one. The nonce
// authorizes only token retrieval — never the internal HMAC key. Never blocks
// boot: returns undefined on any miss/failure, leaving the flag unset so
// cloneWorkspaceRepo falls back to embedding the token in the clone URL (today's
// behavior).
async function maybeMaterializeGitCredentialHelper(
  listenTarget: ListenTarget,
  logger: Logger,
): Promise<string | undefined> {
  if (
    !isPaseoCloudMode() ||
    process.env.ORCHESTRA_EXPOSE_GITHUB_TOKEN?.trim() !== "1" ||
    listenTarget.type !== "tcp"
  ) {
    return undefined;
  }
  const nonce = randomBytes(32).toString("hex");
  const materialized = await materializeGitCredentialHelper({
    dir: "/workspace/.paseo",
    nonce,
    port: listenTarget.port,
    logger,
  });
  if (!materialized) return undefined;
  process.env.GIT_CONFIG_GLOBAL = materialized.gitConfigPath;
  process.env.ORCHESTRA_GIT_CREDENTIAL_HELPER = "1";
  logger.info("Git credential helper enabled — clean clones + per-op token refresh");
  return nonce;
}

function mountLateInternalRoutes(
  app: express.Express,
  logger: Logger,
  internalHmacKeyForLateMount: string | null,
  scheduleService: ScheduleService,
  triggerService: TriggerService,
  gitCredentialNonce?: string,
): void {
  if (!internalHmacKeyForLateMount) return;
  const workspaceIdForLateRoutes = process.env.PASEO_WORKSPACE_ID?.trim();
  app.use(
    createInternalRoutes({
      hmacKey: internalHmacKeyForLateMount,
      logger,
      scheduleService,
      scheduleStore: scheduleService.getStore(),
      triggerService,
      triggerStore: triggerService.getStore(),
      ...(workspaceIdForLateRoutes ? { expectedWorkspaceId: workspaceIdForLateRoutes } : {}),
      ...(workspaceIdForLateRoutes
        ? { workspaceRoot: `/workspace/${workspaceIdForLateRoutes}` }
        : {}),
      ...(process.env.ORCHESTRA_AUTH_INTERNAL_URL
        ? { authInternalUrl: process.env.ORCHESTRA_AUTH_INTERNAL_URL }
        : {}),
      // Git credential helper loopback route — registered only when the helper
      // was materialized at boot (nonce present). The route's default token
      // getter is the module GithubTokenProvider singleton.
      ...(gitCredentialNonce ? { credentialNonce: gitCredentialNonce } : {}),
    }),
  );
  logger.info(
    "Internal HMAC-auth'd schedule-fire + file-download-internal routes registered (cloud mode)",
  );
}

// D-3.12 follow-up — cloud mode uses InMemoryWorkspaceRegistry.
// The workspace registry is a derived cache rebuilt from agent
// storage on every boot (bootstrapWorkspaceRegistries). Unlike
// chat/permission/loop/schedule/agent/project, it holds no state
// that isn't reconstructible from the (now DDB-backed) agent store.
// existsOnDisk() → false ensures reconstruction runs on every
// container start; read-your-writes holds within the session.
function buildWorkspaceRegistry(paseoHome: string, logger: Logger): WorkspaceRegistry {
  if (isPaseoCloudMode()) {
    return new InMemoryWorkspaceRegistry();
  }
  return new FileBackedWorkspaceRegistry(
    path.join(paseoHome, "projects", "workspaces.json"),
    logger,
  );
}

// D-3.5a — registry of top-level Workspace containers. Cloud: in-memory
// (the single ambient PASEO_WORKSPACE_ID container, derived each boot).
// On-host: a JSON file alongside projects.json / workspaces.json.
function buildWorkspaceContainerRegistry(
  paseoHome: string,
  logger: Logger,
): WorkspaceContainerRegistry {
  if (isPaseoCloudMode()) {
    return new InMemoryWorkspaceContainerRegistry();
  }
  return new FileBackedWorkspaceContainerRegistry(
    path.join(paseoHome, "projects", "containers.json"),
    logger,
  );
}

// D-3.5a (T-7 migration) — cloud attaches reconstructed projects to the
// ambient PASEO_WORKSPACE_ID container and seeds the migrated first project's
// repoUrl from `<ws>#metadata` (injected by the cloud env as
// PASEO_WORKSPACE_REPO_URL). On-host: no container override, no migration
// seed. OQ-5: this env-var seed is the daemon-side contract; the cloud stream
// may instead forward-fill a `<ws>#project` row — both converge on the same
// end state (F9: one writer is the rebuild here).
function resolveCloudMigrationContext(): {
  containerWorkspaceId: string | undefined;
  migrationRepoUrlSeed: string | null;
} {
  if (!isPaseoCloudMode()) {
    return { containerWorkspaceId: undefined, migrationRepoUrlSeed: null };
  }
  return {
    containerWorkspaceId: process.env.PASEO_WORKSPACE_ID?.trim() || undefined,
    migrationRepoUrlSeed: process.env.PASEO_WORKSPACE_REPO_URL?.trim() || null,
  };
}

// D-3.10 — cloud-mode-aware factory for the four Day-1 daemon stores
// (chat, permission, loop, schedule). Extracted from createPaseoDaemon
// to keep the top-level under the per-function complexity ceiling and
// to make the cloud-mode vs on-host swap testable in isolation.
//
// F3 design-out: workspaceId is sourced from PASEO_WORKSPACE_ID at
// boot — validated for cloud mode upstream. Callers never pass it;
// cross-tenant writes are impossible by construction.
//
// Construction-failure posture (D-3.10 follow-up 2): in cloud mode the
// factory throws if `buildCloudModeDynamoLike()` fails. The previous
// warn-and-fall-back posture made a critical failure mode invisible:
// a missing AWS credential / SDK config issue silently routed writes
// to container-ephemeral FileBacked storage, which next restart would
// discard. The bootstrap caller catches the throw, logs FATAL, and
// process-exits — matching the existing daemon-worker bootstrap-error
// path. On-host mode never enters the cloud branch so its FileBacked*
// construction is unchanged.
export interface D3DaemonStores {
  chat: ChatStore;
  permission: PermissionStore;
  loop: LoopStore;
  schedule: ScheduleStore;
  /**
   * D-3.5d webhook-trigger store. On-host: `FileBackedWebhookTriggerStore`
   * (`$PASEO_HOME/triggers/<id>.json`); cloud: `DynamoWebhookTriggerStore`
   * (`<ws>#trigger` partition). Both satisfy `WebhookTriggerStore`.
   */
  trigger: WebhookTriggerStore;
  /**
   * Durable AgentTimelineStore for cloud mode (`<ws>#agent#timeline`
   * partition). `undefined` on-host — AgentManager falls back to the
   * in-memory store. The cloud value is consumed at AgentManager
   * construction via `durableTimelineStore`; append/fetch/replay are
   * already plumbed by the manager.
   */
  agentTimeline: AgentTimelineStore | undefined;
  /**
   * D-3.12 (UAT follow-ups #3 + #4) — per-agent record store. On-host
   * this is `AgentStorage` (file-backed under `$PASEO_HOME/agents/...`);
   * cloud mode swaps in `DynamoAgentStore` (partition `<ws>#agent#metadata`).
   * Both satisfy the `AgentStore` interface so consumer code (AgentManager,
   * Session, etc.) is unchanged.
   */
  agent: AgentStore;
  /**
   * D-3.12 (UAT follow-ups #3 + #4) — workspace project list store.
   * On-host this is `FileBackedProjectRegistry` (single JSON file);
   * cloud mode swaps in `DynamoProjectStore` (partition `<ws>#project`).
   * Both satisfy the `ProjectRegistry` interface.
   */
  project: ProjectRegistry;
  /**
   * D-3.5c — scoped env-var store. On-host this is `FileBackedEnvVarStore`
   * (`$PASEO_HOME/projects/env-vars.json`); cloud mode swaps in
   * `DynamoEnvVarStore` (partition `<ws>#envvar`). Both satisfy the
   * `EnvVarStore` interface; the shared resolver reads from it at both
   * injection sites (agent + terminal).
   */
  envVar: EnvVarStore;
  /**
   * The DynamoLike client backing the four stores in cloud mode.
   * `null` in on-host mode (no DDB construction). The caller uses
   * this to issue the boot-time self-probe (`selfProbeDdb`).
   */
  dynamoLike: DynamoLike | null;
}

export async function buildD3DaemonStores(deps: {
  paseoHome: string;
  agentStoragePath: string;
  logger: Logger;
}): Promise<D3DaemonStores> {
  const { paseoHome, agentStoragePath, logger } = deps;
  const cloudWorkspaceId = isPaseoCloudMode() ? process.env.PASEO_WORKSPACE_ID?.trim() : undefined;
  // On-host mode (or cloud mode with no workspace id, which is an
  // error that surfaces in the upstream auth check) → FileBacked*.
  if (!isPaseoCloudMode() || !cloudWorkspaceId) {
    return {
      chat: new FileBackedChatStore({ paseoHome, logger }),
      permission: new FileBackedPermissionStore({ paseoHome, logger }),
      loop: new FileBackedLoopStore({ paseoHome, logger }),
      schedule: new FileBackedScheduleStore(path.join(paseoHome, "schedules")),
      trigger: new FileBackedWebhookTriggerStore(path.join(paseoHome, "triggers")),
      agentTimeline: undefined,
      agent: new AgentStorage(agentStoragePath, logger),
      project: new FileBackedProjectRegistry(
        path.join(paseoHome, "projects", "projects.json"),
        logger,
      ),
      envVar: new FileBackedEnvVarStore({ paseoHome, logger }),
      dynamoLike: null,
    };
  }
  // Cloud mode: bubble construction failures out. The caller logs
  // FATAL and exits non-zero; we do NOT fall back to FileBacked* in
  // cloud mode because that would silently regress persistence.
  const dynamoLike = await buildCloudModeDynamoLike();
  logger.info(
    { workspaceId: cloudWorkspaceId },
    "Cloud-mode DynamoDB client constructed (Dynamo* stores will route here)",
  );
  const lifecycleInternalUrl = process.env.ORCHESTRA_LIFECYCLE_INTERNAL_URL?.trim();
  const hmacKey = process.env.ORCHESTRA_INTERNAL_HMAC_KEY?.trim();
  return {
    chat: new DynamoChatStore({ client: dynamoLike, workspaceId: cloudWorkspaceId, logger }),
    permission: new DynamoPermissionStore({
      client: dynamoLike,
      workspaceId: cloudWorkspaceId,
      logger,
    }),
    loop: new DynamoLoopStore({ client: dynamoLike, workspaceId: cloudWorkspaceId, logger }),
    schedule: new DynamoScheduleStore({
      client: dynamoLike,
      workspaceId: cloudWorkspaceId,
      logger,
      ...(lifecycleInternalUrl ? { lifecycleInternalUrl } : {}),
      ...(hmacKey ? { hmacKey } : {}),
    }),
    trigger: new DynamoWebhookTriggerStore({
      client: dynamoLike,
      workspaceId: cloudWorkspaceId,
      logger,
    }),
    agentTimeline: new DynamoAgentTimelineStore({
      client: dynamoLike,
      workspaceId: cloudWorkspaceId,
      logger,
    }),
    agent: new DynamoAgentStore({
      client: dynamoLike,
      workspaceId: cloudWorkspaceId,
      logger,
    }),
    project: new DynamoProjectStore({
      client: dynamoLike,
      workspaceId: cloudWorkspaceId,
      logger,
    }),
    envVar: new DynamoEnvVarStore({
      client: dynamoLike,
      workspaceId: cloudWorkspaceId,
      logger,
    }),
    dynamoLike,
  };
}

// D-3.10 / D-3.11 contract — partition prefixes the daemon's per-workspace
// IAM role is allowed to read/write under DynamoDB:LeadingKeys. Mirrors the
// `WorkspaceDynamoDb` LeadingKeys list in `orchestra-cloud-private`'s
// `packages/cloud-shared/src/workspace-role-template.ts`. Control-plane
// prefixes (#metadata, #state, #download-token, #webhook-event, #spend,
// #quota) are intentionally NOT included — they are auth/lifecycle-worker-
// owned, and a compromised daemon must not be able to forge them.
//
// The boot probe MUST use one of these prefixes; anything else will
// AccessDeniedException at runtime against the D-3.11 inline policy. The
// constant lives next to the probe so `bootstrap.boot-probe.test.ts` can
// pin the contract by static reference; if you add a new Dynamo*Store
// surface, add the prefix here AND in the IAM template — together.
export const DAEMON_OWNED_PARTITION_PREFIXES = [
  "chat",
  "permission",
  "loop",
  "schedule",
  "agent#timeline",
  "agent#metadata",
  "project",
  // D-3.5c — scoped env-var store partition (`<ws>#envvar`). The cloud
  // IAM template (workspace-role-template.ts WorkspaceDynamoDb
  // LeadingKeys) must grant `<ws>#envvar` + `<ws>#envvar#*` alongside
  // this; add both together.
  "envvar",
] as const;

export type DaemonOwnedPartitionPrefix = (typeof DAEMON_OWNED_PARTITION_PREFIXES)[number];

// D-3.10 follow-up 2 — synchronous boot-time self-probe for cloud-mode
// DDB connectivity. Issues a single GetItem on a known-covered chat
// partition (`pk=<wsId>#chat, sk=__d3_10_boot_probe__`) and asserts no
// `AccessDeniedException` / transport error. The pk is the first daemon-
// owned prefix in `DAEMON_OWNED_PARTITION_PREFIXES`; the sk is a
// sentinel that never matches a real row, so GetItem returns empty
// (no Item). That return shape proves DDB connectivity + IAM grant +
// table name in one round trip without reading a row the daemon
// doesn't own.
//
// Historical note: an earlier revision of this probe used
// `<wsId>#metadata` (the auth-owned workspace-metadata row). That worked
// pre-D-3.11 when the inline policy had a wildcard `<wsId>#*` grant,
// but D-3.11 narrowed LeadingKeys to daemon-owned partitions only.
// Control-plane rows are intentionally denied to the daemon. The probe
// was rewritten to live inside the daemon's own grant.
//
// Probe semantics:
//   - "no Item returned" → OK (expected — sentinel sk never exists)
//   - AccessDeniedException → throw (IAM grant missing — refusing to
//     start is preferable to writing to a partition the daemon can't
//     read back)
//   - any transport-level error (timeout, DNS, network) → throw
//
// Exported so `bootstrap.boot-probe.test.ts` can exercise the
// AccessDenied path in isolation without spinning up a full daemon.
// Only called in cloud mode; on-host path skips this entirely.
export async function selfProbeDdb(deps: {
  client: DynamoLike;
  table: string;
  workspaceId: string;
  logger: Logger;
}): Promise<void> {
  const { client, table, workspaceId, logger } = deps;
  const partitionPrefix: DaemonOwnedPartitionPrefix = DAEMON_OWNED_PARTITION_PREFIXES[0];
  const key = { pk: `${workspaceId}#${partitionPrefix}`, sk: "__d3_10_boot_probe__" };
  try {
    await client.get(table, key);
    logger.info(
      { workspaceId, table, pk: key.pk, sk: key.sk, partitionPrefix },
      "D-3.10 boot probe ok (daemon-owned partition GetItem succeeded)",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`D-3.10 boot probe failed: ${table} ${message}; refusing to start`, {
      cause: err,
    });
  }
}

// D-3.10 follow-up 2 — bootstrap wrapper that combines store construction
// + cloud-mode self-probe behind one call so `createPaseoDaemon` stays
// under its complexity ceiling. Logs FATAL at the source on either
// failure path and re-throws; daemon-worker.ts's main() catch handles
// the process-exit. On-host mode skips both gates.
async function buildAndProbeD3DaemonStores(deps: {
  paseoHome: string;
  agentStoragePath: string;
  logger: Logger;
}): Promise<D3DaemonStores> {
  const { paseoHome, agentStoragePath, logger } = deps;
  const cloudTable = resolveCloudStateTableName();
  let stores: D3DaemonStores;
  try {
    stores = await buildD3DaemonStores({ paseoHome, agentStoragePath, logger });
  } catch (err) {
    logger.fatal(
      { err, table: cloudTable },
      `D-3.10 boot probe failed: ${cloudTable} ${
        err instanceof Error ? err.message : String(err)
      }; refusing to start`,
    );
    throw err;
  }
  if (!isPaseoCloudMode() || !stores.dynamoLike) {
    return stores;
  }
  const probeWorkspaceId = process.env.PASEO_WORKSPACE_ID?.trim();
  if (!probeWorkspaceId) {
    // Should never happen — the upstream auth-mode check throws if
    // PASEO_WORKSPACE_ID is missing in cloud mode, and the inner
    // factory skips DynamoLike construction without it. Safety net.
    const msg =
      "D-3.10 boot probe failed: PASEO_WORKSPACE_ID empty in cloud mode; refusing to start";
    logger.fatal({ table: cloudTable }, msg);
    throw new Error(msg);
  }
  try {
    await selfProbeDdb({
      client: stores.dynamoLike,
      table: cloudTable,
      workspaceId: probeWorkspaceId,
      logger,
    });
  } catch (err) {
    logger.fatal(
      { err, table: cloudTable, workspaceId: probeWorkspaceId },
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }
  return stores;
}

// T-8 (synthesis A5 / OQ7 / A8) — cloud-mode turn-end hook. Fires
// agent.turn_completed / agent.turn_failed webhooks to
// ORCHESTRA_AUTH_WEBHOOK_SINK_URL. Undefined in on-host mode (AGPL
// self-host operators get no cloud-side fan-out). Extracted to keep
// the top-level createPaseoDaemon under the per-function complexity
// ceiling.
function buildCloudTurnEndHook(logger: Logger) {
  return createCloudTurnEndHook({
    webhookSinkUrl: process.env.ORCHESTRA_AUTH_WEBHOOK_SINK_URL?.trim(),
    hmacKey: process.env.ORCHESTRA_INTERNAL_HMAC_KEY?.trim(),
    authInternalUrl: process.env.ORCHESTRA_AUTH_INTERNAL_URL?.trim(),
    logger,
  });
}

function maybeStartCloudHeartbeat(deps: {
  wsServer: VoiceAssistantWebSocketServer;
  agentManager: AgentManager;
  loopService: LoopService;
  scheduleService: ScheduleService;
  logger: Logger;
}): HeartbeatLoopController | null {
  if (!isPaseoCloudMode()) return null;
  const heartbeatWorkspaceId = process.env.PASEO_WORKSPACE_ID?.trim();
  const heartbeatAuthUrl = process.env.ORCHESTRA_AUTH_INTERNAL_URL?.trim();
  const heartbeatHmacKey = process.env.ORCHESTRA_INTERNAL_HMAC_KEY?.trim();
  if (!heartbeatWorkspaceId || !heartbeatAuthUrl || !heartbeatHmacKey) {
    deps.logger.warn(
      {
        hasWorkspaceId: !!heartbeatWorkspaceId,
        hasAuthUrl: !!heartbeatAuthUrl,
        hasHmacKey: !!heartbeatHmacKey,
      },
      "Heartbeat skipped: missing PASEO_WORKSPACE_ID / ORCHESTRA_AUTH_INTERNAL_URL / ORCHESTRA_INTERNAL_HMAC_KEY",
    );
    return null;
  }
  const { wsServer, agentManager, loopService, scheduleService, logger } = deps;
  // T-17 / synthesis A6: activeAgents spans agents + running loops +
  // pending schedules. Field name is unchanged per the operator's
  // 2026-05-26 decision (lifecycle-worker's R7 invariant depends on
  // the count, not the discriminator name).
  const sessionRegistry: HeartbeatSessionRegistry = {
    countConnectedClients: () => wsServer.listActiveSessions().length,
    countActiveAgents: async () => {
      const runningAgents = agentManager
        .listAgents()
        .filter((a) => a.lifecycle === "running").length;
      const runningLoops = loopService.runningCount();
      const pendingSchedules = await scheduleService.pendingCount();
      return runningAgents + runningLoops + pendingSchedules;
    },
  };
  const controller = startHeartbeatLoop({
    authServiceBaseUrl: heartbeatAuthUrl,
    hmacKey: heartbeatHmacKey,
    workspaceId: heartbeatWorkspaceId,
    daemonImageTag: resolveDaemonImageTag(),
    sessionRegistry,
    logger,
  });
  logger.info({ workspaceId: heartbeatWorkspaceId }, "Heartbeat loop started");
  return controller;
}
