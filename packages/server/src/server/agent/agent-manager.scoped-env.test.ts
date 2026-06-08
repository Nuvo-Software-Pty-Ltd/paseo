import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

// D-3.5c — proves the agent injection site (Site A): buildLaunchContext
// merges the resolved scoped env (workspace + project vars) into the agent
// subprocess env, BENEATH the platform `PASEO_AGENT_ID` overlay (which a
// scoped var can never shadow). The resolver is the SAME one the terminal
// site uses, so an agent and a terminal in the same project see identical
// scoped env.

const TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

class CapturingSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly id = randomUUID();
  private subscribers = new Set<(event: AgentStreamEvent) => void>();

  constructor(private readonly config: AgentSessionConfig) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }
  async startTurn(): Promise<{ turnId: string }> {
    return { turnId: "turn-1" };
  }
  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }
  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}
  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.config.model ?? null,
      modeId: this.config.modeId ?? null,
    };
  }
  async getAvailableModes() {
    return [];
  }
  async getCurrentMode() {
    return null;
  }
  async setMode(): Promise<void> {}
  getPendingPermissions() {
    return [];
  }
  async respondToPermission(): Promise<void> {}
  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
}

class CapturingClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  lastLaunchContext: AgentLaunchContext | undefined;

  async isAvailable(): Promise<boolean> {
    return true;
  }
  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.lastLaunchContext = launchContext;
    return new CapturingSession(config);
  }
  async listModels() {
    return [{ provider: "codex" as const, id: "gpt-5.4", label: "GPT-5.4", isDefault: true }];
  }
  async resumeSession(): Promise<AgentSession> {
    return new CapturingSession({ provider: "codex", cwd: process.cwd() });
  }
}

function buildManager(resolveScopedEnv?: (cwd: string) => Promise<Record<string, string>>) {
  const workdir = mkdtempSync(join(tmpdir(), "agent-scoped-env-"));
  const logger = createTestLogger();
  const client = new CapturingClient();
  const manager = new AgentManager({
    clients: { codex: client },
    registry: new AgentStorage(join(workdir, "agents"), logger),
    logger,
    idFactory: () => "00000000-0000-4000-8000-0000000000aa",
    ...(resolveScopedEnv ? { resolveScopedEnv } : {}),
  });
  return { manager, client, workdir };
}

test("agent launch env includes scoped vars beneath PASEO_AGENT_ID", async () => {
  const { manager, client, workdir } = buildManager(async (cwd) => {
    expect(cwd).toBe(workdir);
    return { WS_VAR: "w", PROJ_VAR: "p" };
  });

  await manager.createAgent({ provider: "codex", cwd: workdir });

  expect(client.lastLaunchContext?.env).toEqual({
    WS_VAR: "w",
    PROJ_VAR: "p",
    PASEO_AGENT_ID: "00000000-0000-4000-8000-0000000000aa",
  });
});

test("a scoped var named PASEO_AGENT_ID cannot shadow the platform value", async () => {
  // The resolver strips reserved keys, but assert defense-in-depth at the
  // overlay too: PASEO_AGENT_ID is applied last and wins regardless.
  const { manager, client, workdir } = buildManager(async () => ({
    PASEO_AGENT_ID: "spoofed",
  }));

  await manager.createAgent({ provider: "codex", cwd: workdir });

  expect(client.lastLaunchContext?.env?.PASEO_AGENT_ID).toBe(
    "00000000-0000-4000-8000-0000000000aa",
  );
});

test("without a resolver, only PASEO_AGENT_ID is set (unchanged legacy behavior)", async () => {
  const { manager, client, workdir } = buildManager();
  await manager.createAgent({ provider: "codex", cwd: workdir });
  expect(client.lastLaunchContext?.env).toEqual({
    PASEO_AGENT_ID: "00000000-0000-4000-8000-0000000000aa",
  });
});
