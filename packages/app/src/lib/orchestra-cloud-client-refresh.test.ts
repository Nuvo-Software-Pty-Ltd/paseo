import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory AsyncStorage — the web-resolved refresh-token store persists here in
// tests (vitest resolves the `.web` adapter variant), so both the access token
// and the refresh token live in this map.
vi.mock("@react-native-async-storage/async-storage", () => {
  const store = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
      setItem: vi.fn((k: string, v: string) => {
        store.set(k, v);
        return Promise.resolve();
      }),
      removeItem: vi.fn((k: string) => {
        store.delete(k);
        return Promise.resolve();
      }),
    },
  };
});

vi.mock("@/constants/platform", () => ({ isWeb: true, isNative: false }));

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  listWorkspaces,
  clearSession,
  hasSession,
  OrchestraSessionExpiredError,
  onOrchestraSessionExpired,
} from "./orchestra-cloud-client";

const AT_KEY = "orchestra:session_token";
const RT_KEY = "orchestra:refresh_token";
const RT = "acct_1.fam_abc.secret-current";

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// Minimal decodable JWT: `hdr.<base64url({exp,...})>.sig`. Only `exp` matters —
// decodeAccessTokenExp reads it to drive proactive refresh.
function jwt(expEpoch: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expEpoch, account_id: "acct_1" })).toString(
    "base64url",
  );
  return `hdr.${payload}.sig`;
}

async function seed(at: string | null, rt: string | null): Promise<void> {
  if (at) await AsyncStorage.setItem(AT_KEY, at);
  else await AsyncStorage.removeItem(AT_KEY);
  if (rt) await AsyncStorage.setItem(RT_KEY, rt);
  else await AsyncStorage.removeItem(RT_KEY);
}

interface Reply {
  status: number;
  body?: unknown;
}
type Handler = (url: string, init: RequestInit) => Reply | Promise<Reply>;

function routeFetch(handler: Handler): void {
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const { status, body } = await handler(String(input), init ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body ?? {}),
      text: () => Promise.resolve(JSON.stringify(body ?? {})),
    } as Response;
  }) as unknown as typeof fetch;
}

function bearerOf(init: RequestInit): string | undefined {
  const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
  return auth?.replace(/^Bearer /, "");
}

let bounces = 0;
let unsub: (() => void) | null = null;

beforeEach(async () => {
  vi.clearAllMocks();
  await seed(null, null);
  bounces = 0;
  unsub = onOrchestraSessionExpired(() => {
    bounces++;
  });
});

afterEach(() => {
  unsub?.();
  vi.restoreAllMocks();
});

describe("authedFetch reactive refresh", () => {
  it("a 401 triggers one refresh + one retry and does NOT bounce", async () => {
    await seed(jwt(nowSec() + 3600), RT); // AT valid → no proactive; API forces the 401
    let apiCalls = 0;
    let refreshCalls = 0;
    routeFetch((url) => {
      if (url.includes("/session/refresh")) {
        refreshCalls++;
        return {
          status: 200,
          body: { token: jwt(nowSec() + 3600), refreshToken: "acct_1.fam_abc.secret-2" },
        };
      }
      apiCalls++;
      return apiCalls === 1 ? { status: 401 } : { status: 200, body: { workspaces: [] } };
    });

    await expect(listWorkspaces()).resolves.toEqual([]);
    expect(refreshCalls).toBe(1);
    expect(apiCalls).toBe(2); // original + retry
    expect(bounces).toBe(0);
    expect(await AsyncStorage.getItem(RT_KEY)).toBe("acct_1.fam_abc.secret-2"); // rotated + stored
  });

  it("a failed refresh (401) bounces exactly once and clears the refresh token", async () => {
    await seed(jwt(nowSec() + 3600), RT);
    routeFetch((url) =>
      url.includes("/session/refresh")
        ? { status: 401, body: { code: "refresh_invalid" } }
        : { status: 401 },
    );

    await expect(listWorkspaces()).rejects.toBeInstanceOf(OrchestraSessionExpiredError);
    expect(bounces).toBe(1);
    expect(await AsyncStorage.getItem(RT_KEY)).toBeNull(); // cleared
  });

  it("a transient refresh failure (404 old auth) bounces but RETAINS the refresh token", async () => {
    await seed(jwt(nowSec() + 3600), RT);
    routeFetch((url) => (url.includes("/session/refresh") ? { status: 404 } : { status: 401 }));

    await expect(listWorkspaces()).rejects.toBeInstanceOf(OrchestraSessionExpiredError);
    expect(bounces).toBe(1);
    expect(await AsyncStorage.getItem(RT_KEY)).toBe(RT); // retained — not authoritatively dead
  });

  it("cross-tab race: refresh 401 but the stored token already rotated → retry, no bounce", async () => {
    await seed(jwt(nowSec() + 3600), "rt-old");
    let apiCalls = 0;
    routeFetch(async (url) => {
      if (url.includes("/session/refresh")) {
        // A concurrent tab already rotated the tokens out from under us.
        await AsyncStorage.setItem(RT_KEY, "rt-new");
        await AsyncStorage.setItem(AT_KEY, jwt(nowSec() + 3600));
        return { status: 401 };
      }
      apiCalls++;
      return apiCalls === 1 ? { status: 401 } : { status: 200, body: { workspaces: [] } };
    });

    await expect(listWorkspaces()).resolves.toEqual([]);
    expect(bounces).toBe(0);
    expect(await AsyncStorage.getItem(RT_KEY)).toBe("rt-new"); // winner's token preserved
  });
});

describe("authedFetch proactive refresh", () => {
  it("refreshes BEFORE the API call when the access token is near expiry", async () => {
    await seed(jwt(nowSec() + 60), RT); // 60s < 300s skew → proactive
    const freshAt = jwt(nowSec() + 3600);
    let apiBearer: string | undefined;
    let refreshCalls = 0;
    routeFetch((url, init) => {
      if (url.includes("/session/refresh")) {
        refreshCalls++;
        return { status: 200, body: { token: freshAt, refreshToken: "acct_1.fam_abc.secret-2" } };
      }
      apiBearer = bearerOf(init);
      return { status: 200, body: { workspaces: [] } };
    });

    await listWorkspaces();
    expect(refreshCalls).toBe(1);
    expect(apiBearer).toBe(freshAt); // API used the freshly-minted token
    expect(bounces).toBe(0);
  });

  it("collapses concurrent near-expiry calls into a SINGLE refresh (single-flight)", async () => {
    await seed(jwt(nowSec() + 60), RT);
    let refreshCalls = 0;
    routeFetch((url) => {
      if (url.includes("/session/refresh")) {
        refreshCalls++;
        return {
          status: 200,
          body: { token: jwt(nowSec() + 3600), refreshToken: "acct_1.fam_abc.secret-2" },
        };
      }
      return { status: 200, body: { workspaces: [] } };
    });

    await Promise.all([listWorkspaces(), listWorkspaces(), listWorkspaces()]);
    expect(refreshCalls).toBe(1);
  });

  it("degrades to the still-valid access token when a proactive refresh is unavailable (404)", async () => {
    await seed(jwt(nowSec() + 60), RT);
    let apiCalls = 0;
    routeFetch((url) => {
      if (url.includes("/session/refresh")) return { status: 404 }; // old auth
      apiCalls++;
      return { status: 200, body: { workspaces: [] } };
    });

    await expect(listWorkspaces()).resolves.toEqual([]); // no bounce — used the live AT
    expect(apiCalls).toBe(1);
    expect(bounces).toBe(0);
    expect(await AsyncStorage.getItem(RT_KEY)).toBe(RT);
  });
});

describe("hasSession / clearSession", () => {
  it("hasSession is true with only a refresh token (expired AT cold start)", async () => {
    await seed(null, RT);
    expect(await hasSession()).toBe(true);
    await seed(null, null);
    expect(await hasSession()).toBe(false);
  });

  it("clearSession fires a best-effort logout and clears BOTH tokens", async () => {
    await seed(jwt(nowSec() + 3600), RT);
    let logoutBody: { refreshToken?: string } | null = null;
    routeFetch((url, init) => {
      if (url.includes("/session/logout")) {
        logoutBody = JSON.parse(String(init.body)) as { refreshToken?: string };
        return { status: 204 };
      }
      return { status: 200 };
    });

    await clearSession();
    expect(await AsyncStorage.getItem(AT_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(RT_KEY)).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1); // logout was invoked (fire-and-forget)
    expect(logoutBody).toEqual({ refreshToken: RT });
  });
});
