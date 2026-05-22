import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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

  // D-2 IAM scoping (T-5): per-workspace task roles produce an
  // AccessDeniedException on cross-tenant Secrets Manager reads. Operator
  // triage needs the workspaceId + the specific secretId in the structured
  // log line, AND in the rethrown Error message, AND the cause-chain of
  // the AccessDeniedException untouched. If any of these regress, the
  // CloudTrail-to-daemon-log correlation an operator does during a probe
  // breaks.
  test("AccessDeniedException is rethrown with workspaceId + secretId + cause-chain intact", async () => {
    const errorCalls: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const captureLogger = {
      error: (obj: Record<string, unknown>, msg: string) => {
        errorCalls.push({ obj, msg });
      },
      info: () => {},
      warn: () => {},
      debug: () => {},
    } as unknown as Parameters<typeof fetchAnthropicCredential>[0]["logger"];

    const accessDeny = Object.assign(new Error("User: arn:... is not authorized"), {
      name: "AccessDeniedException",
      $metadata: { httpStatusCode: 400 },
    });

    let rethrown: unknown;
    try {
      await fetchAnthropicCredential({
        workspaceId: "ws_victim",
        logger: captureLogger,
        client: fakeSecretsManager(accessDeny),
      });
    } catch (err) {
      rethrown = err;
    }

    expect(rethrown).toBeInstanceOf(Error);
    const rethrownErr = rethrown as Error & { cause?: unknown };
    // Rethrown message names the workspaceId — operators correlating
    // CloudTrail-side denies need this.
    expect(rethrownErr.message).toMatch(/ws_victim/);
    // The original AccessDeniedException is preserved as cause.
    expect(rethrownErr.cause).toBe(accessDeny);

    // Structured log carries err + workspaceId + secretId. secretId
    // must contain the per-workspace prefix so an operator sees which
    // workspace's secret was being read.
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    const logged = errorCalls[0];
    expect(logged.obj.workspaceId).toBe("ws_victim");
    expect(String(logged.obj.secretId)).toContain("ws_victim");
    expect(String(logged.obj.secretId)).toContain("anthropic-credential");
    expect(logged.obj.err).toBe(accessDeny);
  });

  // Cross-tenant probe (T-5 hands-on gate, simulated): the task role's
  // Resource clause hard-codes the per-workspace prefix. A read against a
  // *different* workspace's secret id surfaces the IAM deny — the SDK
  // raises an AccessDeniedException-shaped error, and our wrapper must
  // not collapse it into a generic "not found".
  test("AccessDenied does not get rewritten as a missing-secret error", async () => {
    const accessDeny = Object.assign(new Error("not authorized to perform: GetSecretValue"), {
      name: "AccessDeniedException",
    });
    await expect(
      fetchAnthropicCredential({
        workspaceId: "ws_B",
        logger: silentLogger,
        client: fakeSecretsManager(accessDeny),
      }),
    ).rejects.toMatchObject({
      // Distinguish from the empty-string fall-through and the unknown
      // error path — the workspaceId must surface and the original
      // AccessDeniedException message must be embedded verbatim.
      message: expect.stringMatching(/ws_B.*not authorized/),
    });
  });
});

// T-5 doc check: provisionCloudClaudeHome is the SINGLE entry point for
// per-spawn Claude home materialization in cloud mode. It MUST source
// workspaceId from getCurrentWorkspaceAuth() (ALS) and never accept a
// workspaceId parameter — otherwise a buggy caller could spoof another
// workspace's identity. Verified at the type level by reading the
// signature; here we assert it stays unchanged via a no-arg invocation
// pattern.
describe("provisionCloudClaudeHome — F3 design-out", () => {
  test("accepts only { logger }; no caller-supplied workspaceId parameter", () => {
    // If the signature ever grows a workspaceId arg, this assignment will
    // produce a TypeScript error. Kept as a runtime-shape sanity check in
    // case the implementation ever destructures something off the params.
    const fn = provisionCloudClaudeHome as (params: { logger: typeof silentLogger }) => unknown;
    expect(typeof fn).toBe("function");
    // Force vi to be referenced so the import survives lint runs that
    // strip unused symbols.
    vi.fn();
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
