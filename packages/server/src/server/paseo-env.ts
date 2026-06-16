const PASEO_NODE_ENV = "PASEO_NODE_ENV";
const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";

const RUNTIME_CONTROL_ENV_KEYS = [
  PASEO_NODE_ENV,
  "PASEO_DESKTOP_MANAGED",
  "PASEO_SUPERVISED",
  ELECTRON_RUN_AS_NODE,
  "ELECTRON_NO_ATTACH_CONSOLE",
] as const;

export type PaseoNodeEnv = "development" | "production" | "test";
export type ProcessEnvRecord = Record<string, string | undefined>;
export type ExternalProcessEnv = NodeJS.ProcessEnv & Record<string, string>;

function buildInternalProcessEnv<T extends ProcessEnvRecord>(baseEnv: T): T {
  return { ...baseEnv };
}

function buildExternalProcessEnv(
  baseEnv: ProcessEnvRecord,
  overlays: ProcessEnvRecord[],
): ExternalProcessEnv {
  const sanitized = Object.assign({}, baseEnv, ...overlays);
  for (const key of RUNTIME_CONTROL_ENV_KEYS) {
    delete sanitized[key];
  }
  for (const [key, value] of Object.entries(sanitized)) {
    if (value === undefined) {
      delete sanitized[key];
    }
  }
  return sanitized as ExternalProcessEnv;
}

export function createPaseoInternalEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return buildInternalProcessEnv(baseEnv);
}

export function createExternalProcessEnv(
  baseEnv: ProcessEnvRecord,
  ...overlays: ProcessEnvRecord[]
): ExternalProcessEnv {
  return buildExternalProcessEnv(baseEnv, overlays);
}

export function createExternalCommandProcessEnv(
  _command: string,
  baseEnv: ProcessEnvRecord,
  ...overlays: ProcessEnvRecord[]
): ExternalProcessEnv {
  // Deprecated command parameter: retained while callers migrate to createExternalProcessEnv.
  return buildExternalProcessEnv(baseEnv, overlays);
}

export function buildSelfNodeCommand(
  args: string[],
  envOverlay?: ProcessEnvRecord,
): {
  command: string;
  args: string[];
  env: ExternalProcessEnv;
} {
  const env = buildExternalProcessEnv(process.env, []);
  Object.assign(env, { [ELECTRON_RUN_AS_NODE]: "1" }, envOverlay);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }
  return {
    command: process.execPath,
    args,
    env,
  };
}

export function resolvePaseoNodeEnv(env: NodeJS.ProcessEnv): PaseoNodeEnv | undefined {
  const value = env[PASEO_NODE_ENV];
  return value === "development" || value === "production" || value === "test" ? value : undefined;
}

// Single source of truth for "is the daemon running in SaaS cloud-mode?"
// Only exact "1" enables cloud mode — keeps the discriminator unambiguous and avoids
// the prior-attempt F11 footgun where overloaded discriminators silently collapse.
export function isPaseoCloudMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PASEO_CLOUD_MODE === "1";
}

// D-3.5a (T-6) — which project sources the GitHub picker should offer.
// This is a DEPLOYMENT-CONFIG value the core honors, NOT a cloud branch:
// open-core discipline forbids gating the picker policy on
// `isPaseoCloudMode()`. Self-host defaults to "local_and_github"; cloud
// injects PASEO_PROJECT_SOURCE=github_only at RunTask. A self-host operator
// may set "local_only" to disable the GitHub source entirely.
export type ProjectSource = "local_and_github" | "github_only" | "local_only";

const PROJECT_SOURCE_VALUES: readonly ProjectSource[] = [
  "local_and_github",
  "github_only",
  "local_only",
];

export function resolveProjectSource(env: NodeJS.ProcessEnv = process.env): ProjectSource {
  const raw = env.PASEO_PROJECT_SOURCE?.trim();
  if (raw && (PROJECT_SOURCE_VALUES as readonly string[]).includes(raw)) {
    return raw as ProjectSource;
  }
  return "local_and_github";
}

// BYO-runtimes L0 — userspace toolchain env defaults. Like
// `resolveProjectSource`, this is a DEPLOYMENT-CONFIG value the core honors,
// NOT a cloud branch: open-core discipline forbids gating on
// `isPaseoCloudMode()`. The cloud RunTask injects
// `PASEO_TOOLCHAIN_PREFIX=/workspace/.toolchain` (the only writable+executable
// surface in the hardened container is `/workspace`); a self-host operator may
// set it to any writable dir to opt in, or leave it unset (the default) to
// disable the behavior entirely. When unset this returns `{}` so on-host /
// desktop env is byte-unchanged.
//
// The returned map is layered as a LOW-precedence overlay (below user scoped
// env-vars and below the platform/credential overlays — see
// scoped-env-resolver.ts). It points HOME/TMPDIR/caches at the prefix and
// PREPENDS the toolchain bin dirs onto the inherited PATH, so a runtime a user
// installs under the prefix (Node tarball, uv+CPython, micromamba, `npm -g`)
// is found by the agent, terminals, and `worktree.setup`. `TMPDIR` is moved
// off the `noexec` `/tmp` onto the prefix so installers that extract+exec
// temp binaries work. PATH is read at call time so the prepend composes on the
// real container PATH (idempotent: process.env.PATH never contains the prefix).
export function buildToolchainEnvDefaults(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const prefix = env.PASEO_TOOLCHAIN_PREFIX?.trim();
  if (!prefix) {
    return {};
  }
  const pathPrepend = [
    `${prefix}/bin`,
    `${prefix}/npm-global/bin`,
    `${prefix}/node/bin`,
    `${prefix}/uv/bin`,
  ].join(":");
  const basePath = env.PATH ?? "";
  return {
    // HOME points at a writable dir under the prefix. For terminals this is
    // the effective HOME; for the Claude agent the per-spawn credential
    // overlay (cloud-credentials.ts materializeClaudeHome) is applied AFTER
    // the scoped overlay and overrides this, keeping agent HOME isolated.
    HOME: `${prefix}/home`,
    TMPDIR: `${prefix}/tmp`,
    NPM_CONFIG_PREFIX: `${prefix}/npm-global`,
    NPM_CONFIG_CACHE: `${prefix}/npm-cache`,
    XDG_CACHE_HOME: `${prefix}/cache`,
    XDG_DATA_HOME: `${prefix}/data`,
    MISE_DATA_DIR: `${prefix}/mise`,
    MISE_CACHE_DIR: `${prefix}/cache/mise`,
    UV_INSTALL_DIR: `${prefix}/uv/bin`,
    UV_PYTHON_INSTALL_DIR: `${prefix}/uv/python`,
    UV_CACHE_DIR: `${prefix}/cache/uv`,
    PATH: basePath ? `${pathPrepend}:${basePath}` : pathPrepend,
  };
}
