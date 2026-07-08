import { afterEach, describe, expect, it } from "vitest";
import pino from "pino";
import {
  resolveCloudProvisioningNotices,
  GITHUB_REAUTH_NOTICE,
  TOOLCHAIN_MISSING_NOTICE,
} from "./cloud-provisioning-notices.js";

const logger = pino({ level: "silent" });

// Snapshot + restore the env keys these checks read, so tests don't leak.
const ENV_KEYS = [
  "PASEO_CLOUD_MODE",
  "ORCHESTRA_EXPOSE_GITHUB_TOKEN",
  "PASEO_TOOLCHAIN_PREFIX",
] as const;
const saved: Record<string, string | undefined> = {};
function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
afterEach(() => {
  for (const key of ENV_KEYS) {
    const v = saved[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
});

const reauth = () => Promise.resolve({ token: null, needsReauth: true });
const healthy = () => Promise.resolve({ token: "ghp_live", needsReauth: false });
const transient = () => Promise.resolve({ token: null, needsReauth: false });

describe("resolveCloudProvisioningNotices", () => {
  it("returns no notices outside cloud mode (self-host / desktop)", async () => {
    setEnv("PASEO_CLOUD_MODE", undefined);
    setEnv("ORCHESTRA_EXPOSE_GITHUB_TOKEN", "1");
    setEnv("PASEO_TOOLCHAIN_PREFIX", "/workspace/.toolchain");
    const notices = await resolveCloudProvisioningNotices({
      env: {},
      logger,
      getToken: reauth,
      toolchainBinPopulated: async () => false,
    });
    expect(notices).toEqual([]);
  });

  it("emits the GitHub re-auth notice when needsReauth and no token in env", async () => {
    setEnv("PASEO_CLOUD_MODE", "1");
    setEnv("ORCHESTRA_EXPOSE_GITHUB_TOKEN", "1");
    setEnv("PASEO_TOOLCHAIN_PREFIX", undefined);
    const notices = await resolveCloudProvisioningNotices({ env: {}, logger, getToken: reauth });
    expect(notices).toContain(GITHUB_REAUTH_NOTICE);
  });

  it("does NOT warn about GitHub when a token is present in the env", async () => {
    setEnv("PASEO_CLOUD_MODE", "1");
    setEnv("ORCHESTRA_EXPOSE_GITHUB_TOKEN", "1");
    const notices = await resolveCloudProvisioningNotices({
      env: { GITHUB_TOKEN: "ghp_userset" },
      logger,
      getToken: reauth,
    });
    expect(notices).not.toContain(GITHUB_REAUTH_NOTICE);
  });

  it("does NOT warn about GitHub on a transient outage (token null, not needsReauth)", async () => {
    setEnv("PASEO_CLOUD_MODE", "1");
    setEnv("ORCHESTRA_EXPOSE_GITHUB_TOKEN", "1");
    const notices = await resolveCloudProvisioningNotices({ env: {}, logger, getToken: transient });
    expect(notices).not.toContain(GITHUB_REAUTH_NOTICE);
  });

  it("does NOT check GitHub when token exposure is disabled", async () => {
    setEnv("PASEO_CLOUD_MODE", "1");
    setEnv("ORCHESTRA_EXPOSE_GITHUB_TOKEN", undefined);
    let called = false;
    const notices = await resolveCloudProvisioningNotices({
      env: {},
      logger,
      getToken: async () => {
        called = true;
        return { token: null, needsReauth: true };
      },
    });
    expect(called).toBe(false);
    expect(notices).not.toContain(GITHUB_REAUTH_NOTICE);
  });

  it("emits the toolchain notice when the prefix is set but its bin dir is empty", async () => {
    setEnv("PASEO_CLOUD_MODE", "1");
    setEnv("PASEO_TOOLCHAIN_PREFIX", "/workspace/.toolchain");
    const notices = await resolveCloudProvisioningNotices({
      env: {},
      logger,
      getToken: healthy,
      toolchainBinPopulated: async () => false,
    });
    expect(notices).toContain(TOOLCHAIN_MISSING_NOTICE);
  });

  it("does NOT emit the toolchain notice when the bin dir is populated", async () => {
    setEnv("PASEO_CLOUD_MODE", "1");
    setEnv("PASEO_TOOLCHAIN_PREFIX", "/workspace/.toolchain");
    const notices = await resolveCloudProvisioningNotices({
      env: {},
      logger,
      toolchainBinPopulated: async () => true,
    });
    expect(notices).not.toContain(TOOLCHAIN_MISSING_NOTICE);
  });

  it("does not check the toolchain when no prefix is configured", async () => {
    setEnv("PASEO_CLOUD_MODE", "1");
    setEnv("PASEO_TOOLCHAIN_PREFIX", undefined);
    let checked = false;
    await resolveCloudProvisioningNotices({
      env: {},
      logger,
      toolchainBinPopulated: async () => {
        checked = true;
        return false;
      },
    });
    expect(checked).toBe(false);
  });

  it("surfaces BOTH notices when GitHub and the toolchain are both degraded", async () => {
    setEnv("PASEO_CLOUD_MODE", "1");
    setEnv("ORCHESTRA_EXPOSE_GITHUB_TOKEN", "1");
    setEnv("PASEO_TOOLCHAIN_PREFIX", "/workspace/.toolchain");
    const notices = await resolveCloudProvisioningNotices({
      env: {},
      logger,
      getToken: reauth,
      toolchainBinPopulated: async () => false,
    });
    expect(notices).toEqual([GITHUB_REAUTH_NOTICE, TOOLCHAIN_MISSING_NOTICE]);
  });
});
