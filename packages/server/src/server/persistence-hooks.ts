import type { AgentManager } from "./agent/agent-manager.js";
import { stripInternalPaseoMcpServer } from "./agent/runtime-mcp-config.js";
import type {
  AgentPersistenceHandle,
  AgentProvider,
  AgentSessionConfig,
} from "./agent/agent-sdk-types.js";
import type { AgentStorage, StoredAgentRecord } from "./agent/agent-storage.js";
import { isPaseoCloudMode } from "./paseo-env.js";
import type { Logger } from "pino";
import {
  getWorkspaceSnapshotStore,
  isWorkspaceSnapshotEnabled,
} from "./workspace-snapshot-store.js";

interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

function getLogger(logger: LoggerLike): LoggerLike {
  return logger.child({ module: "persistence" });
}

type AgentStoragePersistence = Pick<AgentStorage, "applySnapshot" | "list">;
type AgentManagerStateSource = Pick<AgentManager, "subscribe">;

interface BuildSessionConfigOptions {
  validProviders?: Iterable<AgentProvider>;
}

function isProviderRegistered(
  validProviders: Iterable<AgentProvider> | undefined,
  provider: AgentProvider,
): boolean {
  if (!validProviders) {
    return true;
  }
  if (validProviders instanceof Set) {
    return validProviders.has(provider);
  }
  return new Set(validProviders).has(provider);
}

/**
 * Attach AgentStore persistence to an AgentManager instance so every
 * agent_state snapshot is flushed to disk.
 */
export function attachAgentStoragePersistence(
  logger: LoggerLike,
  agentManager: AgentManagerStateSource,
  storage: AgentStoragePersistence,
): () => void {
  const log = getLogger(logger);
  const unsubscribe = agentManager.subscribe((event) => {
    if (event.type !== "agent_state") {
      return;
    }
    if (event.agent.lifecycle === "closed") {
      return;
    }
    void storage.applySnapshot(event.agent).catch((error) => {
      log.error({ err: error, agentId: event.agent.id }, "Failed to persist agent snapshot");
    });
  });

  return unsubscribe;
}

/**
 * Cloud-mode only (A4): snapshot each Claude agent's transcript to S3 after it
 * settles, so the conversation survives a daemon restart. Subscribes to
 * `agent_state` (which fires very often) and debounces per agent with an
 * in-flight guard so a burst of events collapses to a single snapshot; the
 * store additionally skips the upload when the transcript is unchanged.
 * `captureTranscriptSnapshot` itself gates on `isPaseoCloudMode()`, so this is
 * a no-op in local mode.
 */
export function attachClaudeTranscriptCapture(
  logger: LoggerLike,
  agentManager: AgentManagerStateSource,
): () => void {
  // Cloud-mode only — in local mode there is nothing to snapshot, so skip the
  // subscription entirely (zero per-event overhead, byte-for-byte unchanged).
  if (!isPaseoCloudMode()) {
    return () => {};
  }
  const log = getLogger(logger);
  const inFlight = new Set<string>();
  const unsubscribe = agentManager.subscribe((event) => {
    if (event.type !== "agent_state") {
      return;
    }
    const agent = event.agent;
    if (agent.lifecycle === "closed" || agent.provider !== "claude") {
      return;
    }
    const capture = agent.session.captureTranscriptSnapshot;
    if (typeof capture !== "function") {
      return;
    }
    // Debounce: while a snapshot is in flight for this agent, drop further
    // turn-complete events — the next settled state re-triggers a snapshot.
    if (inFlight.has(agent.id)) {
      return;
    }
    inFlight.add(agent.id);
    void Promise.resolve(capture.call(agent.session))
      .catch((error) => {
        log.error({ err: error, agentId: agent.id }, "Failed to snapshot Claude transcript");
      })
      .finally(() => {
        inFlight.delete(agent.id);
      });
  });

  return unsubscribe;
}

/**
 * Cloud-mode only: snapshot the workspace's git working tree (delta) to S3 so
 * uncommitted work survives a daemon restart (/workspace is tmpfs). Three
 * triggers mirror the transcript capture above: turn-settle (every settled
 * agent_state, deduped by the store's per-workspace in-flight guard +
 * skip-if-unchanged), a periodic backstop (catches edits made outside an agent
 * turn — e.g. a terminal), and a final flush when the returned detach runs (the
 * shutdown path awaits it). The store gates on isWorkspaceSnapshotEnabled(), so
 * this whole hook no-ops unless cloud mode + the deploy flag are set — local
 * mode is byte-for-byte unchanged.
 *
 * Returns an async detach: clears the timer, unsubscribes, and performs one last
 * best-effort snapshot of the most-recently-active repo.
 */
export function attachWorkspaceSnapshotCapture(
  logger: Logger,
  agentManager: AgentManagerStateSource,
  options: { periodicIntervalMs?: number } = {},
): () => Promise<void> {
  const workspaceId = process.env.PASEO_WORKSPACE_ID?.trim();
  if (!isWorkspaceSnapshotEnabled() || !workspaceId) {
    return async () => {};
  }
  const log = logger.child({ module: "workspace-snapshot-capture" });
  const store = getWorkspaceSnapshotStore(logger);
  // Most-recently-active working tree — the periodic + shutdown flush target.
  let lastRepoDir: string | null = null;

  const capture = (repoDir: string): void => {
    lastRepoDir = repoDir;
    // Fire-and-forget: the store serializes per-workspace and skips no-ops, so a
    // burst of agent_state events collapses to at most one upload.
    void store.snapshot({ workspaceId, repoDir }).catch((error) => {
      log.error({ err: error }, "Workspace snapshot failed");
    });
  };

  const unsubscribe = agentManager.subscribe((event) => {
    if (event.type !== "agent_state") return;
    if (event.agent.lifecycle === "closed") return;
    if (event.agent.cwd) capture(event.agent.cwd);
  });

  const timer = setInterval(() => {
    if (lastRepoDir) capture(lastRepoDir);
  }, options.periodicIntervalMs ?? 120_000);
  // Don't keep the event loop alive just for the backstop timer.
  timer.unref();

  return async () => {
    clearInterval(timer);
    unsubscribe();
    if (lastRepoDir) {
      try {
        await store.snapshot({ workspaceId, repoDir: lastRepoDir });
      } catch (error) {
        log.warn({ err: error }, "Final workspace snapshot flush failed");
      }
    }
  };
}

export function buildConfigOverrides(record: StoredAgentRecord): Partial<AgentSessionConfig> {
  return stripInternalPaseoMcpServer({
    provider: record.provider,
    cwd: record.cwd,
    modeId: record.lastModeId ?? record.config?.modeId ?? undefined,
    model: record.config?.model ?? undefined,
    thinkingOptionId: record.config?.thinkingOptionId ?? undefined,
    featureValues: record.config?.featureValues ?? undefined,
    extra: record.config?.extra ?? undefined,
    systemPrompt: record.config?.systemPrompt ?? undefined,
    mcpServers: record.config?.mcpServers ?? undefined,
  });
}

export function buildSessionConfig(
  record: StoredAgentRecord,
  options?: BuildSessionConfigOptions,
): AgentSessionConfig | null {
  if (!isProviderRegistered(options?.validProviders, record.provider)) {
    return null;
  }
  const overrides = buildConfigOverrides(record);
  return stripInternalPaseoMcpServer({
    provider: record.provider,
    cwd: record.cwd,
    modeId: overrides.modeId,
    model: overrides.model,
    thinkingOptionId: overrides.thinkingOptionId,
    featureValues: overrides.featureValues,
    extra: overrides.extra,
    systemPrompt: overrides.systemPrompt,
    mcpServers: overrides.mcpServers,
  });
}

export function isStoredAgentProviderAvailable(
  record: StoredAgentRecord,
  validProviders?: Iterable<AgentProvider>,
): boolean {
  return isProviderRegistered(validProviders, record.provider);
}

export function extractTimestamps(record: StoredAgentRecord): {
  createdAt: Date;
  updatedAt: Date;
  lastUserMessageAt: Date | null;
  labels?: Record<string, string>;
  workspaceId?: string;
} {
  return {
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.lastActivityAt ?? record.updatedAt),
    lastUserMessageAt: record.lastUserMessageAt ? new Date(record.lastUserMessageAt) : null,
    labels: record.labels,
    workspaceId: record.workspaceId,
  };
}

export function toAgentPersistenceHandle(
  registeredProviders: Iterable<AgentProvider>,
  handle: StoredAgentRecord["persistence"],
): AgentPersistenceHandle | null {
  if (!handle) {
    return null;
  }
  const provider = handle.provider;
  if (!isProviderRegistered(registeredProviders, provider)) {
    return null;
  }
  if (!handle.sessionId) {
    return null;
  }
  return {
    provider,
    sessionId: handle.sessionId,
    ...(handle.nativeHandle !== undefined ? { nativeHandle: handle.nativeHandle } : {}),
    ...(handle.metadata !== undefined ? { metadata: handle.metadata } : {}),
  } satisfies AgentPersistenceHandle;
}
