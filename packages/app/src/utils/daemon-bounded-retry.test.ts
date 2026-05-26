import { describe, expect, it, vi } from "vitest";
import { runDaemonBoundedRetry } from "./daemon-bounded-retry";

describe("runDaemonBoundedRetry", () => {
  it("returns ok on first success without sleeping", async () => {
    const attempt = vi.fn(() => Promise.resolve());
    const sleep = vi.fn(() => Promise.resolve());
    const outcome = await runDaemonBoundedRetry({ attempt, sleep });
    expect(outcome).toEqual({ kind: "ok", attempt: 1 });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries through 14 transient failures then succeeds on the 15th", async () => {
    let attemptIndex = 0;
    const attempt = vi.fn(() => {
      attemptIndex += 1;
      if (attemptIndex < 15) {
        return Promise.reject(new Error("Connection timed out"));
      }
      return Promise.resolve();
    });
    const sleep = vi.fn(() => Promise.resolve());
    const outcome = await runDaemonBoundedRetry({
      attempt,
      sleep,
      maxAttempts: 15,
      spacingMs: 2000,
    });
    expect(outcome).toEqual({ kind: "ok", attempt: 15 });
    expect(attempt).toHaveBeenCalledTimes(15);
    expect(sleep).toHaveBeenCalledTimes(14);
    expect(sleep).toHaveBeenLastCalledWith(2000);
  });

  it("returns still_booting after 15 consecutive transient failures (T9 acceptance)", async () => {
    const attempt = vi.fn(() => Promise.reject(new Error("Connection timed out")));
    const sleep = vi.fn(() => Promise.resolve());
    const outcome = await runDaemonBoundedRetry({
      attempt,
      sleep,
      maxAttempts: 15,
      spacingMs: 2000,
    });
    expect(outcome).toEqual({
      kind: "still_booting",
      attempts: 15,
      lastReason: "Connection timed out",
    });
  });

  it("returns failed immediately on terminal (non-transient) error: incorrect password", async () => {
    const attempt = vi.fn(() => Promise.reject(new Error("Incorrect password")));
    const sleep = vi.fn(() => Promise.resolve());
    const outcome = await runDaemonBoundedRetry({ attempt, sleep });
    expect(outcome).toEqual({
      kind: "failed",
      attempts: 1,
      reason: "Incorrect password",
    });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns failed immediately on missing server info (auth seam unchanged)", async () => {
    const attempt = vi.fn(() => Promise.reject(new Error("Missing server info message")));
    const sleep = vi.fn(() => Promise.resolve());
    const outcome = await runDaemonBoundedRetry({ attempt, sleep });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("expected failed");
    expect(outcome.attempts).toBe(1);
  });

  it("honors a custom spacingMs (used by mint-token's retryAfterMs hint)", async () => {
    const attempt = vi.fn(() => Promise.reject(new Error("transport closed")));
    const sleep = vi.fn(() => Promise.resolve());
    await runDaemonBoundedRetry({
      attempt,
      sleep,
      maxAttempts: 3,
      spacingMs: 1500,
    });
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1500);
  });

  it("honors a custom isTransient predicate (allows the caller to fine-tune classification)", async () => {
    const attempt = vi.fn(() => Promise.reject(new Error("specific marker")));
    const sleep = vi.fn(() => Promise.resolve());
    const outcome = await runDaemonBoundedRetry({
      attempt,
      sleep,
      maxAttempts: 5,
      isTransient: (err) => err instanceof Error && err.message.toLowerCase().includes("specific"),
    });
    expect(outcome.kind).toBe("still_booting");
    if (outcome.kind !== "still_booting") throw new Error("expected still_booting");
    expect(outcome.attempts).toBe(5);
  });
});
