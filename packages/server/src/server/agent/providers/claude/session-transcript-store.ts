import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type pino from "pino";

// Cloud-mode only: persist + rehydrate each Claude agent's transcript `.jsonl`
// to the per-workspace, KMS-encrypted S3 bucket so conversations survive an
// idle-suspend -> resume / deploy / crash / recycle. Local mode never
// constructs this store (callers gate every use on `isPaseoCloudMode()`).
//
// Key layout (one prefix per agent):
//   <workspaceId>/claude-sessions/<agentId>/<sessionId>.jsonl   <- the transcript
//   <workspaceId>/claude-sessions/<agentId>/current.json        <- { sessionId, cwd } sidecar
//
// Every method warn-and-continues on error — persistence must never throw into
// the turn path. A missing object on restore degrades to a fresh session via
// the stale-resume fallback in agent.ts (handleMissingResumedConversation).

// Objects are tagged so the infra-side S3 lifecycle rule (Repo B) can expire
// inactive claude-session objects without touching other bucket contents.
export const CLAUDE_SESSION_OBJECT_TAG = "kind=claude-session";

// Duplicated from agent.ts (`sanitizeClaudeProjectPath`, the 3-line regex) on
// purpose: importing it would create an agent.ts <-> store circular import,
// and the rule is stable (Claude Code's own project-dir sanitizer).
function sanitizeClaudeProjectPath(cwd: string): string {
  return cwd.replace(/[\\/._:]/g, "-");
}

function resolveStage(): string {
  const stage = process.env.ORCHESTRA_STAGE?.trim();
  return stage && stage.length > 0 ? stage : "dev";
}

function resolveBucket(): string {
  const explicit = process.env.ORCHESTRA_WORKSPACES_BUCKET?.trim();
  return explicit && explicit.length > 0
    ? explicit
    : `orchestra-cloud-workspaces-${resolveStage()}`;
}

export interface S3PutObjectInput {
  Bucket: string;
  Key: string;
  Body: Uint8Array | string;
  Tagging?: string;
}

// Minimal surface the store actually uses. Tests inject a fake; production
// wires in the real S3Client via `adaptS3Client`. Mirrors the
// `SecretsManagerLike` injection pattern in cloud-credentials.ts.
export interface S3Like {
  putObject(input: S3PutObjectInput): Promise<void>;
  // Throws an error whose `.name === "NoSuchKey"` when the object is absent.
  getObjectBytes(input: { Bucket: string; Key: string }): Promise<Uint8Array>;
  listObjectKeys(input: { Bucket: string; Prefix: string }): Promise<string[]>;
  deleteObjects(input: { Bucket: string; Keys: string[] }): Promise<void>;
}

function isNoSuchKey(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  const code = (error as { Code?: unknown }).Code;
  return name === "NoSuchKey" || name === "NotFound" || code === "NoSuchKey";
}

let cachedClient: S3Client | null = null;
function getS3Client(): S3Client {
  if (!cachedClient) {
    cachedClient = new S3Client({});
  }
  return cachedClient;
}

export function adaptS3Client(client: S3Client): S3Like {
  return {
    async putObject(input) {
      await client.send(
        new PutObjectCommand({
          Bucket: input.Bucket,
          Key: input.Key,
          Body: input.Body,
          ...(input.Tagging ? { Tagging: input.Tagging } : {}),
        }),
      );
    },
    async getObjectBytes(input) {
      const output = await client.send(
        new GetObjectCommand({ Bucket: input.Bucket, Key: input.Key }),
      );
      if (!output.Body) {
        return new Uint8Array();
      }
      return await output.Body.transformToByteArray();
    },
    async listObjectKeys(input) {
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const output = await client.send(
          new ListObjectsV2Command({
            Bucket: input.Bucket,
            Prefix: input.Prefix,
            ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
          }),
        );
        for (const item of output.Contents ?? []) {
          if (item.Key) keys.push(item.Key);
        }
        continuationToken = output.IsTruncated ? output.NextContinuationToken : undefined;
      } while (continuationToken);
      return keys;
    },
    async deleteObjects(input) {
      // DeleteObjects caps at 1000 keys per request.
      for (let i = 0; i < input.Keys.length; i += 1000) {
        const batch = input.Keys.slice(i, i + 1000);
        await client.send(
          new DeleteObjectsCommand({
            Bucket: input.Bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
      }
    },
  };
}

export interface SessionTranscriptStoreOptions {
  logger: pino.Logger;
  client?: S3Like;
  bucket?: string;
}

export interface SnapshotArgs {
  workspaceId: string;
  agentId: string;
  sessionId: string;
  cwd: string;
  transcriptPath: string;
}

export interface RestoreArgs {
  workspaceId: string;
  agentId: string;
  sessionId: string;
  cwd: string;
  homeConfigDir: string;
}

export interface DeleteAgentArgs {
  workspaceId: string;
  agentId: string;
}

interface SnapshotCacheEntry {
  size: number;
  mtimeMs: number;
}

export class SessionTranscriptStore {
  private readonly logger: pino.Logger;
  private readonly client: S3Like;
  private readonly bucket: string;
  // Skip-if-unchanged cache keyed by the transcript's S3 key. `agent_state`
  // fires very often; this turns a no-op snapshot into a single fs.stat.
  private readonly snapshotCache = new Map<string, SnapshotCacheEntry>();

  constructor(options: SessionTranscriptStoreOptions) {
    this.logger = options.logger.child({ module: "session-transcript-store" });
    this.client = options.client ?? adaptS3Client(getS3Client());
    this.bucket = options.bucket ?? resolveBucket();
  }

  private agentPrefix(workspaceId: string, agentId: string): string {
    return `${workspaceId}/claude-sessions/${agentId}/`;
  }

  private transcriptKey(workspaceId: string, agentId: string, sessionId: string): string {
    return `${this.agentPrefix(workspaceId, agentId)}${sessionId}.jsonl`;
  }

  private sidecarKey(workspaceId: string, agentId: string): string {
    return `${this.agentPrefix(workspaceId, agentId)}current.json`;
  }

  async snapshot(args: SnapshotArgs): Promise<void> {
    const key = this.transcriptKey(args.workspaceId, args.agentId, args.sessionId);
    let body: Uint8Array;
    let stat: { size: number; mtimeMs: number };
    try {
      const fileStat = await fs.stat(args.transcriptPath);
      stat = { size: fileStat.size, mtimeMs: fileStat.mtimeMs };
      const cached = this.snapshotCache.get(key);
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        // Unchanged since the last successful PUT — skip the upload entirely.
        return;
      }
      body = await fs.readFile(args.transcriptPath);
    } catch (error) {
      // A missing transcript is expected before the first turn writes one.
      this.logger.debug(
        { err: error, transcriptPath: args.transcriptPath },
        "Skipping Claude transcript snapshot (no readable transcript)",
      );
      return;
    }
    try {
      await this.client.putObject({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        Tagging: CLAUDE_SESSION_OBJECT_TAG,
      });
      await this.client.putObject({
        Bucket: this.bucket,
        Key: this.sidecarKey(args.workspaceId, args.agentId),
        Body: new TextEncoder().encode(
          JSON.stringify({ sessionId: args.sessionId, cwd: args.cwd }),
        ),
        Tagging: CLAUDE_SESSION_OBJECT_TAG,
      });
      this.snapshotCache.set(key, stat);
      this.logger.debug({ key, bytes: body.byteLength }, "Snapshotted Claude transcript to S3");
    } catch (error) {
      this.logger.warn({ err: error, key }, "Failed to snapshot Claude transcript to S3");
    }
  }

  async deleteAgent(args: DeleteAgentArgs): Promise<void> {
    const prefix = this.agentPrefix(args.workspaceId, args.agentId);
    try {
      const keys = await this.client.listObjectKeys({ Bucket: this.bucket, Prefix: prefix });
      if (keys.length === 0) {
        return;
      }
      await this.client.deleteObjects({ Bucket: this.bucket, Keys: keys });
      for (const key of keys) {
        this.snapshotCache.delete(key);
      }
      this.logger.info({ prefix, count: keys.length }, "Deleted Claude transcripts for agent");
    } catch (error) {
      this.logger.warn({ err: error, prefix }, "Failed to delete Claude transcripts for agent");
    }
  }

  // Reset the skip-if-unchanged cache. Exposed for tests that reuse a store
  // across simulated daemon restarts.
  resetSnapshotCacheForTesting(): void {
    this.snapshotCache.clear();
  }

  async restore(args: RestoreArgs): Promise<boolean> {
    const key = this.transcriptKey(args.workspaceId, args.agentId, args.sessionId);
    let body: Uint8Array;
    try {
      body = await this.client.getObjectBytes({ Bucket: this.bucket, Key: key });
    } catch (error) {
      if (isNoSuchKey(error)) {
        this.logger.debug({ key }, "No persisted transcript to restore");
        return false;
      }
      this.logger.warn({ err: error, key }, "Failed to restore Claude transcript from S3");
      return false;
    }
    try {
      const dir = path.join(args.homeConfigDir, "projects", sanitizeClaudeProjectPath(args.cwd));
      await fs.mkdir(dir, { recursive: true });
      const dest = path.join(dir, `${args.sessionId}.jsonl`);
      await fs.writeFile(dest, body);
      this.logger.info(
        { key, dest, bytes: body.byteLength },
        "Restored Claude transcript from S3 before resume",
      );
      return true;
    } catch (error) {
      this.logger.warn(
        { err: error, key, homeConfigDir: args.homeConfigDir },
        "Failed to write restored Claude transcript to per-spawn home",
      );
      return false;
    }
  }
}

// Process-wide lazy singleton. Constructed only on the first cloud-mode use
// (the S3Client is never built in local mode because every caller gates on
// `isPaseoCloudMode()`). The Claude session, the persistence-capture hook, and
// the cloud agent hard-delete path all share this one instance so the
// skip-if-unchanged cache is effective across them.
let defaultStore: SessionTranscriptStore | null = null;

export function getSessionTranscriptStore(logger: pino.Logger): SessionTranscriptStore {
  if (!defaultStore) {
    defaultStore = new SessionTranscriptStore({ logger });
  }
  return defaultStore;
}

// Test seam: inject a store backed by a fake S3 client (or reset to null).
export function setSessionTranscriptStoreForTesting(store: SessionTranscriptStore | null): void {
  defaultStore = store;
}
