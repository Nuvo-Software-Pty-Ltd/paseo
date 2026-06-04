import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import {
  SessionTranscriptStore,
  type S3Like,
  type S3PutObjectInput,
} from "./session-transcript-store.js";

const silentLogger = pino({ level: "silent" });

function tmpDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function sanitize(cwd: string): string {
  return cwd.replace(/[\\/._:]/g, "-");
}

class NoSuchKeyError extends Error {
  readonly name = "NoSuchKey";
}

interface FakeS3 extends S3Like {
  puts: S3PutObjectInput[];
  objects: Map<string, Uint8Array>;
  deleted: string[];
  getCalls: string[];
}

function createFakeS3(seed?: Record<string, string>): FakeS3 {
  const objects = new Map<string, Uint8Array>();
  if (seed) {
    for (const [key, body] of Object.entries(seed)) {
      objects.set(key, new TextEncoder().encode(body));
    }
  }
  const puts: S3PutObjectInput[] = [];
  const deleted: string[] = [];
  const getCalls: string[] = [];
  return {
    puts,
    objects,
    deleted,
    getCalls,
    async putObject(input) {
      puts.push(input);
      objects.set(
        input.Key,
        typeof input.Body === "string" ? new TextEncoder().encode(input.Body) : input.Body,
      );
    },
    async getObjectBytes(input) {
      getCalls.push(input.Key);
      const body = objects.get(input.Key);
      if (!body) {
        throw new NoSuchKeyError(`missing ${input.Key}`);
      }
      return body;
    },
    async listObjectKeys(input) {
      return [...objects.keys()].filter((key) => key.startsWith(input.Prefix));
    },
    async deleteObjects(input) {
      for (const key of input.Keys) {
        deleted.push(key);
        objects.delete(key);
      }
    },
  };
}

describe("SessionTranscriptStore.restore", () => {
  let home: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("writes the fetched body to <home>/projects/<sanitized-cwd>/<sessionId>.jsonl", async () => {
    home = tmpDir("transcript-restore-");
    const cwd = "/workspace/ws_abc";
    const sessionId = "sess-123";
    const body = '{"type":"user","uuid":"u1"}\n{"type":"assistant"}\n';
    const key = `ws_abc/claude-sessions/agent-1/${sessionId}.jsonl`;
    const fake = createFakeS3({ [key]: body });
    const store = new SessionTranscriptStore({
      client: fake,
      bucket: "test-bucket",
      logger: silentLogger,
    });

    const ok = await store.restore({
      workspaceId: "ws_abc",
      agentId: "agent-1",
      sessionId,
      cwd,
      homeConfigDir: home,
    });

    expect(ok).toBe(true);
    const written = path.join(home, "projects", sanitize(cwd), `${sessionId}.jsonl`);
    expect(readFileSync(written, "utf8")).toBe(body);
    expect(fake.getCalls).toEqual([key]);
  });

  test("returns false on NoSuchKey and writes nothing", async () => {
    home = tmpDir("transcript-restore-miss-");
    const cwd = "/workspace/ws_abc";
    const fake = createFakeS3();
    const store = new SessionTranscriptStore({
      client: fake,
      bucket: "test-bucket",
      logger: silentLogger,
    });

    const ok = await store.restore({
      workspaceId: "ws_abc",
      agentId: "agent-1",
      sessionId: "missing-session",
      cwd,
      homeConfigDir: home,
    });

    expect(ok).toBe(false);
  });
});

describe("SessionTranscriptStore.snapshot", () => {
  let workdir: string;
  afterEach(() => {
    if (workdir) rmSync(workdir, { recursive: true, force: true });
  });

  function writeTranscript(body: string): string {
    workdir = tmpDir("transcript-snapshot-");
    const transcriptPath = path.join(workdir, "session.jsonl");
    writeFileSync(transcriptPath, body);
    return transcriptPath;
  }

  test("PUTs the transcript at the expected key plus a current.json sidecar", async () => {
    const body = '{"type":"user"}\n';
    const transcriptPath = writeTranscript(body);
    const fake = createFakeS3();
    const store = new SessionTranscriptStore({
      client: fake,
      bucket: "test-bucket",
      logger: silentLogger,
    });

    await store.snapshot({
      workspaceId: "ws_abc",
      agentId: "agent-1",
      sessionId: "sess-9",
      cwd: "/workspace/ws_abc",
      transcriptPath,
    });

    const transcriptKey = "ws_abc/claude-sessions/agent-1/sess-9.jsonl";
    const sidecarKey = "ws_abc/claude-sessions/agent-1/current.json";
    expect(fake.puts.map((p) => p.Key).sort()).toEqual([sidecarKey, transcriptKey]);

    const transcriptPut = fake.puts.find((p) => p.Key === transcriptKey);
    expect(new TextDecoder().decode(fake.objects.get(transcriptKey)!)).toBe(body);
    expect(transcriptPut?.Tagging).toBe("kind=claude-session");

    const sidecar = JSON.parse(new TextDecoder().decode(fake.objects.get(sidecarKey)!));
    expect(sidecar).toEqual({ sessionId: "sess-9", cwd: "/workspace/ws_abc" });
  });

  test("second snapshot of an unchanged file is a no-op (skip-if-unchanged)", async () => {
    const transcriptPath = writeTranscript('{"type":"user"}\n');
    const fake = createFakeS3();
    const store = new SessionTranscriptStore({
      client: fake,
      bucket: "test-bucket",
      logger: silentLogger,
    });
    const args = {
      workspaceId: "ws_abc",
      agentId: "agent-1",
      sessionId: "sess-9",
      cwd: "/workspace/ws_abc",
      transcriptPath,
    };

    await store.snapshot(args);
    const putsAfterFirst = fake.puts.length;
    await store.snapshot(args);

    expect(fake.puts.length).toBe(putsAfterFirst);
  });

  test("re-snapshots after the file changes", async () => {
    const transcriptPath = writeTranscript('{"type":"user"}\n');
    const fake = createFakeS3();
    const store = new SessionTranscriptStore({
      client: fake,
      bucket: "test-bucket",
      logger: silentLogger,
    });
    const args = {
      workspaceId: "ws_abc",
      agentId: "agent-1",
      sessionId: "sess-9",
      cwd: "/workspace/ws_abc",
      transcriptPath,
    };

    await store.snapshot(args);
    const putsAfterFirst = fake.puts.length;
    // Grow the file and bump mtime so size+mtime both differ from the cache.
    writeFileSync(transcriptPath, '{"type":"user"}\n{"type":"assistant"}\n');
    const future = new Date(Date.now() + 10_000);
    utimesSync(transcriptPath, future, future);
    await store.snapshot(args);

    expect(fake.puts.length).toBeGreaterThan(putsAfterFirst);
  });

  test("missing transcript file is a no-op and does not throw", async () => {
    const fake = createFakeS3();
    const store = new SessionTranscriptStore({
      client: fake,
      bucket: "test-bucket",
      logger: silentLogger,
    });

    await expect(
      store.snapshot({
        workspaceId: "ws_abc",
        agentId: "agent-1",
        sessionId: "sess-9",
        cwd: "/workspace/ws_abc",
        transcriptPath: path.join(tmpdir(), "does-not-exist-transcript.jsonl"),
      }),
    ).resolves.toBeUndefined();
    expect(fake.puts.length).toBe(0);
  });
});

describe("SessionTranscriptStore.deleteAgent", () => {
  test("deletes every object under the agent prefix and nothing else", async () => {
    const fake = createFakeS3({
      "ws_abc/claude-sessions/agent-1/sess-1.jsonl": "a",
      "ws_abc/claude-sessions/agent-1/sess-2.jsonl": "b",
      "ws_abc/claude-sessions/agent-1/current.json": "{}",
      "ws_abc/claude-sessions/agent-2/sess-1.jsonl": "keep",
      "ws_other/claude-sessions/agent-1/sess-1.jsonl": "keep",
    });
    const store = new SessionTranscriptStore({
      client: fake,
      bucket: "test-bucket",
      logger: silentLogger,
    });

    await store.deleteAgent({ workspaceId: "ws_abc", agentId: "agent-1" });

    expect(fake.deleted.sort()).toEqual([
      "ws_abc/claude-sessions/agent-1/current.json",
      "ws_abc/claude-sessions/agent-1/sess-1.jsonl",
      "ws_abc/claude-sessions/agent-1/sess-2.jsonl",
    ]);
    expect(fake.objects.has("ws_abc/claude-sessions/agent-2/sess-1.jsonl")).toBe(true);
    expect(fake.objects.has("ws_other/claude-sessions/agent-1/sess-1.jsonl")).toBe(true);
  });

  test("empty prefix is a no-op", async () => {
    const fake = createFakeS3();
    const store = new SessionTranscriptStore({
      client: fake,
      bucket: "test-bucket",
      logger: silentLogger,
    });
    await store.deleteAgent({ workspaceId: "ws_abc", agentId: "agent-1" });
    expect(fake.deleted).toEqual([]);
  });
});
