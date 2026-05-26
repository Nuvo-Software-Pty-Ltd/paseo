import { beforeEach, describe, expect, it } from "vitest";
import { shouldShowAbortBanner, useAbortedAgentsStore } from "./aborted-agents-store";

describe("aborted-agents store", () => {
  beforeEach(() => {
    useAbortedAgentsStore.getState().clearAll();
  });

  it("starts empty", () => {
    expect(useAbortedAgentsStore.getState().abortedAgentIds.size).toBe(0);
  });

  it("markAborted records the agent id with a timestamp", () => {
    useAbortedAgentsStore.getState().markAborted("agent-1");
    const ids = useAbortedAgentsStore.getState().abortedAgentIds;
    expect(ids.has("agent-1")).toBe(true);
    const ts = ids.get("agent-1");
    expect(typeof ts).toBe("number");
    if (ts) expect(ts).toBeGreaterThan(0);
  });

  it("clearAborted removes only the given id", () => {
    useAbortedAgentsStore.getState().markAborted("a");
    useAbortedAgentsStore.getState().markAborted("b");
    useAbortedAgentsStore.getState().clearAborted("a");
    const ids = useAbortedAgentsStore.getState().abortedAgentIds;
    expect(ids.has("a")).toBe(false);
    expect(ids.has("b")).toBe(true);
  });

  it("clearAll wipes the registry", () => {
    useAbortedAgentsStore.getState().markAborted("x");
    useAbortedAgentsStore.getState().clearAll();
    expect(useAbortedAgentsStore.getState().abortedAgentIds.size).toBe(0);
  });
});

describe("shouldShowAbortBanner", () => {
  it("returns true when user aborted AND agent is in terminal error state", () => {
    expect(
      shouldShowAbortBanner({
        agentStatus: "error",
        attentionReason: "error",
        isUserAborted: true,
      }),
    ).toBe(true);
  });

  it("returns false when user did NOT abort (real provider error)", () => {
    expect(
      shouldShowAbortBanner({
        agentStatus: "error",
        attentionReason: "error",
        isUserAborted: false,
      }),
    ).toBe(false);
  });

  it("returns false when agent is still running (deny just dispatched, terminal state pending)", () => {
    expect(
      shouldShowAbortBanner({
        agentStatus: "running",
        attentionReason: null,
        isUserAborted: true,
      }),
    ).toBe(false);
  });

  it("returns false for the graceful deny terminal state (idle/finished)", () => {
    expect(
      shouldShowAbortBanner({
        agentStatus: "idle",
        attentionReason: "finished",
        isUserAborted: true,
      }),
    ).toBe(false);
  });

  it("returns false when the user already cleared attention (banner has been dismissed)", () => {
    expect(
      shouldShowAbortBanner({
        agentStatus: "error",
        attentionReason: null,
        isUserAborted: true,
      }),
    ).toBe(false);
  });
});
