import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { StoredAgentRecord } from "./agent/agent-storage.js";
import {
  attachClaudeTranscriptCapture,
  buildConfigOverrides,
  buildSessionConfig,
  toAgentPersistenceHandle,
} from "./persistence-hooks.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import type { AgentManager } from "./agent/agent-manager.js";

type StateSubscriber = (event: { type: string; agent: unknown }) => void;

function createFakeManager(): {
  manager: Pick<AgentManager, "subscribe">;
  emit: StateSubscriber;
} {
  let subscriber: StateSubscriber | null = null;
  return {
    manager: {
      subscribe: ((callback: StateSubscriber) => {
        subscriber = callback;
        return () => {
          subscriber = null;
        };
      }) as unknown as AgentManager["subscribe"],
    },
    emit: (event) => subscriber?.(event),
  };
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function claudeStateEvent(id: string, captureTranscriptSnapshot: () => Promise<void>) {
  return {
    type: "agent_state",
    agent: {
      id,
      provider: "claude",
      lifecycle: "idle",
      session: { captureTranscriptSnapshot },
    },
  };
}

function createRecord(overrides?: Partial<StoredAgentRecord>): StoredAgentRecord {
  const now = new Date().toISOString();
  return {
    id: "agent-record",
    provider: "claude",
    cwd: "/tmp/project",
    createdAt: now,
    updatedAt: now,
    title: null,
    lastStatus: "idle",
    lastModeId: "plan",
    config: { modeId: "plan", model: "claude-3.5-sonnet" },
    persistence: {
      provider: "claude",
      sessionId: "session-123",
    },
    ...overrides,
  };
}

describe("attachClaudeTranscriptCapture", () => {
  let originalCloudMode: string | undefined;
  beforeEach(() => {
    originalCloudMode = process.env.PASEO_CLOUD_MODE;
    process.env.PASEO_CLOUD_MODE = "1";
  });
  afterEach(() => {
    if (originalCloudMode === undefined) delete process.env.PASEO_CLOUD_MODE;
    else process.env.PASEO_CLOUD_MODE = originalCloudMode;
  });

  test("does not subscribe in local mode", () => {
    delete process.env.PASEO_CLOUD_MODE;
    const { manager, emit } = createFakeManager();
    const capture = vi.fn(async () => undefined);
    attachClaudeTranscriptCapture(createTestLogger(), manager);
    emit(claudeStateEvent("agent-1", capture));
    expect(capture).not.toHaveBeenCalled();
  });

  test("debounces a burst of agent_state events into a single snapshot", async () => {
    const { manager, emit } = createFakeManager();
    const gate = createDeferred();
    const capture = vi.fn(() => gate.promise);
    attachClaudeTranscriptCapture(createTestLogger(), manager);

    // Two rapid turn-complete events while the first snapshot is still running.
    emit(claudeStateEvent("agent-1", capture));
    emit(claudeStateEvent("agent-1", capture));

    expect(capture).toHaveBeenCalledTimes(1);

    // Once the in-flight snapshot settles, a later event snapshots again.
    gate.resolve();
    await gate.promise;
    await Promise.resolve();
    emit(claudeStateEvent("agent-1", capture));
    expect(capture).toHaveBeenCalledTimes(2);
  });

  test("ignores closed agents and non-claude providers", async () => {
    const { manager, emit } = createFakeManager();
    const capture = vi.fn(async () => undefined);
    attachClaudeTranscriptCapture(createTestLogger(), manager);

    emit({
      type: "agent_state",
      agent: { id: "a", provider: "claude", lifecycle: "closed", session: null },
    });
    emit({
      type: "agent_state",
      agent: {
        id: "b",
        provider: "codex",
        lifecycle: "idle",
        session: { captureTranscriptSnapshot: capture },
      },
    });

    expect(capture).not.toHaveBeenCalled();
  });
});

describe("persistence hooks", () => {
  test("buildConfigOverrides carries systemPrompt and mcpServers", () => {
    const record = createRecord({
      title: "Voice agent (current)",
      config: {
        modeId: "default",
        model: "gpt-5.4-mini",
        thinkingOptionId: "minimal",
        systemPrompt: "Use speak first.",
        mcpServers: {
          paseo: {
            type: "stdio",
            command: "node",
            args: ["/tmp/bridge.mjs", "--socket", "/tmp/agent.sock"],
          },
        },
      },
    });

    expect(buildConfigOverrides(record)).toMatchObject({
      cwd: "/tmp/project",
      modeId: "plan",
      model: "gpt-5.4-mini",
      thinkingOptionId: "minimal",
      systemPrompt: "Use speak first.",
      mcpServers: {
        paseo: {
          type: "stdio",
          command: "node",
          args: ["/tmp/bridge.mjs", "--socket", "/tmp/agent.sock"],
        },
      },
    });
  });

  test("buildSessionConfig includes persisted systemPrompt and mcpServers", () => {
    const record = createRecord({
      provider: "codex",
      title: "Renamed title",
      config: {
        modeId: "default",
        model: "gpt-5.4-mini",
        systemPrompt: "Confirm and speak first.",
        mcpServers: {
          paseo: {
            type: "stdio",
            command: "node",
            args: ["/tmp/bridge.mjs", "--socket", "/tmp/agent.sock"],
          },
        },
      },
    });

    expect(buildSessionConfig(record)).toMatchObject({
      provider: "codex",
      cwd: "/tmp/project",
      modeId: "plan",
      model: "gpt-5.4-mini",
      systemPrompt: "Confirm and speak first.",
      mcpServers: {
        paseo: {
          type: "stdio",
          command: "node",
          args: ["/tmp/bridge.mjs", "--socket", "/tmp/agent.sock"],
        },
      },
    });
  });

  test("buildConfigOverrides drops persisted internal paseo MCP server", () => {
    const record = createRecord({
      config: {
        modeId: "default",
        model: "gpt-5.4-mini",
        mcpServers: {
          paseo: {
            type: "http",
            url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=stale-agent",
          },
          custom: {
            type: "stdio",
            command: "custom-mcp",
          },
        },
      },
    });

    expect(buildConfigOverrides(record).mcpServers).toEqual({
      custom: {
        type: "stdio",
        command: "custom-mcp",
      },
    });
  });

  test("buildConfigOverrides preserves user-provided paseo MCP server", () => {
    const record = createRecord({
      config: {
        modeId: "default",
        model: "gpt-5.4-mini",
        mcpServers: {
          paseo: {
            type: "http",
            url: "https://example.com/custom-paseo",
          },
        },
      },
    });

    expect(buildConfigOverrides(record).mcpServers).toEqual({
      paseo: {
        type: "http",
        url: "https://example.com/custom-paseo",
      },
    });
  });

  test("buildSessionConfig accepts providers from the canonical manifest", () => {
    const record = createRecord({
      provider: "claude",
      persistence: {
        provider: "claude",
        sessionId: "session-123",
      },
      config: {},
    });

    expect(buildSessionConfig(record)).toMatchObject({
      provider: "claude",
      cwd: "/tmp/project",
    });
  });

  test("buildSessionConfig skips records whose provider is missing from the registry", () => {
    const record = createRecord({
      id: "agent-missing-provider",
      provider: "zai",
    });

    expect(
      buildSessionConfig(record, {
        validProviders: ["claude", "codex"],
      }),
    ).toBeNull();
  });

  test("toAgentPersistenceHandle rejects handles for unavailable providers", () => {
    const handle = toAgentPersistenceHandle(["claude", "codex"], {
      provider: "gemini",
      sessionId: "session-123",
    });

    expect(handle).toBeNull();
  });
});
