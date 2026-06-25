/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useProjectSource } from "./session-store-hooks";
import { useSessionStore } from "./session-store";

const SERVER_ID = "test-server";

function setServerInfoProjectSource(
  value: "local_and_github" | "github_only" | "local_only",
): void {
  act(() => {
    useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
    useSessionStore.getState().updateSessionServerInfo(SERVER_ID, {
      serverId: SERVER_ID,
      hostname: "host",
      version: "0.1.0",
      features: { projectSource: value },
    });
  });
}

afterEach(() => {
  act(() => {
    useSessionStore.getState().clearSession(SERVER_ID);
  });
});

describe("useProjectSource (T-5)", () => {
  it("defaults to local_and_github when no server info is present", () => {
    act(() => {
      useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
    });
    const { result } = renderHook(() => useProjectSource(SERVER_ID));
    expect(result.current).toBe("local_and_github");
  });

  it("reflects the daemon capability — github_only (cloud)", () => {
    setServerInfoProjectSource("github_only");
    const { result } = renderHook(() => useProjectSource(SERVER_ID));
    expect(result.current).toBe("github_only");
  });

  it("flips the source with no rebuild when the daemon capability changes", () => {
    setServerInfoProjectSource("github_only");
    const { result, rerender } = renderHook(() => useProjectSource(SERVER_ID));
    expect(result.current).toBe("github_only");

    setServerInfoProjectSource("local_only");
    rerender();
    expect(result.current).toBe("local_only");
  });

  it("returns local_and_github for a null serverId", () => {
    const { result } = renderHook(() => useProjectSource(null));
    expect(result.current).toBe("local_and_github");
  });
});
