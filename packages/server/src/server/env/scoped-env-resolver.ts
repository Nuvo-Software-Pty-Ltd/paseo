import type { Logger } from "pino";

import { buildToolchainEnvDefaults, isPaseoCloudMode } from "../paseo-env.js";
import { DEFAULT_CONTAINER_WORKSPACE_ID } from "../workspace-registry.js";
import type { PersistedProjectRecord } from "../workspace-registry.js";
import type { EnvVarStore, ScopedEnvVarRecord } from "./env-var-store.js";

// D-3.5c — the shared resolver at the heart of scoped env vars. ONE
// `resolveScopedEnv(cwd)` is used by BOTH the agent injection site
// (`buildLaunchContext`) and the terminal injection site
// (`handleCreateTerminalRequest`), so resolution is byte-identical for the
// same cwd (DECISION P-2). The only per-site difference is the delivery
// mechanism (agent: an overlay in `launchContext.env`; terminal: the
// `input.env` overlay) — the resolved SET is identical.
//
// Precedence (DECISION P-1): project overrides workspace. Resolution is a
// two-layer overlay `{ ...workspaceVars, ...projectVars }` (project applied
// last). A workspace var is the broad default; a project var is a
// deliberate, local override.
//
// Open-core: no `if (cloud)` branch in the resolver. The cloud/on-host
// difference is entirely in WHICH store backs `envStore` (file vs Dynamo,
// swapped at construction), which ambient container id is returned, and
// whether `PASEO_TOOLCHAIN_PREFIX` is set (the BYO-runtimes L0 toolchain
// overlay — a deployment-config value, NOT a cloud branch; see
// `buildToolchainEnvDefaults` in paseo-env.ts). All three are config/store
// choices, never an `isPaseoCloudMode()` fork in the resolution logic.

// ---- Reserved-key denylist (DECISION P-1, defense-in-depth) ------------
//
// User-scoped vars are a LOW-precedence overlay: above base `process.env`
// but below the platform/credential overlays. The denylist strips
// platform-reserved keys from the user set BEFORE it is applied, so a
// scoped var can never shadow the cloud-injected credential, `PASEO_AGENT_ID`,
// the MCP timeouts, or `TERM`/`ZDOTDIR`.
//
// VERIFY-3.5c fix #1: `MCP_TIMEOUT`/`MCP_TOOL_TIMEOUT` are NOT covered by
// the `PASEO_*`/`ANTHROPIC_*`/`CLAUDE_CODE_*` prefixes, and on Claude the
// scoped overlay (`launchEnv`, overlay #3) is applied AFTER the MCP-timeout
// overlay (#2) — so without an explicit entry a user-set `MCP_TIMEOUT`
// WOULD override the platform value. They are listed explicitly below.
const RESERVED_ENV_KEY_PREFIXES = ["PASEO_", "ANTHROPIC_", "CLAUDE_CODE_"] as const;

const RESERVED_ENV_KEYS = new Set<string>([
  // Platform MCP-timeout overlay (claude/agent.ts) — explicit, not
  // prefix-covered (VERIFY-3.5c fix #1).
  "MCP_TIMEOUT",
  "MCP_TOOL_TIMEOUT",
  // Terminal platform overlays (terminal.ts) — applied after input.env,
  // but stripped here too as defense-in-depth.
  "TERM",
  "ZDOTDIR",
  // createExternalProcessEnv runtime-control keys not covered by the
  // PASEO_ prefix (paseo-env.ts RUNTIME_CONTROL_ENV_KEYS).
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
]);

// Env var names are case-sensitive on POSIX, so this check is too.
export function isReservedEnvVarKey(key: string): boolean {
  if (RESERVED_ENV_KEYS.has(key)) {
    return true;
  }
  return RESERVED_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

const ENV_VAR_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_KEY_MAX_LENGTH = 128;
const ENV_VAR_VALUE_MAX_LENGTH = 32_768;

export type EnvVarKeyValidationError =
  | "empty"
  | "too_long"
  | "invalid_charset"
  | "reserved"
  | "value_too_long";

// Validates a key/value at the RPC edge (T-2). Returns the first failing
// rule, or null when the pair is acceptable to store. Kept here so the
// resolver's reserved-key list is the single source of truth shared by the
// write path and the defense-in-depth read-path strip.
export function validateEnvVarKeyValue(input: {
  key: string;
  value: string;
}): EnvVarKeyValidationError | null {
  const { key, value } = input;
  if (key.length === 0) {
    return "empty";
  }
  if (key.length > ENV_VAR_KEY_MAX_LENGTH) {
    return "too_long";
  }
  if (!ENV_VAR_KEY_PATTERN.test(key)) {
    return "invalid_charset";
  }
  if (isReservedEnvVarKey(key)) {
    return "reserved";
  }
  if (value.length > ENV_VAR_VALUE_MAX_LENGTH) {
    return "value_too_long";
  }
  return null;
}

// Strips platform-reserved keys from a resolved overlay (DECISION P-1).
export function stripReservedKeys(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (isReservedEnvVarKey(key)) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

// The ambient container id used when a cwd matches no known project
// (DECISION resolver fallback / OQ-2). Cloud: the ambient
// `PASEO_WORKSPACE_ID`; on-host: the 3.5a default container `ws_local`.
export function resolveAmbientContainerId(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (isPaseoCloudMode(env)) {
    return env.PASEO_WORKSPACE_ID?.trim() || undefined;
  }
  return DEFAULT_CONTAINER_WORKSPACE_ID;
}

function toMap(records: ScopedEnvVarRecord[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const record of records) {
    map[record.key] = record.value;
  }
  return map;
}

export interface ScopedEnvResolverDeps {
  envStore: EnvVarStore;
  // Maps a cwd to its 3.5a Project record (or null if the cwd is outside
  // every known project). VERIFY-3.5c fix #2: the workspace scope MUST key
  // off the returned record's `workspaceId` (the 3.5a containment FK — see
  // PLAN-3.5a-daemon DECISION D-1), NEVER a per-cwd path id like
  // `classifyDirectoryForProjectMembership(...).workspaceId`, which on-host
  // is a normalized path string and would make workspace-scoped vars
  // silently never resolve.
  resolveProjectForCwd: (cwd: string) => Promise<PersistedProjectRecord | null>;
  ambientContainerId?: () => string | undefined;
  // BYO-runtimes L0 — the userspace-toolchain env overlay (HOME/TMPDIR/
  // caches/PATH-prepend), layered BELOW user scoped vars so a user var still
  // overrides a default. Defaults to `buildToolchainEnvDefaults()` (driven by
  // `PASEO_TOOLCHAIN_PREFIX`); injectable for tests. Returns `{}` when the
  // prefix is unset (on-host/desktop), so the resolved set is unchanged there.
  toolchainDefaults?: () => Record<string, string>;
  logger?: Logger;
}

export type ScopedEnvResolver = (cwd: string) => Promise<Record<string, string>>;

export function createScopedEnvResolver(deps: ScopedEnvResolverDeps): ScopedEnvResolver {
  const ambient = deps.ambientContainerId ?? (() => resolveAmbientContainerId());
  const toolchainDefaults = deps.toolchainDefaults ?? (() => buildToolchainEnvDefaults());
  const logger = deps.logger?.child({ component: "scoped-env-resolver" });

  return async function resolveScopedEnv(cwd: string): Promise<Record<string, string>> {
    let project: PersistedProjectRecord | null = null;
    try {
      project = await deps.resolveProjectForCwd(cwd);
    } catch (err) {
      // Never block a spawn on env resolution — fail to "no scoped vars".
      logger?.warn({ err, cwd }, "Failed to resolve project for scoped env; using ambient only");
    }

    // VERIFY-3.5c fix #2: workspace scope keys off the project record's
    // containment FK, not a per-cwd path id.
    const workspaceId = project?.workspaceId ?? ambient();

    const [wsVars, projVars] = await Promise.all([
      workspaceId
        ? deps.envStore.listForScope("workspace", workspaceId).then(toMap)
        : Promise.resolve<Record<string, string>>({}),
      project
        ? deps.envStore.listForScope("project", project.projectId).then(toMap)
        : Promise.resolve<Record<string, string>>({}),
    ]);

    // DECISION P-1: project overrides workspace. BYO-runtimes L0: the
    // toolchain defaults sit BELOW both user scopes, so a user-set
    // PATH/TMPDIR/HOME overrides the default, while the default fills in when
    // the user hasn't set one. Reserved keys are still stripped from the
    // final set (the defaults use no reserved keys).
    const merged = { ...toolchainDefaults(), ...wsVars, ...projVars };
    return stripReservedKeys(merged);
  };
}
