import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => {
  const store = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve();
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
        return Promise.resolve();
      }),
    },
  };
});

vi.mock("@/constants/platform", () => ({ isWeb: true, isNative: false }));

import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  storeSessionToken,
  clearSession,
  hasSession,
  listWorkspaces,
  createWorkspace,
  setAnthropicCredential,
  mintWorkspaceToken,
  listGithubRepos,
  archiveCloudWorkspace,
  unarchiveCloudWorkspace,
  getCloudProvidersSnapshot,
  normalizeCloudProvidersSnapshot,
  OrchestraSessionExpiredError,
  getAuthBaseUrl,
} from "./orchestra-cloud-client";

const TOKEN = "test-session-jwt";

beforeEach(async () => {
  vi.clearAllMocks();
  await AsyncStorage.removeItem("orchestra:session_token");
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(status: number, body: unknown): void {
  (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe("getAuthBaseUrl", () => {
  it("defaults to the HTTPS auth subdomain when env var is unset", () => {
    const saved = process.env.EXPO_PUBLIC_ORCHESTRA_AUTH_URL;
    delete process.env.EXPO_PUBLIC_ORCHESTRA_AUTH_URL;
    expect(getAuthBaseUrl()).toBe("https://auth.dev.orchestra.nuvo.software");
    process.env.EXPO_PUBLIC_ORCHESTRA_AUTH_URL = saved;
  });

  it("uses the env var when set", () => {
    process.env.EXPO_PUBLIC_ORCHESTRA_AUTH_URL = "https://auth.staging.orchestra.nuvo.software";
    expect(getAuthBaseUrl()).toBe("https://auth.staging.orchestra.nuvo.software");
    delete process.env.EXPO_PUBLIC_ORCHESTRA_AUTH_URL;
  });
});

describe("session management", () => {
  it("stores and retrieves a session token", async () => {
    expect(await hasSession()).toBe(false);
    await storeSessionToken(TOKEN);
    expect(await hasSession()).toBe(true);
  });

  it("clears the session token", async () => {
    await storeSessionToken(TOKEN);
    await clearSession();
    expect(await hasSession()).toBe(false);
  });
});

describe("listWorkspaces", () => {
  it("calls GET /api/v1/cloud/workspaces with auth header", async () => {
    await storeSessionToken(TOKEN);
    const workspaces = [{ workspaceId: "ws_001", status: "ready" }];
    mockFetch(200, { workspaces });

    const result = await listWorkspaces();

    expect(result).toHaveLength(1);
    expect(result[0].workspaceId).toBe("ws_001");
    expect(global.fetch).toHaveBeenCalledOnce();
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/api/v1/cloud/workspaces");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("throws OrchestraSessionExpiredError on 401", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(401, { error: "unauthorized" });

    await expect(listWorkspaces()).rejects.toThrow(OrchestraSessionExpiredError);
  });

  it("throws when no session token is stored", async () => {
    await expect(listWorkspaces()).rejects.toThrow(OrchestraSessionExpiredError);
  });

  it("defaults state to 'active' and archivedAt to null when the wire omits them", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(200, {
      workspaces: [{ workspaceId: "ws_legacy" }],
    });

    const [row] = await listWorkspaces();
    expect(row.state).toBe("active");
    expect(row.archivedAt).toBeNull();
  });

  it("parses every cloud workspace state plus archivedAt", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(200, {
      workspaces: [
        { workspaceId: "ws_a", state: "active", archivedAt: null },
        { workspaceId: "ws_s", state: "suspended", archivedAt: null },
        {
          workspaceId: "ws_b",
          state: "billing_locked",
          archivedAt: null,
        },
        {
          workspaceId: "ws_x",
          state: "archived",
          archivedAt: "2026-05-20T12:00:00.000Z",
        },
      ],
    });

    const rows = await listWorkspaces();
    expect(rows.map((row) => row.state)).toEqual([
      "active",
      "suspended",
      "billing_locked",
      "archived",
    ]);
    expect(rows[3].archivedAt).toBe("2026-05-20T12:00:00.000Z");
  });

  it("falls back to 'active' when state is an unrecognized value (forward-compat)", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(200, {
      workspaces: [{ workspaceId: "ws_future", state: "exploding" }],
    });
    const [row] = await listWorkspaces();
    expect(row.state).toBe("active");
  });
});

describe("createWorkspace", () => {
  it("calls POST /api/v1/cloud/workspaces with repo URL", async () => {
    await storeSessionToken(TOKEN);
    const workspace = { workspaceId: "ws_002", status: "provisioning" };
    mockFetch(201, workspace);

    const result = await createWorkspace({
      repoUrl: "https://github.com/user/repo",
      displayName: "My Repo",
    });

    expect(result.workspaceId).toBe("ws_002");
    expect(result.state).toBe("active");
    expect(result.archivedAt).toBeNull();
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/api/v1/cloud/workspaces");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      repoUrl: "https://github.com/user/repo",
      displayName: "My Repo",
    });
  });
});

describe("setAnthropicCredential", () => {
  it("calls POST with apiKey", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(200, { status: "ok" });

    const result = await setAnthropicCredential("ws_002", "sk-ant-test");

    expect(result).toEqual({ status: "ok" });
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/api/v1/cloud/workspaces/ws_002/anthropic-credential");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ apiKey: "sk-ant-test" });
  });
});

describe("mintWorkspaceToken", () => {
  it("200 → active variant with token + expiresAt", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(200, { token: "ws-jwt", expiresAt: 1234567890 });

    const result = await mintWorkspaceToken("ws_002");

    expect(result).toEqual({ status: "active", token: "ws-jwt", expiresAt: 1234567890 });
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/api/v1/cloud/workspaces/ws_002/token");
    expect(init.method).toBe("POST");
  });

  it("200 with missing token throws (defensive — the server contract guarantees it)", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(200, { expiresAt: 1 });
    await expect(mintWorkspaceToken("ws_002")).rejects.toThrow(/missing token/);
  });

  it("202 → resuming variant with retryAfterMs (lifecycle worker signaled to wake the daemon)", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(202, { resuming: true, retryAfterMs: 1500 });

    expect(await mintWorkspaceToken("ws_002")).toEqual({ status: "resuming", retryAfterMs: 1500 });
  });

  it("202 with no retryAfterMs falls back to 1500 ms default", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(202, { resuming: true });
    expect(await mintWorkspaceToken("ws_002")).toEqual({ status: "resuming", retryAfterMs: 1500 });
  });

  it("402 → billing_locked variant with reactivateUrl", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(402, {
      error: "Plan inactive",
      reactivateUrl: "https://orchestra.example/billing",
    });
    expect(await mintWorkspaceToken("ws_002")).toEqual({
      status: "billing_locked",
      reactivateUrl: "https://orchestra.example/billing",
    });
  });

  it("402 with null reactivateUrl is preserved as null", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(402, { error: "Plan inactive", reactivateUrl: null });
    expect(await mintWorkspaceToken("ws_002")).toEqual({
      status: "billing_locked",
      reactivateUrl: null,
    });
  });

  it("503 → provisioning variant with retryAfterMs (Day-0 first-connect path)", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(503, { error: "Workspace still provisioning", retryAfterMs: 2000 });
    expect(await mintWorkspaceToken("ws_002")).toEqual({
      status: "provisioning",
      retryAfterMs: 2000,
    });
  });

  it("409 with canUnarchive disambiguates to archived", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(409, { error: "Workspace is archived", canUnarchive: true });
    expect(await mintWorkspaceToken("ws_002")).toEqual({
      status: "archived",
      canUnarchive: true,
    });
  });

  it("409 with retryable disambiguates to provisioning_failed", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(409, { error: "Workspace failed to start", retryable: true });
    expect(await mintWorkspaceToken("ws_002")).toEqual({
      status: "provisioning_failed",
      retryable: true,
    });
  });

  it("409 with neither disambiguating key throws (unknown 409 shape)", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(409, { error: "Some new conflict shape" });
    await expect(mintWorkspaceToken("ws_002")).rejects.toThrow(
      /Failed to mint workspace token: 409/,
    );
  });

  it("401 throws OrchestraSessionExpiredError (auth seam unchanged)", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(401, { error: "unauthorized" });
    await expect(mintWorkspaceToken("ws_002")).rejects.toThrow(OrchestraSessionExpiredError);
  });

  it("500 (and other unexpected codes) throws with the status code", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(500, "internal error");
    await expect(mintWorkspaceToken("ws_002")).rejects.toThrow(
      /Failed to mint workspace token: 500/,
    );
  });
});

describe("archiveCloudWorkspace", () => {
  it("calls POST /api/v1/cloud/workspaces/:id/archive and normalizes the response", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(200, {
      workspaceId: "ws_007",
      state: "archived",
      archivedAt: "2026-05-22T01:00:00.000Z",
    });

    const result = await archiveCloudWorkspace("ws_007");

    expect(result.state).toBe("archived");
    expect(result.archivedAt).toBe("2026-05-22T01:00:00.000Z");
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/api/v1/cloud/workspaces/ws_007/archive");
    expect(init.method).toBe("POST");
  });

  it("throws OrchestraSessionExpiredError on 401", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(401, { error: "unauthorized" });
    await expect(archiveCloudWorkspace("ws_007")).rejects.toThrow(OrchestraSessionExpiredError);
  });

  it("throws with body details on server error", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(500, "boom");
    await expect(archiveCloudWorkspace("ws_007")).rejects.toThrow(/500/);
  });
});

describe("unarchiveCloudWorkspace", () => {
  it("calls POST /api/v1/cloud/workspaces/:id/unarchive and normalizes the response", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(200, { workspaceId: "ws_007", state: "active", archivedAt: null });

    const result = await unarchiveCloudWorkspace("ws_007");

    expect(result.state).toBe("active");
    expect(result.archivedAt).toBeNull();
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/api/v1/cloud/workspaces/ws_007/unarchive");
    expect(init.method).toBe("POST");
  });

  it("throws OrchestraSessionExpiredError on 401", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(401, { error: "unauthorized" });
    await expect(unarchiveCloudWorkspace("ws_007")).rejects.toThrow(OrchestraSessionExpiredError);
  });
});

describe("getCloudProvidersSnapshot", () => {
  it("fetches GET /api/v1/cloud/providers/snapshot WITHOUT auth header", async () => {
    const snapshot = {
      version: "2026.05-1",
      generatedAt: "2026-05-26T00:00:00.000Z",
      providers: [
        {
          id: "anthropic",
          displayName: "Anthropic Claude",
          models: [
            {
              id: "claude-opus-4-7",
              displayName: "Opus 4.7",
              description: "Opus 4.7 · Latest release",
              contextWindow: 200000,
              deprecated: false,
            },
          ],
        },
      ],
    };
    mockFetch(200, snapshot);

    const result = await getCloudProvidersSnapshot();
    expect(result).toEqual(snapshot);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/api/v1/cloud/providers/snapshot");
    // F1-closed: no Authorization header — the catalog is account-agnostic.
    const headers = (init.headers as Record<string, string>) ?? {};
    expect(headers.Authorization).toBeUndefined();
  });

  it("throws a useful error on non-2xx", async () => {
    mockFetch(503, { error: "snapshot unavailable" });
    await expect(getCloudProvidersSnapshot()).rejects.toThrow(/503/);
  });
});

describe("normalizeCloudProvidersSnapshot", () => {
  it("rejects providers without an id (forward-compat)", () => {
    const out = normalizeCloudProvidersSnapshot({
      version: "x",
      generatedAt: "y",
      providers: [{ displayName: "no id" }, { id: "valid", displayName: "Valid", models: [] }],
    });
    expect(out.providers.map((p) => p.id)).toEqual(["valid"]);
  });

  it("preserves isDefault only when explicitly true", () => {
    const out = normalizeCloudProvidersSnapshot({
      version: "x",
      generatedAt: "y",
      providers: [
        {
          id: "p",
          displayName: "P",
          models: [{ id: "m1", isDefault: true }, { id: "m2", isDefault: false }, { id: "m3" }],
        },
      ],
    });
    expect(out.providers[0]?.models[0]?.isDefault).toBe(true);
    expect(out.providers[0]?.models[1]?.isDefault).toBeUndefined();
    expect(out.providers[0]?.models[2]?.isDefault).toBeUndefined();
  });

  it("defaults missing fields to safe values", () => {
    const out = normalizeCloudProvidersSnapshot({});
    expect(out.version).toBe("unknown");
    expect(out.generatedAt).toBe("");
    expect(out.providers).toEqual([]);
  });
});

describe("listGithubRepos", () => {
  it("calls GET /api/v1/cloud/github/repos and normalizes the new contract", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(200, {
      repos: [
        {
          fullName: "acme/repo-one",
          cloneUrl: "https://github.com/acme/repo-one.git",
          private: false,
          defaultBranch: "main",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      nextPage: 2,
    });

    const result = await listGithubRepos();

    expect(result.repos).toEqual([
      {
        fullName: "acme/repo-one",
        cloneUrl: "https://github.com/acme/repo-one.git",
        private: false,
        defaultBranch: "main",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(result.nextPage).toBe(2);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/api/v1/cloud/github/repos");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("forwards page, perPage and search as query params", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(200, { repos: [], nextPage: null });

    await listGithubRepos({ page: 3, perPage: 50, search: "  paseo  " });

    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain("page=3");
    expect(url).toContain("perPage=50");
    expect(url).toContain("search=paseo");
  });

  it("drops malformed rows (missing fullName / cloneUrl) and defaults nextPage to null", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(200, {
      repos: [
        { fullName: "acme/good", cloneUrl: "https://github.com/acme/good.git" },
        { fullName: "acme/no-clone" },
        { cloneUrl: "https://github.com/acme/no-name.git" },
      ],
    });

    const result = await listGithubRepos();

    expect(result.repos.map((r) => r.fullName)).toEqual(["acme/good"]);
    expect(result.repos[0].defaultBranch).toBe("main");
    expect(result.nextPage).toBeNull();
  });

  it("throws OrchestraSessionExpiredError on 401", async () => {
    await storeSessionToken(TOKEN);
    mockFetch(401, { error: "unauthorized" });
    await expect(listGithubRepos()).rejects.toThrow(OrchestraSessionExpiredError);
  });
});
