import { describe, it, expect, afterEach } from "vitest";
import {
  filterWelcomeActions,
  isSelfHostWelcomeAction,
  type WelcomeActionKey,
} from "./welcome-actions";
import { isSelfHostConnectionsEnabled } from "@/constants/feature-flags";

const webActions: { key: WelcomeActionKey }[] = [
  { key: "orchestra-cloud" },
  { key: "direct-connection" },
  { key: "paste-pairing-link" },
];

// Mirrors the native welcome list: cloud login first, then the self-host
// methods (including scan-qr, which only exists on native).
const nativeActions: { key: WelcomeActionKey }[] = [
  { key: "orchestra-cloud" },
  { key: "scan-qr" },
  { key: "direct-connection" },
  { key: "paste-pairing-link" },
];

describe("isSelfHostWelcomeAction", () => {
  it("classifies the self-host connection methods", () => {
    expect(isSelfHostWelcomeAction("scan-qr")).toBe(true);
    expect(isSelfHostWelcomeAction("direct-connection")).toBe(true);
    expect(isSelfHostWelcomeAction("paste-pairing-link")).toBe(true);
  });

  it("does not classify the cloud login action as self-host", () => {
    expect(isSelfHostWelcomeAction("orchestra-cloud")).toBe(false);
  });
});

describe("filterWelcomeActions", () => {
  it("keeps every action when self-host is enabled", () => {
    expect(filterWelcomeActions(webActions, true)).toEqual(webActions);
  });

  it("leaves only the cloud login action when self-host is disabled", () => {
    expect(filterWelcomeActions(webActions, false)).toEqual([{ key: "orchestra-cloud" }]);
  });

  it("leaves only the cloud login action on a native cloud build (self-host disabled)", () => {
    // Guards the native cloud build: scan-qr/direct/paste are dropped, but
    // "Connect to Orchestra" must remain so native sign-in is reachable.
    expect(filterWelcomeActions(nativeActions, false)).toEqual([{ key: "orchestra-cloud" }]);
  });

  it("keeps every native action when self-host is enabled", () => {
    expect(filterWelcomeActions(nativeActions, true)).toEqual(nativeActions);
  });
});

describe("isSelfHostConnectionsEnabled", () => {
  const saved = process.env.EXPO_PUBLIC_SELF_HOST_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.EXPO_PUBLIC_SELF_HOST_ENABLED;
    else process.env.EXPO_PUBLIC_SELF_HOST_ENABLED = saved;
  });

  it("defaults to enabled when unset", () => {
    delete process.env.EXPO_PUBLIC_SELF_HOST_ENABLED;
    expect(isSelfHostConnectionsEnabled()).toBe(true);
  });

  it("stays enabled for any value other than 'false'", () => {
    process.env.EXPO_PUBLIC_SELF_HOST_ENABLED = "true";
    expect(isSelfHostConnectionsEnabled()).toBe(true);
  });

  it("is disabled only when explicitly 'false'", () => {
    process.env.EXPO_PUBLIC_SELF_HOST_ENABLED = "false";
    expect(isSelfHostConnectionsEnabled()).toBe(false);
  });
});
