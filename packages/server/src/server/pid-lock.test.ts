import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { acquirePidLock, getPidLockInfo, releasePidLock, updatePidLock } from "./pid-lock.js";

describe("pid-lock ownership", () => {
  test("writes and releases lock for explicit owner pid", async () => {
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-owner-"));
    const ownerPid = process.pid + 10_000;

    try {
      await (
        acquirePidLock as unknown as (
          home: string,
          sockPath: string | null,
          options: { ownerPid: number },
        ) => Promise<void>
      )(paseoHome, null, { ownerPid });

      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(ownerPid);
      expect(lock?.listen).toBeNull();

      await (
        updatePidLock as unknown as (
          home: string,
          patch: { listen: string },
          options: { ownerPid: number },
        ) => Promise<void>
      )(paseoHome, { listen: "127.0.0.1:6767" }, { ownerPid });

      const updatedLock = await getPidLockInfo(paseoHome);
      expect(updatedLock?.listen).toBe("127.0.0.1:6767");

      await (
        releasePidLock as unknown as (home: string, options: { ownerPid: number }) => Promise<void>
      )(paseoHome, { ownerPid: ownerPid + 1 });
      const lockAfterWrongOwnerRelease = await getPidLockInfo(paseoHome);
      expect(lockAfterWrongOwnerRelease?.pid).toBe(ownerPid);

      await (
        releasePidLock as unknown as (home: string, options: { ownerPid: number }) => Promise<void>
      )(paseoHome, { ownerPid });
      const lockAfterOwnerRelease = await getPidLockInfo(paseoHome);
      expect(lockAfterOwnerRelease).toBeNull();
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });
});

describe("pid-lock under PASEO_CLOUD_MODE", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("acquirePidLock is a no-op when PASEO_CLOUD_MODE=1", async () => {
    // Cloud mode: container = workspace = singleton; no per-host pid-file needed
    // and an existing pid file from any concurrent process must NOT block startup.
    vi.stubEnv("PASEO_CLOUD_MODE", "1");
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-cloud-mode-"));
    try {
      await acquirePidLock(paseoHome, "0.0.0.0:6767");
      const lock = await getPidLockInfo(paseoHome);
      expect(lock).toBeNull();
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });

  test("acquirePidLock still writes a lock when PASEO_CLOUD_MODE is unset", async () => {
    // Sanity: on-host mode is unchanged.
    const paseoHome = await mkdtemp(join(tmpdir(), "paseo-pid-lock-on-host-"));
    const ownerPid = process.pid + 20_000;
    try {
      await (
        acquirePidLock as unknown as (
          home: string,
          sockPath: string | null,
          options: { ownerPid: number },
        ) => Promise<void>
      )(paseoHome, "127.0.0.1:6767", { ownerPid });
      const lock = await getPidLockInfo(paseoHome);
      expect(lock?.pid).toBe(ownerPid);
      expect(lock?.listen).toBe("127.0.0.1:6767");
    } finally {
      await rm(paseoHome, { recursive: true, force: true });
    }
  });
});
