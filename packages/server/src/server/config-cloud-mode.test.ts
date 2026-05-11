import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "./config.js";

const roots: string[] = [];

async function createPaseoHome(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-config-cloud-"));
  roots.push(root);
  return root;
}

describe("PASEO_CLOUD_MODE config integration", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("listen defaults to 0.0.0.0:6767 when PASEO_CLOUD_MODE=1 and PASEO_LISTEN is unset", async () => {
    const paseoHome = await createPaseoHome();
    const config = loadConfig(paseoHome, { env: { PASEO_CLOUD_MODE: "1" } });
    expect(config.listen).toBe("0.0.0.0:6767");
  });

  test("listen stays 127.0.0.1:6767 in on-host mode (PASEO_CLOUD_MODE unset)", async () => {
    const paseoHome = await createPaseoHome();
    const config = loadConfig(paseoHome, { env: {} });
    expect(config.listen).toBe("127.0.0.1:6767");
  });

  test("PASEO_LISTEN still takes precedence over the cloud-mode default", async () => {
    const paseoHome = await createPaseoHome();
    const config = loadConfig(paseoHome, {
      env: { PASEO_CLOUD_MODE: "1", PASEO_LISTEN: "127.0.0.1:7777" },
    });
    expect(config.listen).toBe("127.0.0.1:7777");
  });

  test("hostnames resolves to `true` (bypass allowlist) when PASEO_CLOUD_MODE=1", async () => {
    // In cloud mode the daemon is reachable only via the ALB at a public DNS name;
    // the localhost-rebinding mitigation does not apply, so the allowlist is bypassed.
    const paseoHome = await createPaseoHome();
    const config = loadConfig(paseoHome, { env: { PASEO_CLOUD_MODE: "1" } });
    expect(config.hostnames).toBe(true);
  });

  test("hostnames stays an array/undefined in on-host mode", async () => {
    const paseoHome = await createPaseoHome();
    const config = loadConfig(paseoHome, { env: {} });
    // Default (no PASEO_HOSTNAMES, no persisted config) is an empty list, which
    // mergeHostnames returns as `[]` — semantically: localhost-only defaults apply.
    expect(config.hostnames).not.toBe(true);
  });
});
