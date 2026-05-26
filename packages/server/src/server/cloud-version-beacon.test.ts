import { createHmac } from "node:crypto";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import {
  readSdkVersion,
  resolveDaemonImageTag,
  sendDaemonVersionBeacon,
} from "./cloud-version-beacon.js";

const logger = pino({ level: "silent" });

describe("sendDaemonVersionBeacon", () => {
  it("POSTs to /api/auth-internal/daemon-versions with HMAC signature and the contract body shape", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await sendDaemonVersionBeacon({
      authServiceBaseUrl: "https://auth.example.com",
      hmacKey: "test-key",
      daemonImageTag: "sha-deadbeef",
      logger,
      fetchImpl,
      resolveCliVersion: async () => "2.1.145",
      resolveSdkVersion: () => "0.2.133",
    });

    expect(result).toEqual({ ok: true, status: 200 });
    expect(capturedUrl).toBe("https://auth.example.com/api/auth-internal/daemon-versions");
    expect(capturedInit?.method).toBe("POST");

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Orchestra-Internal-HMAC"]).toMatch(/^[a-f0-9]{64}$/);

    const bodyString = String(capturedInit?.body);
    expect(JSON.parse(bodyString)).toEqual({
      cliVersion: "2.1.145",
      sdkVersion: "0.2.133",
      daemonImageTag: "sha-deadbeef",
    });

    const expectedHmac = createHmac("sha256", "test-key").update(bodyString).digest("hex");
    expect(headers["X-Orchestra-Internal-HMAC"]).toBe(expectedHmac);
  });

  it("strips trailing slash from authServiceBaseUrl", async () => {
    let capturedUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await sendDaemonVersionBeacon({
      authServiceBaseUrl: "https://auth.example.com/",
      hmacKey: "k",
      daemonImageTag: "t",
      logger,
      fetchImpl,
      resolveCliVersion: async () => "2.1.0",
      resolveSdkVersion: () => "0.2.0",
    });

    expect(capturedUrl).toBe("https://auth.example.com/api/auth-internal/daemon-versions");
  });

  it("falls back to 'unknown' when the CLI version probe returns null", async () => {
    let capturedBody = "";
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = String(init?.body);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await sendDaemonVersionBeacon({
      authServiceBaseUrl: "https://auth.example.com",
      hmacKey: "k",
      daemonImageTag: "t",
      logger,
      fetchImpl,
      resolveCliVersion: async () => null,
      resolveSdkVersion: () => "0.2.133",
    });

    expect(JSON.parse(capturedBody)).toEqual({
      cliVersion: "unknown",
      sdkVersion: "0.2.133",
      daemonImageTag: "t",
    });
  });

  it("clamps any version field longer than 64 chars", async () => {
    let capturedBody = "";
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = String(init?.body);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const longTag = "a".repeat(200);
    await sendDaemonVersionBeacon({
      authServiceBaseUrl: "https://auth.example.com",
      hmacKey: "k",
      daemonImageTag: longTag,
      logger,
      fetchImpl,
      resolveCliVersion: async () => "2.1.145",
      resolveSdkVersion: () => "0.2.133",
    });

    const body = JSON.parse(capturedBody) as Record<string, string>;
    expect(body.daemonImageTag.length).toBe(64);
    expect(body.daemonImageTag).toBe("a".repeat(64));
  });

  it("returns ok:false (does not throw) when fetch rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await sendDaemonVersionBeacon({
      authServiceBaseUrl: "https://auth.example.com",
      hmacKey: "k",
      daemonImageTag: "t",
      logger,
      fetchImpl,
      resolveCliVersion: async () => "2.1.145",
      resolveSdkVersion: () => "0.2.133",
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined();
  });

  it("returns ok:false with the status code when auth service replies non-2xx", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("forbidden", { status: 401 }),
    ) as unknown as typeof fetch;

    const result = await sendDaemonVersionBeacon({
      authServiceBaseUrl: "https://auth.example.com",
      hmacKey: "k",
      daemonImageTag: "t",
      logger,
      fetchImpl,
      resolveCliVersion: async () => "2.1.145",
      resolveSdkVersion: () => "0.2.133",
    });

    expect(result).toEqual({ ok: false, status: 401 });
  });
});

describe("readSdkVersion", () => {
  it("returns the SDK package.json version string", () => {
    expect(readSdkVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("resolveDaemonImageTag", () => {
  it("returns PASEO_DAEMON_IMAGE_TAG when set", () => {
    const prev = process.env.PASEO_DAEMON_IMAGE_TAG;
    process.env.PASEO_DAEMON_IMAGE_TAG = "sha-cafef00d";
    try {
      expect(resolveDaemonImageTag()).toBe("sha-cafef00d");
    } finally {
      if (prev === undefined) delete process.env.PASEO_DAEMON_IMAGE_TAG;
      else process.env.PASEO_DAEMON_IMAGE_TAG = prev;
    }
  });

  it("falls back to 'unknown' when PASEO_DAEMON_IMAGE_TAG is unset", () => {
    const prev = process.env.PASEO_DAEMON_IMAGE_TAG;
    delete process.env.PASEO_DAEMON_IMAGE_TAG;
    try {
      expect(resolveDaemonImageTag()).toBe("unknown");
    } finally {
      if (prev !== undefined) process.env.PASEO_DAEMON_IMAGE_TAG = prev;
    }
  });
});
