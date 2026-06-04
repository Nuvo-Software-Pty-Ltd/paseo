import { describe, expect, test } from "vitest";

import type { PersistedProjectRecord } from "../workspace-registry.js";
import type { EnvVarStore, ScopedEnvVarRecord, ScopedEnvVarScope } from "./env-var-store.js";
import {
  createScopedEnvResolver,
  isReservedEnvVarKey,
  stripReservedKeys,
  validateEnvVarKeyValue,
} from "./scoped-env-resolver.js";

// Minimal in-memory store for resolver tests.
class FakeEnvVarStore implements EnvVarStore {
  private readonly rows: ScopedEnvVarRecord[] = [];

  seed(scope: ScopedEnvVarScope, scopeId: string, kv: Record<string, string>): void {
    for (const [key, value] of Object.entries(kv)) {
      this.rows.push({
        scope,
        scopeId,
        key,
        value,
        createdAt: "2026-06-04T00:00:00.000Z",
        updatedAt: "2026-06-04T00:00:00.000Z",
      });
    }
  }

  async listForScope(scope: ScopedEnvVarScope, scopeId: string): Promise<ScopedEnvVarRecord[]> {
    return this.rows.filter((r) => r.scope === scope && r.scopeId === scopeId);
  }
  async upsert(): Promise<void> {}
  async remove(): Promise<void> {}
}

function project(overrides: Partial<PersistedProjectRecord>): PersistedProjectRecord {
  return {
    projectId: overrides.projectId ?? "proj_1",
    rootPath: overrides.rootPath ?? "/repos/one",
    kind: overrides.kind ?? "git",
    displayName: overrides.displayName ?? "One",
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
    archivedAt: null,
    ...("workspaceId" in overrides ? { workspaceId: overrides.workspaceId } : {}),
    ...("repoUrl" in overrides ? { repoUrl: overrides.repoUrl } : {}),
  };
}

describe("createScopedEnvResolver", () => {
  test("merges workspace + project vars; both visible", async () => {
    const store = new FakeEnvVarStore();
    store.seed("workspace", "ws_local", { WS_VAR: "w" });
    store.seed("project", "proj_1", { PROJ_VAR: "p" });
    const resolve = createScopedEnvResolver({
      envStore: store,
      resolveProjectForCwd: async () => project({ projectId: "proj_1", workspaceId: "ws_local" }),
      ambientContainerId: () => "ws_local",
    });
    expect(await resolve("/repos/one")).toEqual({ WS_VAR: "w", PROJ_VAR: "p" });
  });

  test("project overrides workspace on a key set at both scopes (DECISION P-1)", async () => {
    const store = new FakeEnvVarStore();
    store.seed("workspace", "ws_local", { SHARED: "from-workspace" });
    store.seed("project", "proj_1", { SHARED: "from-project" });
    const resolve = createScopedEnvResolver({
      envStore: store,
      resolveProjectForCwd: async () => project({ projectId: "proj_1", workspaceId: "ws_local" }),
      ambientContainerId: () => "ws_local",
    });
    expect((await resolve("/repos/one")).SHARED).toBe("from-project");
  });

  test("workspace scope keys off the project RECORD's workspaceId, not a path id (fix #2)", async () => {
    const store = new FakeEnvVarStore();
    // Vars live under the container FK `ws_container_42`, NOT under the
    // project's rootPath. Only a resolver that dereferences
    // project.workspaceId finds them.
    store.seed("workspace", "ws_container_42", { CONTAINER_VAR: "yes" });
    const resolve = createScopedEnvResolver({
      envStore: store,
      resolveProjectForCwd: async () =>
        project({ projectId: "proj_1", rootPath: "/repos/one", workspaceId: "ws_container_42" }),
      // Ambient is a DIFFERENT id — if the resolver wrongly used it (or a
      // path id) the var would never resolve.
      ambientContainerId: () => "ws_other",
    });
    expect((await resolve("/repos/one")).CONTAINER_VAR).toBe("yes");
  });

  test("falls back to ambient container vars when cwd matches no project (OQ-2)", async () => {
    const store = new FakeEnvVarStore();
    store.seed("workspace", "ws_local", { WS_DEFAULT: "d" });
    store.seed("project", "proj_1", { PROJ_VAR: "p" });
    const resolve = createScopedEnvResolver({
      envStore: store,
      resolveProjectForCwd: async () => null,
      ambientContainerId: () => "ws_local",
    });
    // Workspace defaults present; no project vars.
    expect(await resolve("/somewhere/else")).toEqual({ WS_DEFAULT: "d" });
  });

  test("an unrelated project sees neither project's project-scoped var (isolation)", async () => {
    const store = new FakeEnvVarStore();
    store.seed("project", "proj_a", { ONLY_A: "a" });
    store.seed("project", "proj_b", { ONLY_B: "b" });
    const resolveFor = (rec: PersistedProjectRecord) =>
      createScopedEnvResolver({
        envStore: store,
        resolveProjectForCwd: async () => rec,
        ambientContainerId: () => "ws_local",
      });
    const aEnv = await resolveFor(project({ projectId: "proj_a", workspaceId: "ws_local" }))("/a");
    const bEnv = await resolveFor(project({ projectId: "proj_b", workspaceId: "ws_local" }))("/b");
    expect(aEnv).toEqual({ ONLY_A: "a" });
    expect(bEnv).toEqual({ ONLY_B: "b" });
  });

  test("strips reserved/platform keys a user tried to set (fix #1)", async () => {
    const store = new FakeEnvVarStore();
    store.seed("project", "proj_1", {
      ANTHROPIC_API_KEY: "stolen",
      PASEO_AGENT_ID: "spoof",
      MCP_TIMEOUT: "1",
      MCP_TOOL_TIMEOUT: "1",
      TERM: "dumb",
      ALLOWED: "ok",
    });
    const resolve = createScopedEnvResolver({
      envStore: store,
      resolveProjectForCwd: async () => project({ projectId: "proj_1", workspaceId: "ws_local" }),
      ambientContainerId: () => "ws_local",
    });
    expect(await resolve("/repos/one")).toEqual({ ALLOWED: "ok" });
  });

  test("agent and terminal share ONE resolver → byte-identical for the same cwd (P-2)", async () => {
    const store = new FakeEnvVarStore();
    store.seed("workspace", "ws_local", { WS_VAR: "w" });
    store.seed("project", "proj_1", { PROJ_VAR: "p" });
    const resolve = createScopedEnvResolver({
      envStore: store,
      resolveProjectForCwd: async () => project({ projectId: "proj_1", workspaceId: "ws_local" }),
      ambientContainerId: () => "ws_local",
    });
    // The agent injection site and the terminal injection site call the
    // SAME resolver instance with the same cwd.
    const agentEnv = await resolve("/repos/one");
    const terminalEnv = await resolve("/repos/one");
    expect(agentEnv).toEqual(terminalEnv);
  });
});

describe("reserved-key denylist (fix #1)", () => {
  test("MCP_TIMEOUT / MCP_TOOL_TIMEOUT are reserved (not covered by prefixes)", () => {
    expect(isReservedEnvVarKey("MCP_TIMEOUT")).toBe(true);
    expect(isReservedEnvVarKey("MCP_TOOL_TIMEOUT")).toBe(true);
  });

  test("prefix-covered platform keys are reserved", () => {
    expect(isReservedEnvVarKey("PASEO_AGENT_ID")).toBe(true);
    expect(isReservedEnvVarKey("ANTHROPIC_API_KEY")).toBe(true);
    expect(isReservedEnvVarKey("CLAUDE_CODE_FOO")).toBe(true);
    expect(isReservedEnvVarKey("TERM")).toBe(true);
    expect(isReservedEnvVarKey("ZDOTDIR")).toBe(true);
  });

  test("ordinary keys are not reserved", () => {
    expect(isReservedEnvVarKey("API_BASE")).toBe(false);
    expect(isReservedEnvVarKey("MY_TOKEN")).toBe(false);
  });

  test("stripReservedKeys removes reserved keys only", () => {
    expect(stripReservedKeys({ API_BASE: "x", MCP_TIMEOUT: "1", OK: "y" })).toEqual({
      API_BASE: "x",
      OK: "y",
    });
  });
});

describe("validateEnvVarKeyValue (RPC edge)", () => {
  test("accepts a valid key/value", () => {
    expect(validateEnvVarKeyValue({ key: "API_BASE", value: "https://x" })).toBeNull();
  });
  test("rejects empty / invalid charset / reserved keys", () => {
    expect(validateEnvVarKeyValue({ key: "", value: "v" })).toBe("empty");
    expect(validateEnvVarKeyValue({ key: "1BAD", value: "v" })).toBe("invalid_charset");
    expect(validateEnvVarKeyValue({ key: "has space", value: "v" })).toBe("invalid_charset");
    expect(validateEnvVarKeyValue({ key: "MCP_TIMEOUT", value: "v" })).toBe("reserved");
    expect(validateEnvVarKeyValue({ key: "PASEO_AGENT_ID", value: "v" })).toBe("reserved");
  });
  test("rejects an over-long value", () => {
    expect(validateEnvVarKeyValue({ key: "OK", value: "x".repeat(40_000) })).toBe("value_too_long");
  });
});
