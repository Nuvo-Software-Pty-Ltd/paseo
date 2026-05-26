import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionExpiredBounce } from "./orchestra-session-bounce";

describe("createSessionExpiredBounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces concurrent triggers into one clearSession + replace pair", async () => {
    const clearSession = vi.fn().mockResolvedValue(undefined);
    const replace = vi.fn();
    const bounce = createSessionExpiredBounce({
      clearSession,
      replace,
      warn: () => {},
    });

    bounce.trigger();
    bounce.trigger();
    bounce.trigger();

    // clearSession is invoked synchronously by trigger().
    expect(clearSession).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(1);
    });
    expect(replace).toHaveBeenCalledWith("/welcome?reason=session-expired");
  });

  it("re-arms after the debounce window so a later expiry still bounces", async () => {
    const clearSession = vi.fn().mockResolvedValue(undefined);
    const replace = vi.fn();
    const bounce = createSessionExpiredBounce({
      clearSession,
      replace,
      debounceMs: 50,
      warn: () => {},
    });

    bounce.trigger();
    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(1);
    });

    vi.advanceTimersByTime(100);

    bounce.trigger();
    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(2);
    });
    expect(clearSession).toHaveBeenCalledTimes(2);
  });

  it("still bounces (and warns) when clearSession rejects", async () => {
    const clearSession = vi.fn().mockRejectedValue(new Error("storage failed"));
    const replace = vi.fn();
    const warn = vi.fn();
    const bounce = createSessionExpiredBounce({
      clearSession,
      replace,
      warn,
    });

    bounce.trigger();
    await vi.waitFor(() => {
      expect(replace).toHaveBeenCalledTimes(1);
    });
    expect(warn).toHaveBeenCalled();
  });
});
