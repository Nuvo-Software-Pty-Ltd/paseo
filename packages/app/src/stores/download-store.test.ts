import { describe, expect, it } from "vitest";
import { buildDownloadUrl } from "./download-store";

// Cross-instance anti-drift (T11). The download URL is minted on one daemon
// container's WS RPC and may be redeemed on a different daemon container's
// HTTP handler — the auth-served 302 redirect chain (synthesis § 1 C3 /
// CROSS-STREAM-SYNTHESIS.md commit 9dc8972) makes this the normative path.
// The URL builder MUST stay host-affinity-free: only the base origin + path
// + token query param + optional basic-auth credentials. No path-segment
// embedding the issuing instance identity, no cookie, no instance hint.

describe("buildDownloadUrl — cross-instance safety", () => {
  it("emits a clean origin + path + token URL without host-affinity hints", () => {
    const url = buildDownloadUrl("https://daemon.example.com", "tok-123", null);
    expect(url).toBe("https://daemon.example.com/api/files/download?token=tok-123");
  });

  it("does not embed an instance identifier in the path segment", () => {
    const url = buildDownloadUrl("https://daemon.example.com", "tok-123", null);
    // The path is fixed to /api/files/download with the token in the query
    // string. A future regression that tries to encode the issuer's instance
    // (e.g. /api/files/download/inst-A/...) would shift the path and fail.
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/files/download");
  });

  it("includes the token only in the query string, not the path", () => {
    const url = buildDownloadUrl("https://daemon.example.com", "tok-xyz", null);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("token")).toBe("tok-xyz");
    expect(parsed.pathname).not.toContain("tok-xyz");
  });

  it("attaches optional basic-auth credentials inline (no Set-Cookie sticky binding)", () => {
    const url = buildDownloadUrl("https://daemon.example.com", "tok-1", {
      username: "user",
      password: "secret",
    });
    const parsed = new URL(url);
    // basic-auth is per-request; it does not carry instance affinity.
    expect(parsed.username).toBe("user");
    expect(parsed.password).toBe("secret");
  });

  it("preserves the daemon host as the only origin (no proxy substitution)", () => {
    const url = buildDownloadUrl("http://daemon-a.internal:6767", "t", null);
    const parsed = new URL(url);
    expect(parsed.origin).toBe("http://daemon-a.internal:6767");
  });

  it("does not set any custom headers / cookies inside the URL", () => {
    // Sanity: the URL is the entire transport contract. No fragment, no
    // implicit cookies, no client-side sticky bits.
    const url = buildDownloadUrl("https://daemon.example.com", "tok-x", null);
    const parsed = new URL(url);
    expect(parsed.hash).toBe("");
    expect(parsed.searchParams.size).toBe(1);
  });
});
