import { describe, expect, test } from "vitest";

import {
  extractHttpBearerToken,
  extractWsBearerProtocol,
  extractWsBearerToken,
  extractWsWorkspaceProtocol,
  extractWsWorkspaceToken,
  hashDaemonPassword,
  isBearerTokenValidAsync,
  isBearerTokenValid,
  shouldBypassBearerAuth,
} from "./auth.js";

const CORRECT_PASSWORD_HASH = "$2b$12$OLxyuuP9uLK30Uzc4wQX0O6liuU/Q1t5P2b0Ebf36mULvpVK3DRZW";

describe("daemon bearer validator", () => {
  test("allows any token when no password is configured", () => {
    expect(isBearerTokenValid({ password: undefined, token: null })).toBe(true);
    expect(isBearerTokenValid({ password: undefined, token: "anything" })).toBe(true);
  });

  test("accepts the plaintext token against the bcrypt hash and rejects missing or wrong tokens", async () => {
    expect(
      await isBearerTokenValidAsync({ password: CORRECT_PASSWORD_HASH, token: "correct-password" }),
    ).toBe(true);
    expect(isBearerTokenValid({ password: CORRECT_PASSWORD_HASH, token: "correct-password" })).toBe(
      true,
    );
    expect(await isBearerTokenValidAsync({ password: CORRECT_PASSWORD_HASH, token: null })).toBe(
      false,
    );
    expect(await isBearerTokenValidAsync({ password: CORRECT_PASSWORD_HASH, token: "wrong" })).toBe(
      false,
    );
  });

  test("hashes a password into a bcrypt value", () => {
    const hash = hashDaemonPassword("correct-password");

    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(isBearerTokenValid({ password: hash, token: "correct-password" })).toBe(true);
  });

  test("extracts HTTP bearer tokens", () => {
    expect(extractHttpBearerToken("Bearer secret")).toBe("secret");
    expect(extractHttpBearerToken("Basic secret")).toBeNull();
    expect(extractHttpBearerToken(undefined)).toBeNull();
  });

  test("extracts WebSocket paseo bearer subprotocol tokens", () => {
    const protocol = extractWsBearerProtocol("chat, paseo.bearer.secret.with.dots");

    expect(protocol).toBe("paseo.bearer.secret.with.dots");
    expect(extractWsBearerToken(protocol)).toBe("secret.with.dots");
    expect(extractWsBearerToken("paseo.other.secret")).toBeNull();
  });

  test("extracts WebSocket paseo workspace subprotocol tokens (JWT-shaped)", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ3In0.signature";
    const protocol = extractWsWorkspaceProtocol(`chat, paseo.workspace.${jwt}`);

    expect(protocol).toBe(`paseo.workspace.${jwt}`);
    expect(extractWsWorkspaceToken(protocol)).toBe(jwt);
    // The workspace parser must not match a bearer protocol — they are
    // mutually exclusive in cloud vs on-host mode.
    expect(extractWsWorkspaceProtocol("paseo.bearer.token")).toBeNull();
    expect(extractWsWorkspaceToken("paseo.bearer.token")).toBeNull();
  });
});

describe("shouldBypassBearerAuth", () => {
  // D-3.5d — the HMAC-authed internal routes must escape BOTH the on-host
  // Bearer gate and the cloud workspace-token gate (both early-return through
  // this helper). They authenticate themselves with a per-request internal
  // HMAC, so the password/JWT gate is the wrong boundary for them.
  test("bypasses every HMAC-authed internal route", () => {
    expect(shouldBypassBearerAuth("POST", "/api/internal/webhook-fire")).toBe(true);
    expect(shouldBypassBearerAuth("POST", "/api/internal/schedule-fire")).toBe(true);
    expect(shouldBypassBearerAuth("POST", "/api/internal/clone-repo")).toBe(true);
    // The T-16 download-redemption route lives at /api/files/download/internal/
    // (NOT under /api/internal/), and self-authenticates with an HMAC over the
    // empty body, so it must bypass too.
    expect(shouldBypassBearerAuth("GET", "/api/files/download/internal/tok_abc123")).toBe(true);
  });

  test("still bypasses /hooks/, OPTIONS, and /api/health", () => {
    expect(shouldBypassBearerAuth("POST", "/hooks/wh_public")).toBe(true);
    expect(shouldBypassBearerAuth("OPTIONS", "/api/anything")).toBe(true);
    expect(shouldBypassBearerAuth("GET", "/api/health")).toBe(true);
  });

  test("does NOT bypass normal API routes or the workspace-token-authed download", () => {
    expect(shouldBypassBearerAuth("GET", "/api/agents")).toBe(false);
    expect(shouldBypassBearerAuth("POST", "/api/agents/create")).toBe(false);
    // The query-param download (workspace-token authed) must stay gated — only
    // its deeper /internal/ sibling self-HMACs.
    expect(shouldBypassBearerAuth("GET", "/api/files/download")).toBe(false);
  });
});
