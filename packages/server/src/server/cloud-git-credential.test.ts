import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import {
  gitCredentialResponse,
  buildCredentialHelperScript,
  buildDaemonGitConfig,
  materializeGitCredentialHelper,
} from "./cloud-git-credential.js";

const logger = pino({ level: "silent" });
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe("gitCredentialResponse", () => {
  it("formats git credential output with the x-access-token username", () => {
    expect(gitCredentialResponse("gho_abc")).toBe("username=x-access-token\npassword=gho_abc\n");
  });

  it("returns an empty string for a null token (git treats it as no credential)", () => {
    expect(gitCredentialResponse(null)).toBe("");
  });
});

describe("buildCredentialHelperScript", () => {
  const script = buildCredentialHelperScript({ nonce: "NONCE123", port: 8088 });

  it("is a POSIX shell script", () => {
    expect(script.startsWith("#!/bin/sh")).toBe(true);
  });

  it("only acts on the git `get` operation (store/erase are no-ops)", () => {
    expect(script).toContain('[ "$1" = "get" ]');
  });

  it("calls the loopback credential route carrying the per-boot nonce header", () => {
    expect(script).toContain("X-Paseo-Cred-Nonce: NONCE123");
    expect(script).toContain("http://127.0.0.1:8088/api/internal/git-credential");
  });
});

describe("buildDaemonGitConfig", () => {
  const cfg = buildDaemonGitConfig({ helperPath: "/workspace/.paseo/git-credential-helper.sh" });

  it("registers the helper scoped to github.com over https (not all hosts)", () => {
    expect(cfg).toContain('[credential "https://github.com"]');
    expect(cfg).toContain("helper = /workspace/.paseo/git-credential-helper.sh");
  });

  it("resets any inherited helper first so a stale one can't win", () => {
    // An empty `helper =` line before ours clears inherited helpers.
    const lines = cfg.split("\n").map((l) => l.trim());
    const empty = lines.indexOf("helper =");
    const ours = lines.indexOf("helper = /workspace/.paseo/git-credential-helper.sh");
    expect(empty).toBeGreaterThanOrEqual(0);
    expect(ours).toBeGreaterThan(empty);
  });
});

describe("materializeGitCredentialHelper", () => {
  it("writes an executable helper script + a gitconfig and returns their paths", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ghcred-"));
    tmpDirs.push(dir);

    const res = await materializeGitCredentialHelper({ dir, nonce: "abc123", port: 9090, logger });
    expect(res).not.toBeNull();
    const helper = readFileSync(res!.helperPath, "utf8");
    expect(helper).toContain("X-Paseo-Cred-Nonce: abc123");
    expect(helper).toContain("9090");
    // Owner-executable (0700) — git must exec it. POSIX-only: Windows has no
    // Unix permission bits (the cloud daemon this helper serves is Linux-only).
    if (process.platform !== "win32") {
      expect(statSync(res!.helperPath).mode & 0o100).toBe(0o100);
    }

    const cfg = readFileSync(res!.gitConfigPath, "utf8");
    expect(cfg).toContain(res!.helperPath);
  });

  it("never throws — returns null when the target dir cannot be created", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "ghcred-"));
    tmpDirs.push(base);
    const filePath = path.join(base, "iam-a-file");
    writeFileSync(filePath, "x");
    // A dir whose ancestor is a regular file → mkdir fails with ENOTDIR.
    const res = await materializeGitCredentialHelper({
      dir: path.join(filePath, "sub"),
      nonce: "x",
      port: 1,
      logger,
    });
    expect(res).toBeNull();
  });
});
