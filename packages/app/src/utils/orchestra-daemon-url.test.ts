import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deriveDaemonWsUrlForWorkspace,
  hyphenizeWorkspaceIdForHostname,
} from "./orchestra-daemon-url";

const ENV_KEYS = [
  "EXPO_PUBLIC_ORCHESTRA_DAEMON_WS_URL",
  "EXPO_PUBLIC_ORCHESTRA_DAEMON_HOSTNAME_SUFFIX",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    snapshot[key] = process.env[key];
  }
  return snapshot;
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("hyphenizeWorkspaceIdForHostname", () => {
  it("replaces every underscore with a hyphen (D-3.3 ALB host-header rule)", () => {
    expect(hyphenizeWorkspaceIdForHostname("ws_74d480de")).toBe("ws-74d480de");
  });

  it("converts every underscore, not just the first", () => {
    expect(hyphenizeWorkspaceIdForHostname("ws_a_b_c")).toBe("ws-a-b-c");
  });

  it("leaves workspaceIds without underscores untouched", () => {
    expect(hyphenizeWorkspaceIdForHostname("ws-already-hyphenized")).toBe("ws-already-hyphenized");
  });

  it("does not touch case (workspaceIds are lowercase by convention but we don't enforce)", () => {
    expect(hyphenizeWorkspaceIdForHostname("WS_ABCDEF12")).toBe("WS-ABCDEF12");
  });
});

describe("deriveDaemonWsUrlForWorkspace — default derivation", () => {
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    delete process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_WS_URL;
    delete process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_HOSTNAME_SUFFIX;
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
  });

  it("derives wss://<hyphenized-wsId>.dev.orchestra.nuvo.software/ws by default", () => {
    expect(deriveDaemonWsUrlForWorkspace("ws_74d480de")).toBe(
      "wss://ws-74d480de.dev.orchestra.nuvo.software/ws",
    );
  });

  it("hyphenizes every underscore in the workspaceId (the D-3.3 edge case)", () => {
    expect(deriveDaemonWsUrlForWorkspace("ws_a_b_c")).toBe(
      "wss://ws-a-b-c.dev.orchestra.nuvo.software/ws",
    );
  });

  it("trims whitespace around the workspaceId", () => {
    expect(deriveDaemonWsUrlForWorkspace("  ws_74d480de  ")).toBe(
      "wss://ws-74d480de.dev.orchestra.nuvo.software/ws",
    );
  });

  it("throws when workspaceId is empty (D-3.4 caller contract)", () => {
    expect(() => deriveDaemonWsUrlForWorkspace("")).toThrow(/workspaceId is required/);
  });

  it("throws when workspaceId is only whitespace", () => {
    expect(() => deriveDaemonWsUrlForWorkspace("   ")).toThrow(/workspaceId is required/);
  });
});

describe("deriveDaemonWsUrlForWorkspace — hostname-suffix override", () => {
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    delete process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_WS_URL;
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
  });

  it("uses EXPO_PUBLIC_ORCHESTRA_DAEMON_HOSTNAME_SUFFIX when set", () => {
    process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_HOSTNAME_SUFFIX = "orchestra.nuvo.software";
    expect(deriveDaemonWsUrlForWorkspace("ws_74d480de")).toBe(
      "wss://ws-74d480de.orchestra.nuvo.software/ws",
    );
  });

  it("accepts a suffix with a leading dot (normalizes to single dot join)", () => {
    process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_HOSTNAME_SUFFIX = ".staging.orchestra.nuvo.software";
    expect(deriveDaemonWsUrlForWorkspace("ws_74d480de")).toBe(
      "wss://ws-74d480de.staging.orchestra.nuvo.software/ws",
    );
  });

  it("accepts a suffix without a leading dot", () => {
    process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_HOSTNAME_SUFFIX = "staging.orchestra.nuvo.software";
    expect(deriveDaemonWsUrlForWorkspace("ws_74d480de")).toBe(
      "wss://ws-74d480de.staging.orchestra.nuvo.software/ws",
    );
  });

  it("falls back to the default suffix when the env var is set to an empty string", () => {
    process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_HOSTNAME_SUFFIX = "";
    expect(deriveDaemonWsUrlForWorkspace("ws_74d480de")).toBe(
      "wss://ws-74d480de.dev.orchestra.nuvo.software/ws",
    );
  });
});

describe("deriveDaemonWsUrlForWorkspace — dev-only EXPO_PUBLIC_ORCHESTRA_DAEMON_WS_URL override", () => {
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
  });

  it("returns the override verbatim when it's already a ws:// URL (local daemon)", () => {
    process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_WS_URL = "ws://localhost:6767/ws";
    // workspaceId is ignored when override is set — that's the dev-mode contract.
    expect(deriveDaemonWsUrlForWorkspace("ws_anything")).toBe("ws://localhost:6767/ws");
  });

  it("returns the override verbatim when it's a wss:// URL", () => {
    process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_WS_URL =
      "wss://ws-74d480de.dev.orchestra.nuvo.software/ws";
    expect(deriveDaemonWsUrlForWorkspace("ws_different")).toBe(
      "wss://ws-74d480de.dev.orchestra.nuvo.software/ws",
    );
  });

  it("coerces an HTTPS override into wss + /ws (matches pre-D-3.4 dev behavior)", () => {
    process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_WS_URL =
      "https://ws-74d480de.dev.orchestra.nuvo.software";
    expect(deriveDaemonWsUrlForWorkspace("ws_ignored")).toBe(
      "wss://ws-74d480de.dev.orchestra.nuvo.software/ws",
    );
  });

  it("coerces an HTTP override into ws + /ws", () => {
    process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_WS_URL = "http://localhost:6767";
    expect(deriveDaemonWsUrlForWorkspace("ws_ignored")).toBe("ws://localhost:6767/ws");
  });

  it("strips trailing slashes from an HTTP override before appending /ws", () => {
    process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_WS_URL = "http://localhost:6767/";
    expect(deriveDaemonWsUrlForWorkspace("ws_ignored")).toBe("ws://localhost:6767/ws");
  });

  it("ignores the override when set to an empty string and falls through to derivation", () => {
    process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_WS_URL = "";
    delete process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_HOSTNAME_SUFFIX;
    expect(deriveDaemonWsUrlForWorkspace("ws_74d480de")).toBe(
      "wss://ws-74d480de.dev.orchestra.nuvo.software/ws",
    );
  });

  it("ignores the override when set to whitespace and falls through to derivation", () => {
    process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_WS_URL = "   ";
    delete process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_HOSTNAME_SUFFIX;
    expect(deriveDaemonWsUrlForWorkspace("ws_74d480de")).toBe(
      "wss://ws-74d480de.dev.orchestra.nuvo.software/ws",
    );
  });

  it("bypasses the empty-workspaceId guard when the override is set (dev convenience)", () => {
    process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_WS_URL = "ws://localhost:6767/ws";
    // No throw — dev mode lets the override stand in for the workspaceId.
    expect(deriveDaemonWsUrlForWorkspace("")).toBe("ws://localhost:6767/ws");
  });
});
