import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient, STALE_RESUME_FRESH_SESSION_NOTICE } from "./agent.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";
import { SessionTranscriptStore, type S3Like } from "./session-transcript-store.js";
import type { AgentStreamEvent, AgentPersistenceHandle } from "../../agent-sdk-types.js";
import type { MaterializedClaudeHome } from "../../../cloud-credentials.js";

// A fake S3 with no objects: every GET misses, so restore returns false and the
// stale-resume fallback is exercised end to end.
function emptyStore(): SessionTranscriptStore {
  const client: S3Like = {
    async putObject() {},
    async getObjectBytes() {
      throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
    },
    async listObjectKeys() {
      return [];
    },
    async deleteObjects() {},
  };
  return new SessionTranscriptStore({
    client,
    bucket: "test-bucket",
    logger: pino({ level: "silent" }),
  });
}

interface AsyncQueue<T> {
  push: (value: T) => void;
  next: () => Promise<IteratorResult<T, void>>;
  end: () => void;
}

function createAsyncQueue<T>(): AsyncQueue<T> {
  const items: T[] = [];
  const resolvers: Array<(value: IteratorResult<T, void>) => void> = [];
  let ended = false;
  return {
    push(value) {
      if (ended) return;
      const resolve = resolvers.shift();
      if (resolve) {
        resolve({ value, done: false });
        return;
      }
      items.push(value);
    },
    async next() {
      const value = items.shift();
      if (value !== undefined) return { value, done: false };
      if (ended) return { value: undefined, done: true };
      return await new Promise<IteratorResult<T, void>>((resolve) => {
        resolvers.push(resolve);
      });
    },
    end() {
      ended = true;
      while (resolvers.length > 0) {
        resolvers.shift()?.({ value: undefined, done: true });
      }
    },
  };
}

function extractPromptText(message: Record<string, unknown>): string {
  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    })
    .join("");
}

function buildSuccessResult(sessionId: string) {
  return {
    type: "result",
    subtype: "success",
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
    total_cost_usd: 0,
    session_id: sessionId,
  };
}

async function collectUntilTerminal(
  stream: AsyncGenerator<AgentStreamEvent>,
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled"
    ) {
      break;
    }
  }
  return events;
}

interface ScriptedQuery {
  next: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  return: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  supportedModels: ReturnType<typeof vi.fn>;
  supportedCommands: ReturnType<typeof vi.fn>;
  rewindFiles: ReturnType<typeof vi.fn>;
  [Symbol.asyncIterator]: () => AsyncIterator<Record<string, unknown>, void>;
}

// First query (resumed) emits the stale-resume error; the second (fresh) plays
// the prompt through to success.
function createScriptedQuery(params: {
  prompt: AsyncIterable<unknown>;
  initSessionId: string;
  onPrompt: (text: string, emit: (m: Record<string, unknown>) => void) => void;
}): ScriptedQuery {
  const output = createAsyncQueue<Record<string, unknown>>();
  const emit = (m: Record<string, unknown>) => output.push(m);
  const query: ScriptedQuery = {
    next: vi.fn(() => output.next()),
    interrupt: vi.fn(async () => undefined),
    return: vi.fn(async () => output.end()),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  emit({
    type: "system",
    subtype: "init",
    session_id: params.initSessionId,
    permissionMode: "default",
    model: "opus",
  });
  void (async () => {
    for await (const prompt of params.prompt) {
      params.onPrompt(extractPromptText(prompt as Record<string, unknown>), emit);
    }
  })();
  return query;
}

const STALE_SESSION = "stale-session-id";
const FRESH_SESSION = "fresh-session-id";

let originalCloudMode: string | undefined;
let originalWorkspaceId: string | undefined;
let home: string;

beforeEach(() => {
  originalCloudMode = process.env.PASEO_CLOUD_MODE;
  originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;
  process.env.PASEO_CLOUD_MODE = "1";
  process.env.PASEO_WORKSPACE_ID = "ws_test";
  home = mkdtempSync(path.join(tmpdir(), "stale-resume-home-"));
});

afterEach(() => {
  if (originalCloudMode === undefined) delete process.env.PASEO_CLOUD_MODE;
  else process.env.PASEO_CLOUD_MODE = originalCloudMode;
  if (originalWorkspaceId === undefined) delete process.env.PASEO_WORKSPACE_ID;
  else process.env.PASEO_WORKSPACE_ID = originalWorkspaceId;
  if (home) rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

test("cloud mode: stale resume degrades to a fresh session and completes the turn", async () => {
  const cwd = "/workspace/ws_test";
  const capturedResume: Array<string | undefined> = [];
  const queryFactory = vi.fn(
    ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: { resume?: string } }) => {
      capturedResume.push(options.resume);
      const isResumedQuery = options.resume === STALE_SESSION;
      return createScriptedQuery({
        prompt,
        initSessionId: isResumedQuery ? STALE_SESSION : FRESH_SESSION,
        onPrompt: (_text, emit) => {
          if (isResumedQuery) {
            emit({
              type: "result",
              subtype: "error_during_execution",
              errors: [`No conversation found with session ID: ${STALE_SESSION}`],
              session_id: STALE_SESSION,
            });
            return;
          }
          emit({
            type: "assistant",
            message: { content: "FRESH_SESSION_RESPONSE" },
            session_id: FRESH_SESSION,
          });
          emit(buildSuccessResult(FRESH_SESSION));
        },
      });
    },
  );

  const provisionCloudHome = vi.fn(
    async (): Promise<MaterializedClaudeHome> => ({
      spawnId: "spawn",
      homeDir: home,
      configDir: home,
      env: { HOME: home, CLAUDE_CONFIG_DIR: home },
      cleanup: async () => {},
    }),
  );

  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
    sessionTranscriptStore: emptyStore(),
    provisionCloudHome,
  });

  const handle: AgentPersistenceHandle = {
    provider: "claude",
    sessionId: STALE_SESSION,
    metadata: { cwd },
  };
  const session = await client.resumeSession(handle, undefined, {
    env: { PASEO_AGENT_ID: "agent-1" },
  });

  const events = await collectUntilTerminal(streamSession(session, "hello after restart"));

  // The turn ultimately completes (not failed) on the fresh session.
  expect(events.some((e) => e.type === "turn_completed")).toBe(true);
  expect(events.some((e) => e.type === "turn_failed")).toBe(false);

  // The stale session was cleared before the retry: first query resumed the
  // stale id, the replacement query carried no resume.
  expect(capturedResume).toEqual([STALE_SESSION, undefined]);
  expect(session.id).toBe(FRESH_SESSION);

  // Exactly one user-visible notice.
  const notices = events.filter(
    (e) =>
      e.type === "timeline" &&
      e.item.type === "assistant_message" &&
      e.item.text === STALE_RESUME_FRESH_SESSION_NOTICE,
  );
  expect(notices.length).toBe(1);

  // The replayed prompt produced the fresh-session response.
  const assistantText = events
    .flatMap((e) =>
      e.type === "timeline" && e.item.type === "assistant_message" ? [e.item.text] : [],
    )
    .join("\n");
  expect(assistantText).toContain("FRESH_SESSION_RESPONSE");

  await session.close();
});

test("local mode: stale resume still fails the turn (no fresh-session fallback)", async () => {
  delete process.env.PASEO_CLOUD_MODE;
  const cwd = "/workspace/ws_test";

  const queryFactory = vi.fn(({ prompt }: { prompt: AsyncIterable<unknown> }) =>
    createScriptedQuery({
      prompt,
      initSessionId: STALE_SESSION,
      onPrompt: (_text, emit) => {
        emit({
          type: "result",
          subtype: "error_during_execution",
          errors: [`No conversation found with session ID: ${STALE_SESSION}`],
          session_id: STALE_SESSION,
        });
      },
    }),
  );

  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/test/claude/bin",
  });

  const handle: AgentPersistenceHandle = {
    provider: "claude",
    sessionId: STALE_SESSION,
    metadata: { cwd },
  };
  const session = await client.resumeSession(handle, undefined, {
    env: { PASEO_AGENT_ID: "agent-1" },
  });

  const events = await collectUntilTerminal(streamSession(session, "hello after restart"));

  expect(events.some((e) => e.type === "turn_failed")).toBe(true);
  expect(events.some((e) => e.type === "turn_completed")).toBe(false);
  // Only the resumed query is ever created — no fresh-session replay.
  expect(queryFactory).toHaveBeenCalledTimes(1);
  const notices = events.filter(
    (e) =>
      e.type === "timeline" &&
      e.item.type === "assistant_message" &&
      e.item.text === STALE_RESUME_FRESH_SESSION_NOTICE,
  );
  expect(notices.length).toBe(0);

  await session.close();
});
