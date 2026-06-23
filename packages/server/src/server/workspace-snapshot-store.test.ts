import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { WorkspaceSnapshotStore, type WorkspaceSnapshotS3 } from "./workspace-snapshot-store.js";

// In-memory S3 double — getObjectBytes throws a NoSuchKey-shaped error on miss.
class FakeS3 implements WorkspaceSnapshotS3 {
  readonly objects = new Map<string, Buffer>();
  async putObject(input: {
    Bucket: string;
    Key: string;
    Body: Uint8Array | string;
  }): Promise<void> {
    this.objects.set(input.Key, Buffer.from(input.Body as Uint8Array | string));
  }
  async getObjectBytes(input: { Bucket: string; Key: string }): Promise<Uint8Array> {
    const v = this.objects.get(input.Key);
    if (!v) {
      const err = new Error("NoSuchKey") as Error & { name: string };
      err.name = "NoSuchKey";
      throw err;
    }
    return v;
  }
  async listObjectKeys(input: { Bucket: string; Prefix: string }): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(input.Prefix));
  }
  async deleteObjects(input: { Bucket: string; Keys: string[] }): Promise<void> {
    for (const k of input.Keys) this.objects.delete(k);
  }
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { env: GIT_ENV, encoding: "utf8" }).trim();
}

const WS = "ws_test";

describe("WorkspaceSnapshotStore round-trip (real git, shallow clone)", () => {
  let root: string;
  let originUrl: string;
  let logger: pino.Logger;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "wss-"));
    logger = pino({ level: "silent" });
    // Bare origin with two commits on `main`.
    execFileSync("git", ["init", "-q", "--bare", path.join(root, "origin.git")], { env: GIT_ENV });
    execFileSync(
      "git",
      ["-C", path.join(root, "origin.git"), "symbolic-ref", "HEAD", "refs/heads/main"],
      { env: GIT_ENV },
    );
    originUrl = `file://${path.join(root, "origin.git")}`;
    const seed = path.join(root, "seed");
    execFileSync("git", ["clone", "-q", originUrl, seed], { env: GIT_ENV });
    git(seed, ["checkout", "-q", "-B", "main"]);
    writeFileSync(path.join(seed, "fileA.txt"), "A0\n");
    writeFileSync(path.join(seed, "fileB.txt"), "B0\n");
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-qm", "initial"]);
    git(seed, ["push", "-q", "origin", "main"]);
    writeFileSync(path.join(seed, "fileA.txt"), "A0\nupstream2\n");
    git(seed, ["commit", "-qam", "upstream2"]);
    git(seed, ["push", "-q", "origin", "main"]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function shallowClone(name: string): string {
    const dir = path.join(root, name);
    execFileSync("git", ["clone", "-q", "--depth=1", originUrl, dir], { env: GIT_ENV });
    return dir;
  }

  test("captures and restores unpushed commit + staged/unstaged + untracked + stash", async () => {
    const work = shallowClone("work");
    expect(git(work, ["rev-parse", "--is-shallow-repository"])).toBe("true");

    // Unpushed commit.
    writeFileSync(path.join(work, "fileA.txt"), "A0\nupstream2\nLOCAL\n");
    git(work, ["commit", "-qam", "unpushed local"]);
    // A separate stash (fileB change → stashed, leaves tracked clean).
    writeFileSync(path.join(work, "fileB.txt"), "B0\nB-stashed\n");
    git(work, ["stash", "-q"]);
    // Live dirty: staged + unstaged on fileA.
    writeFileSync(path.join(work, "fileA.txt"), "A0\nupstream2\nLOCAL\nA-staged\n");
    git(work, ["add", "fileA.txt"]);
    writeFileSync(path.join(work, "fileA.txt"), "A0\nupstream2\nLOCAL\nA-staged\nA-unstaged\n");
    // Untracked.
    writeFileSync(path.join(work, "untracked.txt"), "U\n");

    const originalPorcelain = git(work, ["status", "--porcelain"]);
    expect(originalPorcelain).toContain("MM fileA.txt");
    expect(originalPorcelain).toContain("?? untracked.txt");

    const s3 = new FakeS3();
    const store = new WorkspaceSnapshotStore({ logger, client: s3, bucket: "b" });
    await store.snapshot({ workspaceId: WS, repoDir: work });

    // Artifacts landed and are tagged-by-prefix.
    expect(s3.objects.has("ws_test/workspace-snapshot/state.bundle")).toBe(true);
    expect(s3.objects.has("ws_test/workspace-snapshot/staged.patch")).toBe(true);
    expect(s3.objects.has("ws_test/workspace-snapshot/untracked.tar.gz")).toBe(true);
    expect(s3.objects.has("ws_test/workspace-snapshot/meta.json")).toBe(true);

    // Capture must not mutate the source tree.
    expect(git(work, ["status", "--porcelain"])).toBe(originalPorcelain);

    // Restore onto a fresh shallow clone.
    const restored = shallowClone("restored");
    const ok = await store.restore({ workspaceId: WS, repoDir: restored });
    expect(ok).toBe(true);

    // Working tree, index split, branch tip, untracked, and stash all match.
    expect(git(restored, ["status", "--porcelain"])).toContain("MM fileA.txt");
    expect(git(restored, ["status", "--porcelain"])).toContain("?? untracked.txt");
    expect(git(restored, ["log", "--oneline", "-1"])).toContain("unpushed local");
    expect(git(restored, ["show", "HEAD:fileA.txt"])).toBe("A0\nupstream2\nLOCAL");
    // Staged content includes A-staged; unstaged adds A-unstaged.
    expect(git(restored, ["diff", "--cached", "--name-only"])).toContain("fileA.txt");
    expect(git(restored, ["diff", "--name-only"])).toContain("fileA.txt");
    // fileB change lives in the restored stash, not the working tree.
    expect(git(restored, ["show", "HEAD:fileB.txt"])).toBe("B0");
    expect(git(restored, ["stash", "list"])).toContain("stash@{0}");
    const stashShow = git(restored, ["stash", "show", "-p", "stash@{0}"]);
    expect(stashShow).toContain("B-stashed");
  }, 30_000);

  test("clean, fully-pushed tree writes nothing", async () => {
    const work = shallowClone("clean");
    const s3 = new FakeS3();
    const store = new WorkspaceSnapshotStore({ logger, client: s3, bucket: "b" });
    await store.snapshot({ workspaceId: WS, repoDir: work });
    expect(s3.objects.size).toBe(0);
  }, 30_000);

  test("second snapshot with no changes is skipped (dirty-check)", async () => {
    const work = shallowClone("skip");
    writeFileSync(path.join(work, "fileA.txt"), "A0\nupstream2\nedit\n");
    const s3 = new FakeS3();
    const store = new WorkspaceSnapshotStore({ logger, client: s3, bucket: "b" });
    await store.snapshot({ workspaceId: WS, repoDir: work });
    const metaV1 = s3.objects.get("ws_test/workspace-snapshot/meta.json");
    expect(metaV1).toBeDefined();
    s3.objects.delete("ws_test/workspace-snapshot/meta.json"); // prove a skip means no re-PUT
    await store.snapshot({ workspaceId: WS, repoDir: work });
    expect(s3.objects.has("ws_test/workspace-snapshot/meta.json")).toBe(false);
  }, 30_000);

  test("restore is a no-op when no snapshot exists", async () => {
    const restored = shallowClone("none");
    const s3 = new FakeS3();
    const store = new WorkspaceSnapshotStore({ logger, client: s3, bucket: "b" });
    expect(await store.restore({ workspaceId: WS, repoDir: restored })).toBe(false);
  }, 30_000);
});
