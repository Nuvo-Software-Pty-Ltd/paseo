import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";
import {
  SessionTranscriptStore,
  type S3Like,
  type S3PutObjectInput,
} from "./session-transcript-store.js";
import type {
  AgentSession,
  AgentStreamEvent,
  AgentPersistenceHandle,
} from "../../agent-sdk-types.js";
import type { MaterializedClaudeHome } from "../../../cloud-credentials.js";

// ---------------------------------------------------------------------------
// Shared in-memory S3 fake (one instance survives the simulated restart).
// ---------------------------------------------------------------------------
class NoSuchKeyError extends Error {
  readonly name = "NoSuchKey";
}

interface FakeS3 extends S3Like {
  puts: S3PutObjectInput[];
  gets: string[];
  lists: number;
  deletes: number;
  objects: Map<string, Uint8Array>;
}

function createFakeS3(): FakeS3 {
  const objects = new Map<string, Uint8Array>();
  const puts: S3PutObjectInput[] = [];
  const gets: string[] = [];
  return {
    puts,
    gets,
    lists: 0,
    deletes: 0,
    objects,
    async putObject(input) {
      puts.push(input);
      objects.set(
        input.Key,
        typeof input.Body === "string" ? new TextEncoder().encode(input.Body) : input.Body,
      );
    },
    async getObjectBytes(input) {
      gets.push(input.Key);
      const body = objects.get(input.Key);
      if (!body) throw new NoSuchKeyError(input.Key);
      return body;
    },
    async listObjectKeys(input) {
      this.lists += 1;
      return [...objects.keys()].filter((key) => key.startsWith(input.Prefix));
    },
    async deleteObjects(input) {
      this.deletes += 1;
      for (const key of input.Keys) objects.delete(key);
    },
  };
}

function storeFor(fake: S3Like): SessionTranscriptStore {
  return new SessionTranscriptStore({
    client: fake,
    bucket: "test-bucket",
    logger: pino({ level: "silent" }),
  });
}

// ---------------------------------------------------------------------------
// Scripted query: init -> (on prompt) assistant + success.
// ---------------------------------------------------------------------------
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
      while (resolvers.length > 0) resolvers.shift()?.({ value: undefined, done: true });
    },
  };
}

function createScriptedQuery(prompt: AsyncIterable<unknown>, sessionId: string) {
  const output = createAsyncQueue<Record<string, unknown>>();
  const emit = (m: Record<string, unknown>) => output.push(m);
  const query = {
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
    session_id: sessionId,
    permissionMode: "default",
    model: "opus",
  });
  void (async () => {
    for await (const _prompt of prompt) {
      emit({ type: "assistant", message: { content: "RESPONSE" }, session_id: sessionId });
      emit({
        type: "result",
        subtype: "success",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
        total_cost_usd: 0,
        session_id: sessionId,
      });
    }
  })();
  return query;
}

async function drainTurn(stream: AsyncGenerator<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
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

function fakeHome(configDir: string): MaterializedClaudeHome {
  return {
    spawnId: "spawn",
    homeDir: configDir,
    configDir,
    env: { HOME: configDir, CLAUDE_CONFIG_DIR: configDir },
    cleanup: async () => {},
  };
}

function sanitize(cwd: string): string {
  return cwd.replace(/[\\/._:]/g, "-");
}

function transcriptPathIn(configDir: string, cwd: string, sessionId: string): string {
  return path.join(configDir, "projects", sanitize(cwd), `${sessionId}.jsonl`);
}

const CWD = "/workspace/ws_test";
const SESSION_ID = "sess-restart-A";
const AGENT_ID = "agent-1";
const TRANSCRIPT_BODY = '{"type":"user","uuid":"u1"}\n{"type":"assistant","uuid":"a1"}\n';

let originalCloudMode: string | undefined;
let originalWorkspaceId: string | undefined;
const tmpDirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  originalCloudMode = process.env.PASEO_CLOUD_MODE;
  originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;
  process.env.PASEO_WORKSPACE_ID = "ws_test";
});

afterEach(() => {
  if (originalCloudMode === undefined) delete process.env.PASEO_CLOUD_MODE;
  else process.env.PASEO_CLOUD_MODE = originalCloudMode;
  if (originalWorkspaceId === undefined) delete process.env.PASEO_WORKSPACE_ID;
  else process.env.PASEO_WORKSPACE_ID = originalWorkspaceId;
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeClient(params: {
  store: SessionTranscriptStore;
  home: MaterializedClaudeHome;
  capturedResume?: Array<string | undefined>;
}): ClaudeAgentClient {
  return new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: ({
      prompt,
      options,
    }: {
      prompt: AsyncIterable<unknown>;
      options: { resume?: string };
    }) => {
      params.capturedResume?.push(options.resume);
      // Resume targets the same id; a fresh start would emit a new id. Either
      // way the scripted query reports the resumed/created session id.
      return createScriptedQuery(prompt, options.resume ?? SESSION_ID);
    },
    resolveBinary: async () => "/test/claude/bin",
    sessionTranscriptStore: params.store,
    provisionCloudHome: async () => params.home,
  });
}

function launch(env: Record<string, string>) {
  return { env };
}

test("A7: a Claude session survives a simulated daemon restart (snapshot -> fresh home -> restore -> resume)", async () => {
  process.env.PASEO_CLOUD_MODE = "1";
  const fake = createFakeS3();
  const store = storeFor(fake);

  // --- Daemon instance #1: run a turn, then snapshot the transcript. ---------
  const home1 = fakeHome(tmp("claude-home-1-"));
  const client1 = makeClient({ store, home: home1 });
  const session1 = await client1.createSession(
    { provider: "claude", cwd: CWD },
    launch({ PASEO_AGENT_ID: AGENT_ID }),
  );
  const events1 = await drainTurn(streamSession(session1, "first prompt"));
  expect(events1.some((e) => e.type === "turn_completed")).toBe(true);
  expect(session1.id).toBe(SESSION_ID);

  // The CLI subprocess would have written the transcript into the per-spawn
  // home; emulate that here so the capture has a file to upload.
  const writtenPath = transcriptPathIn(home1.configDir, CWD, SESSION_ID);
  mkdirSync(path.dirname(writtenPath), { recursive: true });
  writeFileSync(writtenPath, TRANSCRIPT_BODY);

  // Fire the capture hook -> the object lands in S3.
  await session1.captureTranscriptSnapshot?.();
  const transcriptKey = `ws_test/claude-sessions/${AGENT_ID}/${SESSION_ID}.jsonl`;
  expect(fake.objects.has(transcriptKey)).toBe(true);

  await session1.close();

  // --- Daemon instance #2: a FRESH empty per-spawn home, resumed handle. -----
  const home2 = fakeHome(tmp("claude-home-2-"));
  const restoredPath = transcriptPathIn(home2.configDir, CWD, SESSION_ID);
  // Prove the new home starts empty.
  expect(() => readFileSync(restoredPath, "utf8")).toThrow();

  const capturedResume: Array<string | undefined> = [];
  const client2 = makeClient({ store, home: home2, capturedResume });
  const handle: AgentPersistenceHandle = {
    provider: "claude",
    sessionId: SESSION_ID,
    metadata: { cwd: CWD },
  };
  const session2 = await client2.resumeSession(
    handle,
    undefined,
    launch({ PASEO_AGENT_ID: AGENT_ID }),
  );

  const events2 = await drainTurn(streamSession(session2, "second prompt after restart"));

  // restore() repopulated the transcript into the fresh home before resume...
  expect(readFileSync(restoredPath, "utf8")).toBe(TRANSCRIPT_BODY);
  // ...and buildOptions resumed against the (now-present) session id.
  expect(capturedResume).toEqual([SESSION_ID]);
  // The turn completes; no "No conversation found" failure.
  expect(events2.some((e) => e.type === "turn_completed")).toBe(true);
  expect(events2.some((e) => e.type === "turn_failed")).toBe(false);

  await session2.close();
});

test("A5: close() flushes the transcript in cloud mode", async () => {
  process.env.PASEO_CLOUD_MODE = "1";
  const fake = createFakeS3();
  const home = fakeHome(tmp("claude-home-flush-"));
  const client = makeClient({ store: storeFor(fake), home });
  const session = await client.createSession(
    { provider: "claude", cwd: CWD },
    launch({ PASEO_AGENT_ID: AGENT_ID }),
  );
  await drainTurn(streamSession(session, "a prompt"));

  // Emulate the CLI-written transcript, then close.
  const writtenPath = transcriptPathIn(home.configDir, CWD, SESSION_ID);
  mkdirSync(path.dirname(writtenPath), { recursive: true });
  writeFileSync(writtenPath, TRANSCRIPT_BODY);

  expect(fake.puts.length).toBe(0);
  await session.close();

  const transcriptKey = `ws_test/claude-sessions/${AGENT_ID}/${SESSION_ID}.jsonl`;
  expect(fake.objects.has(transcriptKey)).toBe(true);
});

test("A7 local-mode guard: no S3 calls when isPaseoCloudMode() is false", async () => {
  delete process.env.PASEO_CLOUD_MODE;
  const fake = createFakeS3();
  const home = fakeHome(tmp("claude-home-local-"));
  const client = makeClient({ store: storeFor(fake), home });
  // Resume so a session id is present — local mode must STILL not touch S3.
  const handle: AgentPersistenceHandle = {
    provider: "claude",
    sessionId: SESSION_ID,
    metadata: { cwd: CWD },
  };
  const session: AgentSession = await client.resumeSession(
    handle,
    undefined,
    launch({ PASEO_AGENT_ID: AGENT_ID }),
  );

  await drainTurn(streamSession(session, "local prompt"));
  // Even an explicit capture call is a no-op in local mode.
  await session.captureTranscriptSnapshot?.();
  await session.close();

  expect(fake.puts.length).toBe(0);
  expect(fake.gets.length).toBe(0);
  expect(fake.lists).toBe(0);
  expect(fake.deletes).toBe(0);
});
