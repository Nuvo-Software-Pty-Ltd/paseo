import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSelfNodeCommand,
  buildToolchainEnvDefaults,
  createExternalCommandProcessEnv,
  createExternalProcessEnv,
  createPaseoInternalEnv,
  ensureToolchainDirs,
  isPaseoCloudMode,
  resolvePaseoNodeEnv,
  resolveProjectSource,
} from "./paseo-env.js";

describe("resolveProjectSource (D-3.5a T-6)", () => {
  test("defaults to local_and_github when PASEO_PROJECT_SOURCE is unset", () => {
    expect(resolveProjectSource({})).toBe("local_and_github");
  });

  test("honors github_only verbatim (the cloud-injected value)", () => {
    expect(resolveProjectSource({ PASEO_PROJECT_SOURCE: "github_only" })).toBe("github_only");
  });

  test("honors local_only (self-host operator disabling GitHub)", () => {
    expect(resolveProjectSource({ PASEO_PROJECT_SOURCE: "local_only" })).toBe("local_only");
  });

  test("falls back to local_and_github for an unrecognized value", () => {
    expect(resolveProjectSource({ PASEO_PROJECT_SOURCE: "bogus" })).toBe("local_and_github");
  });

  test("does NOT consult cloud mode — github_only is config-driven, not isPaseoCloudMode()", () => {
    // Cloud-mode set but no project-source config → still the safe default.
    expect(resolveProjectSource({ PASEO_CLOUD_MODE: "1" })).toBe("local_and_github");
  });
});

describe("buildToolchainEnvDefaults (BYO-runtimes L0)", () => {
  test("returns {} when PASEO_TOOLCHAIN_PREFIX is unset (on-host/desktop unchanged)", () => {
    expect(buildToolchainEnvDefaults({})).toEqual({});
  });

  test("treats a whitespace-only prefix as unset (config-driven, not isPaseoCloudMode)", () => {
    expect(buildToolchainEnvDefaults({ PASEO_TOOLCHAIN_PREFIX: "   " })).toEqual({});
    // Cloud-mode alone does NOT enable it — only the prefix does.
    expect(buildToolchainEnvDefaults({ PASEO_CLOUD_MODE: "1" })).toEqual({});
  });

  test("builds the toolchain overlay rooted at the prefix (no HOME — agent isolation)", () => {
    const env = buildToolchainEnvDefaults({
      PASEO_TOOLCHAIN_PREFIX: "/workspace/.toolchain",
      PATH: "/usr/bin",
    });
    // Deliberately NO HOME — setting it here would override the agent's
    // per-spawn credential HOME (proven by the 2026-06-16 capture).
    expect(env.HOME).toBeUndefined();
    expect(env.TMPDIR).toBe("/workspace/.toolchain/tmp");
    expect(env.NPM_CONFIG_PREFIX).toBe("/workspace/.toolchain/npm-global");
    expect(env.XDG_CONFIG_HOME).toBe("/workspace/.toolchain/config");
    expect(env.XDG_CACHE_HOME).toBe("/workspace/.toolchain/cache");
    expect(env.UV_INSTALL_DIR).toBe("/workspace/.toolchain/uv/bin");
    expect(env.MAMBA_ROOT_PREFIX).toBe("/workspace/.toolchain/micromamba");
  });

  test("PREPENDS the toolchain bin dirs onto the inherited PATH", () => {
    const env = buildToolchainEnvDefaults({ PASEO_TOOLCHAIN_PREFIX: "/tc", PATH: "/usr/bin" });
    expect(env.PATH).toBe("/tc/bin:/tc/npm-global/bin:/tc/node/bin:/tc/uv/bin:/usr/bin");
  });

  test("PATH has no trailing colon when the base PATH is empty", () => {
    expect(buildToolchainEnvDefaults({ PASEO_TOOLCHAIN_PREFIX: "/tc" }).PATH).toBe(
      "/tc/bin:/tc/npm-global/bin:/tc/node/bin:/tc/uv/bin",
    );
  });
});

describe("ensureToolchainDirs (BYO-runtimes L0 dir materialization)", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "paseo-toolchain-"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("creates the toolchain dir tree incl TMPDIR (the claude-settings ENOENT site)", async () => {
    const prefix = join(base, ".toolchain");
    await ensureToolchainDirs({ PASEO_TOOLCHAIN_PREFIX: prefix, PATH: "/usr/bin" });
    // TMPDIR = ${prefix}/tmp is where the Claude Code CLI writes claude-settings-<hash>.json.
    expect(existsSync(join(prefix, "tmp"))).toBe(true);
    // a PATH-prepend bin dir and a nested cache dir, to prove the full tree is made.
    expect(existsSync(join(prefix, "npm-global", "bin"))).toBe(true);
    expect(existsSync(join(prefix, "cache", "uv"))).toBe(true);
  });

  test("is a no-op when PASEO_TOOLCHAIN_PREFIX is unset (on-host/desktop)", async () => {
    await expect(ensureToolchainDirs({})).resolves.toBeUndefined();
    expect(readdirSync(base)).toHaveLength(0);
  });

  test("is idempotent — safe to call on every boot", async () => {
    const prefix = join(base, ".toolchain");
    await ensureToolchainDirs({ PASEO_TOOLCHAIN_PREFIX: prefix });
    await expect(ensureToolchainDirs({ PASEO_TOOLCHAIN_PREFIX: prefix })).resolves.toBeUndefined();
    expect(existsSync(join(prefix, "tmp"))).toBe(true);
  });
});

describe("paseo env contract", () => {
  const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";
  const PASEO_NODE_ENV = "PASEO_NODE_ENV";
  const baseEnv = {
    [ELECTRON_RUN_AS_NODE]: "1",
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    NODE_ENV: "development",
    PATH: "/usr/bin",
    PASEO_AGENT_ID: "agent-123",
    PASEO_DESKTOP_MANAGED: "1",
    [PASEO_NODE_ENV]: "production",
    PASEO_SUPERVISED: "1",
  };
  const runtimeControlEnvKeys = [
    "ELECTRON_RUN_AS_NODE",
    "PASEO_NODE_ENV",
    "PASEO_DESKTOP_MANAGED",
    "PASEO_SUPERVISED",
    "ELECTRON_NO_ATTACH_CONSOLE",
  ] as const;

  test("builds internal daemon child env by preserving pass-through and control vars", () => {
    const env = createPaseoInternalEnv(baseEnv);

    expect(env).toMatchObject({
      [ELECTRON_RUN_AS_NODE]: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      NODE_ENV: "development",
      PATH: "/usr/bin",
      PASEO_DESKTOP_MANAGED: "1",
      [PASEO_NODE_ENV]: "production",
      PASEO_SUPERVISED: "1",
      PASEO_AGENT_ID: "agent-123",
    });
  });

  test("builds external process env by scrubbing runtime control vars after overlays", () => {
    const env = createExternalProcessEnv(baseEnv, {
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      ELECTRON_RUN_AS_NODE: "0",
      EXTRA_VALUE: "from-overlay",
      PASEO_DESKTOP_MANAGED: "1",
      PASEO_NODE_ENV: "test",
      PASEO_SUPERVISED: "1",
      PATH: "/custom/bin",
    });

    for (const key of runtimeControlEnvKeys) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.NODE_ENV).toBe("development");
    expect(env.PASEO_AGENT_ID).toBe("agent-123");
    expect(env.PATH).toBe("/custom/bin");
  });

  test("applies non-control overlays to external process env", () => {
    const env = createExternalProcessEnv(baseEnv, { PATH: "/custom/bin" }, { CUSTOM: "value" });

    expect(env.CUSTOM).toBe("value");
    expect(env.NODE_ENV).toBe("development");
    expect(env.PATH).toBe("/custom/bin");
  });

  test("builds external command env without process.execPath special-casing", () => {
    const env = createExternalCommandProcessEnv(process.execPath, baseEnv, {
      ELECTRON_RUN_AS_NODE: "0",
      PASEO_NODE_ENV: "test",
    });

    expect(env[ELECTRON_RUN_AS_NODE]).toBeUndefined();
    expect(env.NODE_ENV).toBe("development");
    expect(env.PASEO_AGENT_ID).toBe("agent-123");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
    expect(env.PASEO_DESKTOP_MANAGED).toBeUndefined();
    expect(env[PASEO_NODE_ENV]).toBeUndefined();
    expect(env.PASEO_SUPERVISED).toBeUndefined();
  });

  test("builds self node command with Electron node mode", () => {
    const command = buildSelfNodeCommand(["script.js"], {
      CUSTOM: "value",
    });

    expect(command.command).toBe(process.execPath);
    expect(command.args).toEqual(["script.js"]);
    expect(command.env[ELECTRON_RUN_AS_NODE]).toBe("1");
    expect(command.env.CUSTOM).toBe("value");
    expect(command.env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
    expect(command.env.PASEO_DESKTOP_MANAGED).toBeUndefined();
    expect(command.env[PASEO_NODE_ENV]).toBeUndefined();
    expect(command.env.PASEO_SUPERVISED).toBeUndefined();
  });

  test("does not add Electron node mode for non-execPath commands", () => {
    const env = createExternalCommandProcessEnv("node", baseEnv, {
      ELECTRON_RUN_AS_NODE: "1",
    });

    expect(env[ELECTRON_RUN_AS_NODE]).toBeUndefined();
  });

  test("does not use user NODE_ENV as Paseo runtime mode", () => {
    expect(resolvePaseoNodeEnv({ NODE_ENV: "development" })).toBeUndefined();
    expect(resolvePaseoNodeEnv({ NODE_ENV: "development", PASEO_NODE_ENV: "production" })).toBe(
      "production",
    );
    expect(resolvePaseoNodeEnv({ NODE_ENV: "test", PASEO_NODE_ENV: "local" })).toBeUndefined();
  });
});

describe("isPaseoCloudMode", () => {
  test("returns true when PASEO_CLOUD_MODE is exactly '1'", () => {
    expect(isPaseoCloudMode({ PASEO_CLOUD_MODE: "1" })).toBe(true);
  });

  test("returns false when PASEO_CLOUD_MODE is unset", () => {
    expect(isPaseoCloudMode({})).toBe(false);
  });

  test("returns false for truthy-looking values other than '1'", () => {
    // Single-boolean discipline: only exactly "1" enables cloud mode.
    // Anything else is rejected to keep the discriminator unambiguous.
    expect(isPaseoCloudMode({ PASEO_CLOUD_MODE: "true" })).toBe(false);
    expect(isPaseoCloudMode({ PASEO_CLOUD_MODE: "yes" })).toBe(false);
    expect(isPaseoCloudMode({ PASEO_CLOUD_MODE: "0" })).toBe(false);
    expect(isPaseoCloudMode({ PASEO_CLOUD_MODE: "" })).toBe(false);
  });
});
