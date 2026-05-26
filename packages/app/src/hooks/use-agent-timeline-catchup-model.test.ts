import { describe, expect, it } from "vitest";
import {
  beginCatchup,
  completeCatchup,
  dismissEpochRestarted,
  initialCatchupState,
  markEpochRestarted,
  shouldSuppressSideEffects,
} from "./use-agent-timeline-catchup-model";

describe("catchup state machine", () => {
  it("starts hidden with no timestamp / no epoch-restart / no start time", () => {
    expect(initialCatchupState()).toEqual({
      isCatchingUp: false,
      lastKnownTimestamp: null,
      epochRestarted: false,
      startedAt: null,
    });
  });

  it("beginCatchup flips visible + records the last-known timestamp", () => {
    const next = beginCatchup({ lastKnownTimestamp: "2026-05-26T01:00:00.000Z", now: 1000 });
    expect(next).toEqual({
      isCatchingUp: true,
      lastKnownTimestamp: "2026-05-26T01:00:00.000Z",
      epochRestarted: false,
      startedAt: 1000,
    });
  });

  it("beginCatchup handles a cold reconnect with no cursor (lastKnownTimestamp:null)", () => {
    const next = beginCatchup({ lastKnownTimestamp: null, now: 0 });
    expect(next.isCatchingUp).toBe(true);
    expect(next.lastKnownTimestamp).toBeNull();
  });

  it("completeCatchup hides the banner once min-visibility window has elapsed", () => {
    const begun = beginCatchup({ lastKnownTimestamp: "t", now: 0 });
    const completed = completeCatchup({ state: begun, now: 1500, minDurationMs: 1000 });
    expect(completed.isCatchingUp).toBe(false);
  });

  it("completeCatchup keeps the banner visible if min-visibility window has NOT elapsed (PLAN OQ4)", () => {
    const begun = beginCatchup({ lastKnownTimestamp: "t", now: 0 });
    const stillVisible = completeCatchup({ state: begun, now: 200, minDurationMs: 1000 });
    expect(stillVisible.isCatchingUp).toBe(true);
    // State is unchanged so React can bail out of re-render.
    expect(stillVisible).toBe(begun);
  });

  it("completeCatchup is a no-op when not currently catching up", () => {
    const idle = initialCatchupState();
    expect(completeCatchup({ state: idle, now: 999 })).toBe(idle);
  });

  it("completeCatchup hides immediately when startedAt is null (defensive — never happens)", () => {
    const odd: ReturnType<typeof initialCatchupState> = {
      isCatchingUp: true,
      lastKnownTimestamp: null,
      epochRestarted: false,
      startedAt: null,
    };
    expect(completeCatchup({ state: odd, now: 5 }).isCatchingUp).toBe(false);
  });

  it("markEpochRestarted sets the soft 'Timeline restarted' flag", () => {
    const begun = beginCatchup({ lastKnownTimestamp: "t", now: 0 });
    const after = markEpochRestarted(begun);
    expect(after.epochRestarted).toBe(true);
    expect(after.isCatchingUp).toBe(true);
  });

  it("dismissEpochRestarted clears the flag", () => {
    const after = dismissEpochRestarted({
      isCatchingUp: false,
      lastKnownTimestamp: null,
      epochRestarted: true,
      startedAt: null,
    });
    expect(after.epochRestarted).toBe(false);
  });
});

describe("shouldSuppressSideEffects", () => {
  it("suppresses for kind:catch_up regardless of isCatchingUp flag", () => {
    expect(shouldSuppressSideEffects({ itemKind: "catch_up", isCatchingUp: false })).toBe(true);
    expect(shouldSuppressSideEffects({ itemKind: "catch_up", isCatchingUp: true })).toBe(true);
  });

  it("suppresses live items received while a catchup is still in flight", () => {
    expect(shouldSuppressSideEffects({ itemKind: "realtime", isCatchingUp: true })).toBe(true);
  });

  it("does NOT suppress live realtime items in steady state (post-catchup)", () => {
    expect(shouldSuppressSideEffects({ itemKind: "realtime", isCatchingUp: false })).toBe(false);
  });
});
