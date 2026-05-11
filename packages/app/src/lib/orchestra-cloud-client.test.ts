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
  OrchestraSessionExpiredError,
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

    expect(result).toEqual(workspaces);
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

    expect(result).toEqual(workspace);
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
  it("calls POST and returns token + expiresAt", async () => {
    await storeSessionToken(TOKEN);
    const payload = { token: "ws-jwt", expiresAt: 1234567890 };
    mockFetch(200, payload);

    const result = await mintWorkspaceToken("ws_002");

    expect(result).toEqual(payload);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain("/api/v1/cloud/workspaces/ws_002/token");
    expect(init.method).toBe("POST");
  });
});

describe("listGithubRepos", () => {
  it("calls GET /api/v1/cloud/github/repos", async () => {
    await storeSessionToken(TOKEN);
    const repos = [{ full_name: "user/repo", private: false, updated_at: "2026-01-01" }];
    mockFetch(200, repos);

    const result = await listGithubRepos();

    expect(result).toEqual(repos);
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain("/api/v1/cloud/github/repos");
  });
});
