import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEnvironment, getPosthogHost, getPosthogKey, isPosthogEnabled } from "./config";

const ENV_KEYS = [
  "EXPO_PUBLIC_POSTHOG_KEY",
  "EXPO_PUBLIC_POSTHOG_HOST",
  "EXPO_PUBLIC_ORCHESTRA_DAEMON_HOSTNAME_SUFFIX",
] as const;

describe("posthog config", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("is disabled when no key is set (self-host posture)", () => {
    expect(getPosthogKey()).toBeUndefined();
    expect(isPosthogEnabled()).toBe(false);
  });

  it("is enabled when a key is set", () => {
    process.env.EXPO_PUBLIC_POSTHOG_KEY = "phc_test";
    expect(getPosthogKey()).toBe("phc_test");
    expect(isPosthogEnabled()).toBe(true);
  });

  it("treats a blank key as disabled", () => {
    process.env.EXPO_PUBLIC_POSTHOG_KEY = "   ";
    expect(getPosthogKey()).toBeUndefined();
    expect(isPosthogEnabled()).toBe(false);
  });

  it("defaults host to US cloud and allows an override", () => {
    expect(getPosthogHost()).toBe("https://us.i.posthog.com");
    process.env.EXPO_PUBLIC_POSTHOG_HOST = "https://eu.i.posthog.com";
    expect(getPosthogHost()).toBe("https://eu.i.posthog.com");
  });

  it("derives environment from the daemon hostname suffix", () => {
    expect(getEnvironment()).toBe("dev"); // default suffix is dev.orchestra.nuvo.software
    process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_HOSTNAME_SUFFIX = "staging.orchestra.nuvo.software";
    expect(getEnvironment()).toBe("staging");
    process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_HOSTNAME_SUFFIX = "orchestra.nuvo.software";
    expect(getEnvironment()).toBe("prod");
    process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_HOSTNAME_SUFFIX = "dev.orchestra.nuvo.software";
    expect(getEnvironment()).toBe("dev");
  });
});
