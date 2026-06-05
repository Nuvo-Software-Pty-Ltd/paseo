import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import {
  buildGithubTokenSecretId,
  fetchWorkspaceRepoUrl,
  parseGitHubRepoUrl,
  resolveStage,
} from "./cloud-clone.js";

const logger = pino({ level: "silent" });

describe("parseGitHubRepoUrl", () => {
  it("parses standard github.com URLs", () => {
    expect(parseGitHubRepoUrl("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("strips .git suffix", () => {
    expect(parseGitHubRepoUrl("https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("rejects non-github hosts", () => {
    expect(parseGitHubRepoUrl("https://gitlab.com/owner/repo")).toBeNull();
  });

  it("rejects malformed paths", () => {
    expect(parseGitHubRepoUrl("https://github.com/owner")).toBeNull();
    expect(parseGitHubRepoUrl("not a url")).toBeNull();
  });
});

describe("buildGithubTokenSecretId", () => {
  it("composes the Secrets Manager path from stage + account", () => {
    expect(buildGithubTokenSecretId("dev", "acct_42")).toBe(
      "orchestra/dev/account/acct_42/github-token",
    );
    expect(buildGithubTokenSecretId("prod", "acct_other")).toBe(
      "orchestra/prod/account/acct_other/github-token",
    );
  });
});

describe("resolveStage", () => {
  it("defaults to dev when ORCHESTRA_STAGE is unset", () => {
    const prev = process.env.ORCHESTRA_STAGE;
    delete process.env.ORCHESTRA_STAGE;
    try {
      expect(resolveStage()).toBe("dev");
    } finally {
      if (prev !== undefined) process.env.ORCHESTRA_STAGE = prev;
    }
  });

  it("trims and uses ORCHESTRA_STAGE when set", () => {
    const prev = process.env.ORCHESTRA_STAGE;
    process.env.ORCHESTRA_STAGE = "  prod  ";
    try {
      expect(resolveStage()).toBe("prod");
    } finally {
      if (prev === undefined) delete process.env.ORCHESTRA_STAGE;
      else process.env.ORCHESTRA_STAGE = prev;
    }
  });
});

describe("fetchWorkspaceRepoUrl", () => {
  it("POSTs to /api/auth-internal/describe-workspace with HMAC", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(
        JSON.stringify({ accountId: "acct_1", repoUrl: "https://github.com/u/r" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await fetchWorkspaceRepoUrl({
      authServiceBaseUrl: "https://auth.example.com",
      hmacKey: "test-key",
      workspaceId: "ws_42",
      logger,
      fetchImpl,
    });

    expect(result).toEqual({ accountId: "acct_1", repoUrl: "https://github.com/u/r" });
    expect(capturedUrl).toBe("https://auth.example.com/api/auth-internal/describe-workspace");
    expect(capturedInit?.method).toBe("POST");
    expect(JSON.parse(String(capturedInit?.body))).toEqual({ workspaceId: "ws_42" });
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["X-Orchestra-Internal-HMAC"]).toMatch(/^[a-f0-9]{64}$/);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("strips trailing slash from authServiceBaseUrl", async () => {
    let capturedUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ accountId: "a", repoUrl: "https://github.com/u/r" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await fetchWorkspaceRepoUrl({
      authServiceBaseUrl: "https://auth.example.com/",
      hmacKey: "k",
      workspaceId: "ws_1",
      logger,
      fetchImpl,
    });
    expect(capturedUrl).toBe("https://auth.example.com/api/auth-internal/describe-workspace");
  });

  it("throws when the auth service returns non-2xx", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("forbidden", { status: 403 }),
    ) as unknown as typeof fetch;

    await expect(
      fetchWorkspaceRepoUrl({
        authServiceBaseUrl: "https://auth.example.com",
        hmacKey: "k",
        workspaceId: "ws_1",
        logger,
        fetchImpl,
      }),
    ).rejects.toThrow(/403/);
  });

  it("throws when accountId is missing", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ repoUrl: "https://github.com/o/r" }), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(
      fetchWorkspaceRepoUrl({
        authServiceBaseUrl: "https://auth.example.com",
        hmacKey: "k",
        workspaceId: "ws_1",
        logger,
        fetchImpl,
      }),
    ).rejects.toThrow(/missing accountId/);
  });

  it("tolerates an absent repoUrl (empty workspace — D-3.5a T-5)", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ accountId: "a" }), { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(
      fetchWorkspaceRepoUrl({
        authServiceBaseUrl: "https://auth.example.com",
        hmacKey: "k",
        workspaceId: "ws_1",
        logger,
        fetchImpl,
      }),
    ).resolves.toEqual({ accountId: "a", repoUrl: null });
  });
});
