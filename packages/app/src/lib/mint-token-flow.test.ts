import { describe, expect, it, vi } from "vitest";
import type { MintWorkspaceTokenResult } from "./orchestra-cloud-client";
import { runMintTokenFlow } from "./mint-token-flow";

function fakeMint(results: MintWorkspaceTokenResult[]): {
  mint: (id: string) => Promise<MintWorkspaceTokenResult>;
  calls: number;
} {
  let i = 0;
  return {
    get calls() {
      return i;
    },
    mint: (_id: string) => {
      const result = results[i] ?? results[results.length - 1];
      i += 1;
      if (!result) throw new Error("no result available");
      return Promise.resolve(result);
    },
  };
}

describe("runMintTokenFlow", () => {
  it("returns active immediately on first 200", async () => {
    const { mint } = fakeMint([{ status: "active", token: "ws-jwt", expiresAt: 12345 }]);
    const sleep = vi.fn(() => Promise.resolve());
    const outcome = await runMintTokenFlow({
      workspaceId: "ws_1",
      mint,
      sleep,
    });
    expect(outcome).toEqual({ kind: "active", token: "ws-jwt", expiresAt: 12345 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("loops on 202 (resuming) until 200, honoring retryAfterMs", async () => {
    const { mint } = fakeMint([
      { status: "resuming", retryAfterMs: 1500 },
      { status: "resuming", retryAfterMs: 2000 },
      { status: "active", token: "ws-jwt", expiresAt: 99 },
    ]);
    const sleep = vi.fn(() => Promise.resolve());
    const outcome = await runMintTokenFlow({
      workspaceId: "ws_1",
      mint,
      sleep,
      maxAttempts: 10,
    });
    expect(outcome).toEqual({ kind: "active", token: "ws-jwt", expiresAt: 99 });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1500);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
  });

  it("terminates with still_resuming after maxAttempts (no spin-forever)", async () => {
    const { mint } = fakeMint(
      Array.from({ length: 30 }, () => ({
        status: "resuming" as const,
        retryAfterMs: 1500,
      })),
    );
    const sleep = vi.fn(() => Promise.resolve());
    const outcome = await runMintTokenFlow({
      workspaceId: "ws_1",
      mint,
      sleep,
      maxAttempts: 5,
    });
    expect(outcome).toEqual({
      kind: "still_resuming",
      lastRetryAfterMs: 1500,
      attempts: 5,
    });
    // sleep is called for the 4 iterations before the budget exhausts; the
    // final attempt does not sleep because it breaks out of the loop.
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it("loops on 503 (provisioning) until 200 with retryAfterMs honored", async () => {
    const { mint } = fakeMint([
      { status: "provisioning", retryAfterMs: 2000 },
      { status: "provisioning", retryAfterMs: 2000 },
      { status: "active", token: "ws-jwt", expiresAt: 1 },
    ]);
    const sleep = vi.fn(() => Promise.resolve());
    const outcome = await runMintTokenFlow({
      workspaceId: "ws_1",
      mint,
      sleep,
      maxAttempts: 10,
    });
    expect(outcome.kind).toBe("active");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("terminates with still_provisioning after maxAttempts when only 503 fires", async () => {
    const { mint } = fakeMint(
      Array.from({ length: 30 }, () => ({
        status: "provisioning" as const,
        retryAfterMs: 2000,
      })),
    );
    const sleep = vi.fn(() => Promise.resolve());
    const outcome = await runMintTokenFlow({
      workspaceId: "ws_1",
      mint,
      sleep,
      maxAttempts: 3,
    });
    expect(outcome).toEqual({
      kind: "still_provisioning",
      lastRetryAfterMs: 2000,
      attempts: 3,
    });
  });

  it("returns billing_locked verbatim (no retry loop)", async () => {
    const { mint } = fakeMint([
      { status: "billing_locked", reactivateUrl: "https://orchestra.example/billing" },
    ]);
    const sleep = vi.fn(() => Promise.resolve());
    const outcome = await runMintTokenFlow({
      workspaceId: "ws_1",
      mint,
      sleep,
    });
    expect(outcome).toEqual({
      kind: "billing_locked",
      reactivateUrl: "https://orchestra.example/billing",
    });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns archived with canUnarchive (caller routes through unarchive flow)", async () => {
    const { mint } = fakeMint([{ status: "archived", canUnarchive: true }]);
    const outcome = await runMintTokenFlow({
      workspaceId: "ws_1",
      mint,
      sleep: () => Promise.resolve(),
    });
    expect(outcome).toEqual({ kind: "archived", canUnarchive: true });
  });

  it("returns provisioning_failed verbatim (no retry loop)", async () => {
    const { mint } = fakeMint([{ status: "provisioning_failed", retryable: false }]);
    const outcome = await runMintTokenFlow({
      workspaceId: "ws_1",
      mint,
      sleep: () => Promise.resolve(),
    });
    expect(outcome).toEqual({ kind: "provisioning_failed", retryable: false });
  });
});
