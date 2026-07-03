import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory AsyncStorage so we can assert the parsed token is persisted via the
// existing storeSessionToken path (which the native flow reuses verbatim).
vi.mock("@react-native-async-storage/async-storage", () => {
  const store = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve();
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
        return Promise.resolve();
      }),
    },
  };
});

// Native platform — exercises loginWithOAuthNative / the dispatcher's native arm.
vi.mock("@/constants/platform", () => ({ isWeb: false, isNative: true }));

// Controllable expo mocks (override the global vitest.setup.ts stubs).
const openAuthSessionAsync = vi.fn();
const createURL = vi.fn((path: string) => `paseo://${path}`);
vi.mock("expo-web-browser", () => ({
  openAuthSessionAsync: (...args: unknown[]) => openAuthSessionAsync(...args),
}));
vi.mock("expo-linking", () => ({
  createURL: (path: string) => createURL(path),
}));

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  hasSession,
  loginWithOAuthNative,
  loginWithOrchestra,
  parseSessionTokenFromRedirectUrl,
} from "./orchestra-cloud-client";

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJhY2NvdW50X2lkIjoiYWNjdF8xIn0.sig-part";

beforeEach(async () => {
  vi.clearAllMocks();
  await AsyncStorage.removeItem("orchestra:session_token");
  await AsyncStorage.removeItem("orchestra:refresh_token");
  delete process.env.EXPO_PUBLIC_ORCHESTRA_AUTH_URL;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseSessionTokenFromRedirectUrl", () => {
  const RT = "acct_1.fam_abc.secret-xyz";

  it("extracts the session token from the URL fragment (refresh null when absent)", () => {
    const parsed = parseSessionTokenFromRedirectUrl(`paseo://welcome#orchestra_session=${JWT}`);
    expect(parsed.token).toBe(JWT);
    expect(parsed.refreshToken).toBeNull();
  });

  it("extracts both session and refresh tokens when both are present", () => {
    const url = `paseo://welcome#orchestra_session=${JWT}&orchestra_refresh=${encodeURIComponent(RT)}`;
    const parsed = parseSessionTokenFromRedirectUrl(url);
    expect(parsed.token).toBe(JWT);
    expect(parsed.refreshToken).toBe(RT);
  });

  it("returns null token when there is no fragment", () => {
    expect(parseSessionTokenFromRedirectUrl("paseo://welcome").token).toBeNull();
    expect(
      parseSessionTokenFromRedirectUrl("paseo://welcome?orchestra_session=" + JWT).token,
    ).toBeNull();
  });

  it("returns null token when the fragment lacks the session key", () => {
    expect(parseSessionTokenFromRedirectUrl("paseo://welcome#offer=abc").token).toBeNull();
  });

  it("returns null token for an empty token value", () => {
    expect(parseSessionTokenFromRedirectUrl("paseo://welcome#orchestra_session=").token).toBeNull();
  });

  it("percent-decodes the token value and ignores unrelated params", () => {
    const url = `paseo://welcome#orchestra_session=${encodeURIComponent(JWT)}&foo=bar`;
    const parsed = parseSessionTokenFromRedirectUrl(url);
    expect(parsed.token).toBe(JWT);
    expect(parsed.refreshToken).toBeNull();
  });
});

describe("loginWithOAuthNative", () => {
  it("opens an auth session with return_to + platform=native and stores the parsed token", async () => {
    process.env.EXPO_PUBLIC_ORCHESTRA_AUTH_URL = "https://auth.example.test";
    openAuthSessionAsync.mockResolvedValueOnce({
      type: "success",
      url: `paseo://welcome#orchestra_session=${JWT}`,
    });

    expect(await hasSession()).toBe(false);
    const result = await loginWithOAuthNative();
    expect(result).toEqual({ accountId: "unknown" });

    // Redirect URI is derived from expo-linking and passed both as the auth
    // session's expected redirect and inside the start URL's return_to.
    expect(createURL).toHaveBeenCalledWith("welcome");
    const [authUrl, redirectUri] = openAuthSessionAsync.mock.calls[0] as [string, string];
    expect(redirectUri).toBe("paseo://welcome");
    expect(authUrl).toBe(
      "https://auth.example.test/oauth/github/start" +
        `?return_to=${encodeURIComponent("paseo://welcome")}&platform=native`,
    );

    // Token persisted via the existing storeSessionToken path.
    expect(await hasSession()).toBe(true);
    expect(await AsyncStorage.getItem("orchestra:session_token")).toBe(JWT);
  });

  it("stores the refresh token too when the redirect carries one", async () => {
    const RT = "acct_1.fam_abc.secret-xyz";
    openAuthSessionAsync.mockResolvedValueOnce({
      type: "success",
      url: `paseo://welcome#orchestra_session=${JWT}&orchestra_refresh=${encodeURIComponent(RT)}`,
    });
    await loginWithOAuthNative();
    expect(await AsyncStorage.getItem("orchestra:session_token")).toBe(JWT);
    // The web-resolved refresh-token store persists to AsyncStorage in tests.
    expect(await AsyncStorage.getItem("orchestra:refresh_token")).toBe(RT);
  });

  it("throws and stores nothing when the user cancels", async () => {
    openAuthSessionAsync.mockResolvedValueOnce({ type: "cancel" });
    await expect(loginWithOAuthNative()).rejects.toThrow(/did not complete \(cancel\)/);
    expect(await hasSession()).toBe(false);
  });

  it("throws when the redirect carries no session token", async () => {
    openAuthSessionAsync.mockResolvedValueOnce({ type: "success", url: "paseo://welcome#offer=x" });
    await expect(loginWithOAuthNative()).rejects.toThrow(/did not contain a session token/);
    expect(await hasSession()).toBe(false);
  });
});

describe("loginWithOrchestra dispatcher (native)", () => {
  it("routes to the native auth session when not on web", async () => {
    openAuthSessionAsync.mockResolvedValueOnce({
      type: "success",
      url: `paseo://welcome#orchestra_session=${JWT}`,
    });
    await loginWithOrchestra();
    expect(openAuthSessionAsync).toHaveBeenCalledOnce();
    expect(await hasSession()).toBe(true);
  });
});
