import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import pino from "pino";
import {
  fetchAnthropicCredential,
  materializeClaudeHome,
  provisionCloudClaudeHome,
  type SecretsManagerLike,
} from "./cloud-credentials.js";
import { workspaceAuthStorage } from "./cloud-auth.js";

const silentLogger = pino({ level: "silent" });

function fakeSecretsManager(payload: { SecretString?: string } | Error): SecretsManagerLike {
  return {
    async getSecretValue() {
      if (payload instanceof Error) {
        throw payload;
      }
      return payload as never;
    },
  };
}

describe("fetchAnthropicCredential", () => {
  beforeEach(() => {
    delete process.env.ORCHESTRA_STAGE;
  });

  test("returns the SecretString when present", async () => {
    const credential = await fetchAnthropicCredential({
      workspaceId: "ws_abc",
      logger: silentLogger,
      client: fakeSecretsManager({ SecretString: "sk-ant-xxxxx" }),
    });
    expect(credential).toBe("sk-ant-xxxxx");
  });

  test("throws when the secret is empty (fail-loud)", async () => {
    await expect(
      fetchAnthropicCredential({
        workspaceId: "ws_abc",
        logger: silentLogger,
        client: fakeSecretsManager({ SecretString: "" }),
      }),
    ).rejects.toThrow(/empty or missing/);
  });

  test("propagates the underlying SDK error (fail-loud)", async () => {
    await expect(
      fetchAnthropicCredential({
        workspaceId: "ws_abc",
        logger: silentLogger,
        client: fakeSecretsManager(new Error("AccessDeniedException")),
      }),
    ).rejects.toThrow(/AccessDeniedException/);
  });
});

describe("materializeClaudeHome", () => {
  const written: string[] = [];
  afterEach(async () => {
    await Promise.all(written.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  test("writes config.json with primaryApiKey and sets HOME/CLAUDE_CONFIG_DIR/ANTHROPIC_API_KEY", async () => {
    const home = await materializeClaudeHome({
      credential: "sk-ant-secret",
      logger: silentLogger,
    });
    written.push(home.homeDir);

    expect(home.env.HOME).toBe(home.homeDir);
    expect(home.env.CLAUDE_CONFIG_DIR).toBe(home.configDir);
    expect(home.env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");

    const config = JSON.parse(await fs.readFile(`${home.configDir}/config.json`, "utf8"));
    expect(config.primaryApiKey).toBe("sk-ant-secret");
  });

  test("writes .credentials.json with oauthToken and sets CLAUDE_CODE_OAUTH_TOKEN", async () => {
    const home = await materializeClaudeHome({
      credential: "sk-ant-oat01-test",
      logger: silentLogger,
    });
    written.push(home.homeDir);

    expect(home.env.HOME).toBe(home.homeDir);
    expect(home.env.CLAUDE_CONFIG_DIR).toBe(home.configDir);
    expect(home.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-test");
    expect(home.env.ANTHROPIC_API_KEY).toBeUndefined();

    const creds = JSON.parse(await fs.readFile(`${home.configDir}/.credentials.json`, "utf8"));
    expect(creds.oauthToken).toBe("sk-ant-oat01-test");

    await expect(fs.stat(`${home.configDir}/config.json`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("cleanup removes the spawn directory", async () => {
    const home = await materializeClaudeHome({
      credential: "sk-ant-secret",
      logger: silentLogger,
    });
    written.push(home.homeDir);
    await expect(fs.stat(home.homeDir)).resolves.toBeTruthy();

    await home.cleanup();
    await expect(fs.stat(home.homeDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("provisionCloudClaudeHome", () => {
  test("fails-loud when no workspace auth context is in scope", async () => {
    await expect(provisionCloudClaudeHome({ logger: silentLogger })).rejects.toThrow(
      /workspace auth context/,
    );
  });

  test("succeeds inside an AsyncLocalStorage workspace context", async () => {
    // Stub the network path: monkey-patch the credential fetch via the
    // module's storage indirection — for this test we just verify the
    // storage propagation is wired correctly by checking that the call
    // proceeds past the context-missing branch. The SDK send() will fail
    // due to missing AWS creds in CI, which we catch and ignore — the
    // assertion is on the error *shape*, not on success.
    const ran = await workspaceAuthStorage.run(
      { accountId: "acc_a", workspaceId: "ws_b", expiresAt: Date.now() / 1000 + 3600 },
      async () => {
        try {
          await provisionCloudClaudeHome({ logger: silentLogger });
          return "succeeded";
        } catch (error) {
          // Anything OTHER than the "no workspace context" error means the
          // context propagation worked; the failure is downstream (SDK or
          // network), which is expected in a unit test.
          if (error instanceof Error && /workspace auth context/.test(error.message)) {
            return "context-missing";
          }
          return "context-present-but-fetch-failed";
        }
      },
    );
    expect(ran).not.toBe("context-missing");
  });
});
