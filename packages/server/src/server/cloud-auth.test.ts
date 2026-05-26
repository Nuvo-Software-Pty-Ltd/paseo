import { describe, expect, test } from "vitest";
import { generateKeyPair, SignJWT, type CryptoKey } from "jose";
import pino from "pino";
import { createJwksWorkspaceAuthCallback } from "./cloud-auth.js";

const silentLogger = pino({ level: "silent" });

async function makeKeypair(): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
  const pair = await generateKeyPair("RS256");
  return pair as { privateKey: CryptoKey; publicKey: CryptoKey };
}

async function signWorkspaceJwt(
  privateKey: CryptoKey,
  claims: { account_id: string; workspace_id: string; ttlSeconds?: number },
): Promise<string> {
  return new SignJWT({
    account_id: claims.account_id,
    workspace_id: claims.workspace_id,
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime(`${claims.ttlSeconds ?? 3600}s`)
    .sign(privateKey);
}

describe("createJwksWorkspaceAuthCallback", () => {
  test("verifies a well-formed workspace token and returns its claims", async () => {
    const { privateKey, publicKey } = await makeKeypair();
    const callback = createJwksWorkspaceAuthCallback({
      jwksUrl: "http://unused.example/jwks",
      logger: silentLogger,
      expectedAccountId: "acc_alpha",
      expectedWorkspaceId: "ws_beta",
      getKey: async () => publicKey,
    });
    const token = await signWorkspaceJwt(privateKey, {
      account_id: "acc_alpha",
      workspace_id: "ws_beta",
    });

    const result = await callback.validateWorkspaceToken(token);
    expect(result).not.toBeNull();
    expect(result?.accountId).toBe("acc_alpha");
    expect(result?.workspaceId).toBe("ws_beta");
    expect(result?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test("rejects an expired workspace token", async () => {
    const { privateKey, publicKey } = await makeKeypair();
    const callback = createJwksWorkspaceAuthCallback({
      jwksUrl: "http://unused.example/jwks",
      logger: silentLogger,
      expectedAccountId: "a",
      expectedWorkspaceId: "w",
      getKey: async () => publicKey,
    });
    // Negative TTL → exp in the past. jose treats expired as invalid.
    const expired = await new SignJWT({ account_id: "a", workspace_id: "w" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(privateKey);

    expect(await callback.validateWorkspaceToken(expired)).toBeNull();
  });

  test("rejects a token signed with a different key (signature mismatch)", async () => {
    const signer = await makeKeypair();
    const verifier = await makeKeypair();
    const callback = createJwksWorkspaceAuthCallback({
      jwksUrl: "http://unused.example/jwks",
      logger: silentLogger,
      expectedAccountId: "acc",
      expectedWorkspaceId: "ws",
      getKey: async () => verifier.publicKey,
    });
    const token = await signWorkspaceJwt(signer.privateKey, {
      account_id: "acc",
      workspace_id: "ws",
    });

    expect(await callback.validateWorkspaceToken(token)).toBeNull();
  });

  test("rejects a token missing required claims", async () => {
    const { privateKey, publicKey } = await makeKeypair();
    const callback = createJwksWorkspaceAuthCallback({
      jwksUrl: "http://unused.example/jwks",
      logger: silentLogger,
      expectedAccountId: "a",
      expectedWorkspaceId: "w",
      getKey: async () => publicKey,
    });
    // No workspace_id — the schema check rejects this even though the
    // signature would otherwise verify.
    const tokenMissingWorkspaceId = await new SignJWT({ account_id: "a" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

    expect(await callback.validateWorkspaceToken(tokenMissingWorkspaceId)).toBeNull();
  });

  test("rejects an empty or malformed token", async () => {
    const { publicKey } = await makeKeypair();
    const callback = createJwksWorkspaceAuthCallback({
      jwksUrl: "http://unused.example/jwks",
      logger: silentLogger,
      expectedAccountId: "a",
      expectedWorkspaceId: "w",
      getKey: async () => publicKey,
    });

    expect(await callback.validateWorkspaceToken("")).toBeNull();
    expect(await callback.validateWorkspaceToken("not-a-jwt")).toBeNull();
  });

  test("accepts a token whose account_id and workspace_id match the daemon binding", async () => {
    const { privateKey, publicKey } = await makeKeypair();
    const callback = createJwksWorkspaceAuthCallback({
      jwksUrl: "http://unused.example/jwks",
      logger: silentLogger,
      expectedAccountId: "acc_self",
      expectedWorkspaceId: "ws_self",
      getKey: async () => publicKey,
    });
    const token = await signWorkspaceJwt(privateKey, {
      account_id: "acc_self",
      workspace_id: "ws_self",
    });

    const result = await callback.validateWorkspaceToken(token);
    expect(result).not.toBeNull();
    expect(result?.accountId).toBe("acc_self");
    expect(result?.workspaceId).toBe("ws_self");
  });

  test("rejects a validly-signed token whose workspace_id does not match the daemon binding", async () => {
    const { privateKey, publicKey } = await makeKeypair();
    const logs: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const captureLogger = pino(
      { level: "warn" },
      {
        write(chunk: string) {
          const parsed = JSON.parse(chunk) as Record<string, unknown>;
          const { msg, ...rest } = parsed;
          logs.push({ obj: rest, msg: String(msg) });
        },
      },
    );
    const callback = createJwksWorkspaceAuthCallback({
      jwksUrl: "http://unused.example/jwks",
      logger: captureLogger,
      expectedAccountId: "acc_self",
      expectedWorkspaceId: "ws_self",
      getKey: async () => publicKey,
    });
    // Token signed by the same auth-service keypair but issued for a
    // different workspace — the live D-2 probe 7 scenario.
    const crossTenant = await signWorkspaceJwt(privateKey, {
      account_id: "acc_self",
      workspace_id: "ws_other",
    });

    expect(await callback.validateWorkspaceToken(crossTenant)).toBeNull();
    const mismatchLog = logs.find(
      (entry) => entry.msg === "workspace token mismatched daemon binding",
    );
    expect(mismatchLog).toBeDefined();
    expect(mismatchLog?.obj.expectedWorkspaceId).toBe("ws_self");
    expect(mismatchLog?.obj.receivedWorkspaceId).toBe("ws_other");
  });

  test("rejects a validly-signed token whose account_id does not match the daemon binding", async () => {
    const { privateKey, publicKey } = await makeKeypair();
    const logs: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const captureLogger = pino(
      { level: "warn" },
      {
        write(chunk: string) {
          const parsed = JSON.parse(chunk) as Record<string, unknown>;
          const { msg, ...rest } = parsed;
          logs.push({ obj: rest, msg: String(msg) });
        },
      },
    );
    const callback = createJwksWorkspaceAuthCallback({
      jwksUrl: "http://unused.example/jwks",
      logger: captureLogger,
      expectedAccountId: "acc_self",
      expectedWorkspaceId: "ws_self",
      getKey: async () => publicKey,
    });
    // workspace_id matches but account_id does not — guards against a future
    // workspace_id collision across accounts defeating the binding.
    const wrongAccount = await signWorkspaceJwt(privateKey, {
      account_id: "acc_other",
      workspace_id: "ws_self",
    });

    expect(await callback.validateWorkspaceToken(wrongAccount)).toBeNull();
    const mismatchLog = logs.find(
      (entry) => entry.msg === "workspace token mismatched daemon binding",
    );
    expect(mismatchLog).toBeDefined();
    expect(mismatchLog?.obj.expectedAccountId).toBe("acc_self");
    expect(mismatchLog?.obj.receivedAccountId).toBe("acc_other");
  });

  test("rejects a validly-signed token when both account_id and workspace_id mismatch", async () => {
    const { privateKey, publicKey } = await makeKeypair();
    const callback = createJwksWorkspaceAuthCallback({
      jwksUrl: "http://unused.example/jwks",
      logger: silentLogger,
      expectedAccountId: "acc_self",
      expectedWorkspaceId: "ws_self",
      getKey: async () => publicKey,
    });
    const bothWrong = await signWorkspaceJwt(privateKey, {
      account_id: "acc_other",
      workspace_id: "ws_other",
    });

    expect(await callback.validateWorkspaceToken(bothWrong)).toBeNull();
  });

  test("prewarm invokes the key resolver once and swallows errors", async () => {
    const { publicKey } = await makeKeypair();
    let getKeyCalls = 0;
    const callback = createJwksWorkspaceAuthCallback({
      jwksUrl: "http://unused.example/jwks",
      logger: silentLogger,
      expectedAccountId: "a",
      expectedWorkspaceId: "w",
      getKey: async () => {
        getKeyCalls += 1;
        return publicKey;
      },
    });

    await callback.prewarm();
    expect(getKeyCalls).toBe(1);

    // Failure path: a throwing resolver must not propagate.
    const failingCallback = createJwksWorkspaceAuthCallback({
      jwksUrl: "http://unused.example/jwks",
      logger: silentLogger,
      expectedAccountId: "a",
      expectedWorkspaceId: "w",
      getKey: async () => {
        throw new Error("simulated JWKS fetch failure");
      },
    });
    await expect(failingCallback.prewarm()).resolves.toBeUndefined();
  });
});
