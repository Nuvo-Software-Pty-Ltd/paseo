import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Logger } from "pino";

import { isPaseoCloudMode } from "./paseo-env.js";

// Cloud-mode only: persist + rehydrate the git DELTA of a workspace's
// /workspace tree to the per-workspace, KMS-encrypted S3 bucket so uncommitted
// work survives an idle-suspend -> resume / deploy / crash / recycle. The mount
// is tmpfs (RAM) and is wiped on every task stop, so without this every restart
// loses unpushed commits, staged/unstaged edits, untracked files, and stashes.
//
// "git delta" (not a whole-tree tar): we store ONLY what the GitHub remote does
// not already have. On restore the daemon re-clones from GitHub (it always
// does) and this store replays the delta on top. Reproducible junk
// (node_modules, /workspace/.toolchain) is excluded for free — it is gitignored
// or lives outside the repo root, so it never enters the bundle/patch/untracked
// artifacts.
//
// Key layout (one prefix per workspace, all objects overwritten in place):
//   <workspaceId>/workspace-snapshot/state.bundle       <- unpushed commits, local branches, stashes, dirty-tracked state
//   <workspaceId>/workspace-snapshot/staged.patch       <- `git diff --cached --binary` (preserves the staged vs unstaged split)
//   <workspaceId>/workspace-snapshot/untracked.tar.gz   <- untracked-but-not-ignored files
//   <workspaceId>/workspace-snapshot/meta.json          <- HEAD/branch + which artifacts exist + stash refs
//
// Every method warn-and-continues on error — persistence must NEVER throw into
// the turn path, and a failed/absent/corrupt snapshot on restore degrades to a
// plain clone (never blocks boot). Local mode never constructs this store
// (callers gate on isWorkspaceSnapshotEnabled()).

// Objects are tagged so the infra-side S3 lifecycle rule (orchestra-cloud-private
// `expire-workspace-snapshots-30d`) can expire inactive snapshots without
// touching other bucket contents.
export const WORKSPACE_SNAPSHOT_OBJECT_TAG = "kind=workspace-snapshot";

const SNAPSHOT_SCHEMA_VERSION = 1;

// Temp ref namespace used during capture to give the dirty-tracked commit and
// each stash entry a NAMED ref, so `git bundle`/`git fetch` round-trips them
// (unnamed SHAs are dropped by `git fetch <refspec>`). Cleaned up in `finally`.
const CAPTURE_REF_NS = "refs/snapshot-capture";
// Scratch namespace the restore-side fetch lands the bundled refs into.
const RESTORE_REF_NS = "refs/snapshot-restore";

// Soft per-artifact cap. Each artifact is buffered in process memory (well
// within the daemon's cgroup headroom) and PUT atomically — this avoids the
// partial-corrupt-object risk of a streamed upload that fails mid-flight, at the
// cost of skipping a pathologically large delta (e.g. a multi-hundred-MB
// uncommitted binary the user forgot to gitignore). Such a skip is logged.
// Streaming via @aws-sdk/lib-storage is the documented follow-up if large
// deltas become common.
const DEFAULT_MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

function resolveMaxArtifactBytes(): number {
  const raw = process.env.PASEO_WORKSPACE_SNAPSHOT_MAX_BYTES?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ARTIFACT_BYTES;
}

// Feature gate: cloud mode AND the deployment flag (set by infra in the daemon
// task-def env). Unset on self-host/desktop = feature off, store never built.
export function isWorkspaceSnapshotEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isPaseoCloudMode(env) && env.PASEO_PERSIST_WORKSPACE_SNAPSHOT?.trim() === "1";
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

function isNoSuchKey(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  const code = (error as { Code?: unknown }).Code;
  return name === "NoSuchKey" || name === "NotFound" || code === "NoSuchKey";
}

// ── child-process helper ─────────────────────────────────────────────────────
// Buffered exec. Resolves with ok=false on a non-zero exit (so callers can
// interpret expected failures like `symbolic-ref` on a detached HEAD); rejects
// only on a spawn failure (ENOENT) or maxBuffer overflow (the size cap).
interface ExecResult {
  stdout: Buffer;
  stderr: string;
  ok: boolean;
}

function execBuffer(
  file: string,
  args: string[],
  opts: { cwd?: string; input?: Buffer; maxBytes: number } = {
    maxBytes: DEFAULT_MAX_ARTIFACT_BYTES,
  },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { cwd: opts.cwd, encoding: "buffer", maxBuffer: opts.maxBytes, windowsHide: true },
      (error, stdout, stderr) => {
        const out = (stdout as unknown as Buffer) ?? Buffer.alloc(0);
        const errStr = ((stderr as unknown as Buffer) ?? Buffer.alloc(0)).toString("utf8");
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // Spawn failure or cap overflow → genuine error.
          if (code === "ENOENT" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            reject(error);
            return;
          }
          // Otherwise a non-zero git exit — surface as ok=false, not a throw.
          resolve({ stdout: out, stderr: errStr, ok: false });
          return;
        }
        resolve({ stdout: out, stderr: errStr, ok: true });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

// ── injectable S3 surface (mirrors session-transcript-store.ts) ──────────────
export interface WorkspaceSnapshotS3 {
  putObject(input: {
    Bucket: string;
    Key: string;
    Body: Uint8Array | string;
    Tagging?: string;
  }): Promise<void>;
  // Throws an error whose `.name === "NoSuchKey"` when the object is absent.
  getObjectBytes(input: { Bucket: string; Key: string }): Promise<Uint8Array>;
  listObjectKeys(input: { Bucket: string; Prefix: string }): Promise<string[]>;
  deleteObjects(input: { Bucket: string; Keys: string[] }): Promise<void>;
}

let cachedClient: S3Client | null = null;
function getS3Client(): S3Client {
  if (!cachedClient) {
    cachedClient = new S3Client({});
  }
  return cachedClient;
}

export function adaptS3Client(client: S3Client): WorkspaceSnapshotS3 {
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
      if (!output.Body) return new Uint8Array();
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

// ── snapshot metadata ────────────────────────────────────────────────────────
interface StashRef {
  ref: string; // e.g. refs/snapshot-capture/stash/0 (named so it survives the bundle)
  message: string;
}

interface SnapshotMeta {
  schemaVersion: number;
  head: string; // `git rev-parse HEAD`, or "" for an unborn branch
  branch: string | null; // short branch name, or null when HEAD is detached
  dirtyRef: string | null; // CAPTURE_REF_NS/dirty when there were dirty tracked changes
  stashRefs: StashRef[]; // most-recent-first, matching `git stash list`
  hasBundle: boolean;
  hasStaged: boolean;
  hasUntracked: boolean;
}

export interface WorkspaceSnapshotStoreOptions {
  logger: Logger;
  client?: WorkspaceSnapshotS3;
  bucket?: string;
  maxArtifactBytes?: number;
}

export interface SnapshotArgs {
  workspaceId: string;
  repoDir: string; // absolute path to the git working tree (the clone root)
}

export interface RestoreArgs {
  workspaceId: string;
  repoDir: string;
}

export class WorkspaceSnapshotStore {
  private readonly logger: Logger;
  private readonly client: WorkspaceSnapshotS3;
  private readonly bucket: string;
  private readonly maxArtifactBytes: number;
  // Skip-if-unchanged: last successfully-snapshotted dirty signal per workspace.
  private readonly signatureCache = new Map<string, string>();
  // Serialize captures per workspace (turn-settle + periodic + shutdown can race).
  private readonly inFlight = new Set<string>();

  constructor(options: WorkspaceSnapshotStoreOptions) {
    this.logger = options.logger.child({ module: "workspace-snapshot-store" });
    this.client = options.client ?? adaptS3Client(getS3Client());
    this.bucket = options.bucket ?? resolveBucket();
    this.maxArtifactBytes = options.maxArtifactBytes ?? resolveMaxArtifactBytes();
  }

  private prefix(workspaceId: string): string {
    return `${workspaceId}/workspace-snapshot/`;
  }

  private key(workspaceId: string, name: string): string {
    return `${this.prefix(workspaceId)}${name}`;
  }

  private git(repoDir: string, args: string[], input?: Buffer): Promise<ExecResult> {
    return execBuffer("git", ["-C", repoDir, ...args], {
      input,
      maxBytes: this.maxArtifactBytes,
    });
  }

  // Resolve the git working-tree root from any path inside it (the capture hook
  // hands us an agent's cwd, which may be a subdirectory). Returns null when the
  // path isn't a git repo (e.g. clone not finished yet) — caller no-ops.
  private async resolveRepoRoot(dir: string): Promise<string | null> {
    try {
      const res = await this.git(dir, ["rev-parse", "--show-toplevel"]);
      const top = res.stdout.toString("utf8").trim();
      return res.ok && top.length > 0 ? top : null;
    } catch {
      return null;
    }
  }

  // Cheap fingerprint of everything we capture: HEAD, local branch tips (catches
  // new commits), stash tips, and the size+mtime of every changed/untracked path
  // (catches repeated edits to the same file that leave `git status` unchanged).
  private async computeSignature(repoDir: string): Promise<string> {
    const hash = createHash("sha256");
    const head = await this.git(repoDir, ["rev-parse", "HEAD"]);
    hash.update("head:");
    hash.update(head.ok ? head.stdout : Buffer.from("unborn"));
    const branches = await this.git(repoDir, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
    ]);
    hash.update("branches:");
    hash.update(branches.stdout);
    const stash = await this.git(repoDir, ["rev-list", "-g", "refs/stash"]);
    hash.update("stash:");
    hash.update(stash.ok ? stash.stdout : Buffer.alloc(0));
    // `-z` → NUL-terminated `XY path` records.
    const status = await this.git(repoDir, ["status", "--porcelain=v1", "-z"]);
    hash.update("status:");
    hash.update(status.stdout);
    for (const entry of status.stdout.toString("utf8").split("\0")) {
      if (entry.length < 4) continue;
      const rel = entry.slice(3);
      try {
        const st = await fs.stat(path.join(repoDir, rel));
        hash.update(`${rel}:${st.size}:${st.mtimeMs};`);
      } catch {
        hash.update(`${rel}:deleted;`);
      }
    }
    return hash.digest("hex");
  }

  private async putArtifact(
    workspaceId: string,
    name: string,
    body: Uint8Array | string,
  ): Promise<void> {
    await this.client.putObject({
      Bucket: this.bucket,
      Key: this.key(workspaceId, name),
      Body: body,
      Tagging: WORKSPACE_SNAPSHOT_OBJECT_TAG,
    });
  }

  /**
   * Capture the workspace's git delta to S3. No-ops when nothing changed since
   * the last snapshot, when the tree is clean + fully pushed, or when the repo
   * isn't ready. Never mutates the working tree or index.
   */
  async snapshot(args: SnapshotArgs): Promise<void> {
    const { workspaceId } = args;
    if (this.inFlight.has(workspaceId)) return;
    this.inFlight.add(workspaceId);
    const tempRefs: string[] = [];
    let repoDir = args.repoDir;
    try {
      const root = await this.resolveRepoRoot(repoDir);
      if (!root) return;
      repoDir = root;

      const signature = await this.computeSignature(repoDir);
      if (this.signatureCache.get(workspaceId) === signature) return; // unchanged

      const { dirtyRef, stashRefs } = await this.createCaptureRefs(repoDir, tempRefs);

      // Staged patch (preserves the staged vs unstaged split on restore).
      const stagedRes = await this.git(repoDir, ["diff", "--cached", "--binary"]);
      const stagedPatch = stagedRes.ok ? stagedRes.stdout : Buffer.alloc(0);
      const hasStaged = stagedPatch.byteLength > 0;

      const untrackedTar = await this.buildUntrackedTar(repoDir, workspaceId);

      // local commits/branches, dirty, stashes not reachable from any remote.
      const bundleRefs = [
        "--branches",
        ...(dirtyRef ? [dirtyRef] : []),
        ...stashRefs.map((s) => s.ref),
      ];
      const hasBundle = await this.hasLocalOnlyCommits(repoDir, bundleRefs);

      if (!hasBundle && !hasStaged && !untrackedTar) {
        // Clean and fully pushed — GitHub already has everything; nothing to store.
        this.signatureCache.set(workspaceId, signature);
        return;
      }

      const meta = await this.buildMeta(repoDir, {
        dirtyRef,
        stashRefs,
        hasBundle,
        hasStaged,
        hasUntracked: untrackedTar !== null,
      });
      if (hasBundle) meta.hasBundle = await this.uploadBundle(repoDir, workspaceId, bundleRefs);
      if (hasStaged) await this.putArtifact(workspaceId, "staged.patch", stagedPatch);
      if (untrackedTar) await this.putArtifact(workspaceId, "untracked.tar.gz", untrackedTar);
      await this.putArtifact(workspaceId, "meta.json", JSON.stringify(meta));

      this.signatureCache.set(workspaceId, signature);
      this.logger.debug(
        { workspaceId, hasBundle: meta.hasBundle, hasStaged, hasUntracked: meta.hasUntracked },
        "Snapshotted workspace git delta to S3",
      );
    } catch (error) {
      this.logger.warn({ err: error, workspaceId }, "Failed to snapshot workspace git delta");
    } finally {
      for (const ref of tempRefs) {
        await this.git(repoDir, ["update-ref", "-d", ref]).catch(() => {});
      }
      this.inFlight.delete(workspaceId);
    }
  }

  // Materialize the dirty-tracked state + each stash entry as NAMED temp refs
  // (registered in `tempRefs` for cleanup) so the bundle/fetch round-trips them.
  private async createCaptureRefs(
    repoDir: string,
    tempRefs: string[],
  ): Promise<{ dirtyRef: string | null; stashRefs: StashRef[] }> {
    const dirty = (await this.git(repoDir, ["stash", "create"])).stdout.toString("utf8").trim();
    let dirtyRef: string | null = null;
    if (dirty) {
      dirtyRef = `${CAPTURE_REF_NS}/dirty`;
      await this.git(repoDir, ["update-ref", dirtyRef, dirty]);
      tempRefs.push(dirtyRef);
    }
    const stashList = (await this.git(repoDir, ["stash", "list", "--format=%H%x00%gs"])).stdout
      .toString("utf8")
      .split("\n")
      .filter((line) => line.includes("\0"));
    const stashRefs: StashRef[] = [];
    for (let i = 0; i < stashList.length; i++) {
      const [sha, message = ""] = stashList[i].split("\0");
      if (!sha) continue;
      const ref = `${CAPTURE_REF_NS}/stash/${i}`;
      await this.git(repoDir, ["update-ref", ref, sha]);
      tempRefs.push(ref);
      stashRefs.push({ ref, message });
    }
    return { dirtyRef, stashRefs };
  }

  // Untracked-but-not-ignored files → gzipped tar (excludes gitignored junk).
  // Returns null when there are none or the tar fails / exceeds the cap.
  private async buildUntrackedTar(repoDir: string, workspaceId: string): Promise<Buffer | null> {
    const untrackedList = (await this.git(repoDir, ["ls-files", "-o", "--exclude-standard", "-z"]))
      .stdout;
    if (untrackedList.byteLength === 0) return null;
    try {
      const tar = await execBuffer("tar", ["-C", repoDir, "-czf", "-", "--null", "-T", "-"], {
        input: untrackedList,
        maxBytes: this.maxArtifactBytes,
      });
      if (tar.ok) return tar.stdout;
      this.logger.warn({ workspaceId, stderr: tar.stderr }, "Untracked tar failed; skipping");
      return null;
    } catch (error) {
      this.logger.warn({ err: error, workspaceId }, "Untracked tar exceeded cap; skipping");
      return null;
    }
  }

  private async hasLocalOnlyCommits(repoDir: string, bundleRefs: string[]): Promise<boolean> {
    const res = await this.git(repoDir, [
      "rev-list",
      "--count",
      ...bundleRefs,
      "--not",
      "--remotes",
    ]);
    return res.ok && res.stdout.toString("utf8").trim() !== "0";
  }

  private async buildMeta(
    repoDir: string,
    parts: Pick<
      SnapshotMeta,
      "dirtyRef" | "stashRefs" | "hasBundle" | "hasStaged" | "hasUntracked"
    >,
  ): Promise<SnapshotMeta> {
    const head = await this.git(repoDir, ["rev-parse", "HEAD"]);
    const branchRes = await this.git(repoDir, ["symbolic-ref", "--short", "-q", "HEAD"]);
    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      head: head.ok ? head.stdout.toString("utf8").trim() : "",
      branch: branchRes.ok ? branchRes.stdout.toString("utf8").trim() || null : null,
      ...parts,
    };
  }

  // Stream the local-only history to S3. Returns whether a bundle was stored
  // (the caller records this in meta so restore knows to fetch it).
  private async uploadBundle(
    repoDir: string,
    workspaceId: string,
    bundleRefs: string[],
  ): Promise<boolean> {
    try {
      const bundle = await this.git(repoDir, [
        "bundle",
        "create",
        "-",
        ...bundleRefs,
        "--not",
        "--remotes",
      ]);
      if (bundle.ok && bundle.stdout.byteLength > 0) {
        await this.putArtifact(workspaceId, "state.bundle", bundle.stdout);
        return true;
      }
      this.logger.warn(
        { workspaceId, stderr: bundle.stderr },
        "git bundle failed; meta marks no bundle",
      );
      return false;
    } catch (error) {
      this.logger.warn(
        { err: error, workspaceId },
        "git bundle exceeded cap; skipping unpushed history",
      );
      return false;
    }
  }

  /**
   * Replay a captured delta on top of a freshly-cloned repo. Returns true when a
   * snapshot was applied, false when none exists or restore failed (caller keeps
   * the plain clone). Wired into the clone path in Phase 2. Never throws.
   */
  async restore(args: RestoreArgs): Promise<boolean> {
    const { workspaceId } = args;
    const repoDir = await this.resolveRepoRoot(args.repoDir);
    if (!repoDir) {
      this.logger.warn(
        { workspaceId, repoDir: args.repoDir },
        "Restore target is not a git repo; skipping",
      );
      return false;
    }
    let meta: SnapshotMeta;
    try {
      const bytes = await this.client.getObjectBytes({
        Bucket: this.bucket,
        Key: this.key(workspaceId, "meta.json"),
      });
      meta = JSON.parse(Buffer.from(bytes).toString("utf8")) as SnapshotMeta;
    } catch (error) {
      if (isNoSuchKey(error)) {
        this.logger.debug({ workspaceId }, "No workspace snapshot to restore");
        return false;
      }
      this.logger.warn({ err: error, workspaceId }, "Failed to read workspace snapshot meta");
      return false;
    }
    if (meta.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
      this.logger.warn(
        { workspaceId, schemaVersion: meta.schemaVersion },
        "Unknown snapshot schema; skipping restore",
      );
      return false;
    }

    try {
      // 1. Unpushed history via the bundle.
      if (meta.hasBundle) {
        const bundlePath = path.join(repoDir, ".git", "snapshot-restore.bundle");
        const bundleBytes = await this.client.getObjectBytes({
          Bucket: this.bucket,
          Key: this.key(workspaceId, "state.bundle"),
        });
        await fs.writeFile(bundlePath, Buffer.from(bundleBytes));
        try {
          const verify = await this.git(repoDir, ["bundle", "verify", bundlePath]);
          if (!verify.ok) {
            // Prerequisite commit absent (remote diverged since capture) — fall
            // back to the plain clone rather than fetch a broken graph.
            this.logger.warn(
              { workspaceId },
              "Bundle prerequisites unsatisfied (remote diverged); keeping plain clone",
            );
            return false;
          }
          await this.git(repoDir, [
            "fetch",
            bundlePath,
            `refs/heads/*:${RESTORE_REF_NS}/heads/*`,
            `${CAPTURE_REF_NS}/*:${RESTORE_REF_NS}/cap/*`,
          ]);
          // Move the checked-out branch (or HEAD) to the snapshot tip.
          if (meta.branch) {
            const tip = `${RESTORE_REF_NS}/heads/${meta.branch}`;
            await this.git(repoDir, ["checkout", "-q", "-B", meta.branch, tip]);
          } else if (meta.head) {
            await this.git(repoDir, ["checkout", "-q", "--detach", meta.head]);
          }
        } finally {
          await fs.rm(bundlePath, { force: true }).catch(() => {});
        }
      }

      // 2. Dirty tracked changes (applied as unstaged; staged split re-applied below).
      if (meta.dirtyRef) {
        const dirtySha = (
          await this.git(repoDir, ["rev-parse", `${RESTORE_REF_NS}/cap/dirty`])
        ).stdout
          .toString("utf8")
          .trim();
        if (dirtySha) await this.git(repoDir, ["stash", "apply", "--quiet", dirtySha]);
      }

      // 3. Re-split staged vs unstaged.
      if (meta.hasStaged) {
        const patch = await this.client.getObjectBytes({
          Bucket: this.bucket,
          Key: this.key(workspaceId, "staged.patch"),
        });
        await this.git(repoDir, ["reset", "--quiet", "--mixed"]);
        // --3way falls back to a blob-level merge if the context drifted (the
        // bundle verifies the base matches, so this is belt-and-suspenders);
        // conflicts surface in the index rather than silently dropping the diff.
        const apply = await this.git(repoDir, ["apply", "--cached", "--3way"], Buffer.from(patch));
        if (!apply.ok)
          this.logger.warn(
            { workspaceId, stderr: apply.stderr },
            "Failed to re-stage staged.patch",
          );
      }

      // 4. Untracked files.
      if (meta.hasUntracked) {
        const tar = await this.client.getObjectBytes({
          Bucket: this.bucket,
          Key: this.key(workspaceId, "untracked.tar.gz"),
        });
        // --keep-old-files + a refusal to traverse out of repoDir guards against
        // a malformed archive (single-tenant, but cheap insurance).
        const extract = await execBuffer("tar", ["-C", repoDir, "-xzf", "-", "--keep-old-files"], {
          input: Buffer.from(tar),
          maxBytes: this.maxArtifactBytes,
        });
        if (!extract.ok)
          this.logger.warn(
            { workspaceId, stderr: extract.stderr },
            "Failed to extract untracked files",
          );
      }

      // 5. Restore stashes (most-recent-first; store re-pushes onto refs/stash).
      for (let i = meta.stashRefs.length - 1; i >= 0; i--) {
        const sha = (
          await this.git(repoDir, ["rev-parse", `${RESTORE_REF_NS}/cap/stash/${i}`])
        ).stdout
          .toString("utf8")
          .trim();
        if (sha) await this.git(repoDir, ["stash", "store", "-m", meta.stashRefs[i].message, sha]);
      }

      // 6. Clean up scratch refs.
      const scratch = (
        await this.git(repoDir, ["for-each-ref", "--format=%(refname)", RESTORE_REF_NS])
      ).stdout
        .toString("utf8")
        .split("\n")
        .filter(Boolean);
      for (const ref of scratch) await this.git(repoDir, ["update-ref", "-d", ref]).catch(() => {});

      this.logger.info({ workspaceId }, "Restored workspace git delta on top of clone");
      return true;
    } catch (error) {
      this.logger.warn(
        { err: error, workspaceId },
        "Failed to restore workspace snapshot; keeping plain clone",
      );
      return false;
    }
  }

  /** Delete all snapshot objects for a workspace (hard-delete path). */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    try {
      const keys = await this.client.listObjectKeys({
        Bucket: this.bucket,
        Prefix: this.prefix(workspaceId),
      });
      if (keys.length === 0) return;
      await this.client.deleteObjects({ Bucket: this.bucket, Keys: keys });
      this.signatureCache.delete(workspaceId);
      this.logger.info({ workspaceId, count: keys.length }, "Deleted workspace snapshot objects");
    } catch (error) {
      this.logger.warn({ err: error, workspaceId }, "Failed to delete workspace snapshot objects");
    }
  }

  // Test seam: drop the skip-if-unchanged cache.
  resetSignatureCacheForTesting(): void {
    this.signatureCache.clear();
  }
}

// Process-wide lazy singleton (the S3Client is never built in local mode because
// callers gate on isWorkspaceSnapshotEnabled()). Capture hooks + the hard-delete
// path share one instance so the skip-if-unchanged cache is effective.
let defaultStore: WorkspaceSnapshotStore | null = null;

export function getWorkspaceSnapshotStore(logger: Logger): WorkspaceSnapshotStore {
  if (!defaultStore) {
    defaultStore = new WorkspaceSnapshotStore({ logger });
  }
  return defaultStore;
}

export function setWorkspaceSnapshotStoreForTesting(store: WorkspaceSnapshotStore | null): void {
  defaultStore = store;
}
