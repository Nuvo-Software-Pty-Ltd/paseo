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
      getKey: async () => publicKey,
    });

    expect(await callback.validateWorkspaceToken("")).toBeNull();
    expect(await callback.validateWorkspaceToken("not-a-jwt")).toBeNull();
  });

  test("prewarm invokes the key resolver once and swallows errors", async () => {
    const { publicKey } = await makeKeypair();
    let getKeyCalls = 0;
    const callback = createJwksWorkspaceAuthCallback({
      jwksUrl: "http://unused.example/jwks",
      logger: silentLogger,
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
      getKey: async () => {
        throw new Error("simulated JWKS fetch failure");
      },
    });
    await expect(failingCallback.prewarm()).resolves.toBeUndefined();
  });
});
