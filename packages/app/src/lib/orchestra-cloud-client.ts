import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { isWeb } from "@/constants/platform";
import { deriveDaemonWsUrlForWorkspace } from "@/utils/orchestra-daemon-url";
import {
  clearRefreshToken,
  getRefreshToken,
  storeRefreshToken,
} from "./orchestra-refresh-token-store";

const SESSION_TOKEN_KEY = "orchestra:session_token";

const DEFAULT_AUTH_URL = "https://auth.dev.orchestra.nuvo.software";

export function getAuthBaseUrl(): string {
  return process.env.EXPO_PUBLIC_ORCHESTRA_AUTH_URL?.trim() || DEFAULT_AUTH_URL;
}

export type CloudWorkspaceState = "active" | "suspended" | "billing_locked" | "archived";

const CLOUD_WORKSPACE_STATES: ReadonlySet<CloudWorkspaceState> = new Set([
  "active",
  "suspended",
  "billing_locked",
  "archived",
]);

export interface WorkspaceRecord {
  workspaceId: string;
  accountId: string;
  repoUrl: string | null;
  displayName: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  // COMPAT(workspaceState): added in v0.1.X (D-2). Both fields are tolerant —
  // the wire shape may omit them on old daemons; the normalizer defaults state
  // to "active" and archivedAt to null. Drop the defaults when daemon floor
  // >= the version that always sends state + archivedAt.
  state: CloudWorkspaceState;
  archivedAt: string | null;
}

function normalizeWorkspaceRecord(raw: unknown): WorkspaceRecord {
  const record = raw as Partial<WorkspaceRecord> & Record<string, unknown>;
  // The cloud list/get endpoints serialize the DDB `status` attribute and do
  // not emit `state`; fall back to `status` so archived / billing_locked
  // workspaces bucket and route correctly instead of defaulting to "active".
  const rawState = record.state ?? record.status;
  const state: CloudWorkspaceState =
    typeof rawState === "string" && CLOUD_WORKSPACE_STATES.has(rawState as CloudWorkspaceState)
      ? (rawState as CloudWorkspaceState)
      : "active";
  const rawArchivedAt = record.archivedAt;
  const archivedAt = typeof rawArchivedAt === "string" ? rawArchivedAt : null;
  return {
    workspaceId: String(record.workspaceId ?? ""),
    accountId: String(record.accountId ?? ""),
    repoUrl: (record.repoUrl as string | null | undefined) ?? null,
    displayName: String(record.displayName ?? ""),
    status: String(record.status ?? ""),
    createdAt: String(record.createdAt ?? ""),
    updatedAt: String(record.updatedAt ?? ""),
    state,
    archivedAt,
  };
}

export class OrchestraSessionExpiredError extends Error {
  constructor() {
    super("Orchestra session expired — please sign in again");
    this.name = "OrchestraSessionExpiredError";
  }
}

type SessionExpiredListener = () => void;
const sessionExpiredListeners = new Set<SessionExpiredListener>();

export function onOrchestraSessionExpired(listener: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(listener);
  return () => {
    sessionExpiredListeners.delete(listener);
  };
}

function signalSessionExpired(): void {
  // Fan out synchronously so the centralized provider can debounce concurrent
  // 401s into a single bounce. Listeners must be cheap and side-effect-free
  // beyond enqueueing the bounce.
  for (const listener of sessionExpiredListeners) {
    try {
      listener();
    } catch (error) {
      console.warn("[Orchestra] session-expired listener threw", error);
    }
  }
}

async function getSessionToken(): Promise<string | null> {
  return AsyncStorage.getItem(SESSION_TOKEN_KEY);
}

const SESSION_REFRESH_PATH = "/api/v1/cloud/session/refresh";
const SESSION_LOGOUT_PATH = "/api/v1/cloud/session/logout";

// Proactively refresh when the access token is within this window of its `exp`,
// so an in-flight request rarely races the 1h expiry. Purely a client-side
// heuristic on the decoded (UNVERIFIED) `exp` — the server is the source of
// truth on validity, and a skewed clock only costs an extra refresh round-trip,
// never a bounce.
const ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 300;

// Thrown when a refresh is unavailable/transient (no refresh token yet, old
// auth without the route (404), 5xx, offline). Distinct from an authoritative
// rejection (OrchestraSessionExpiredError): a transient failure degrades to the
// still-valid access token instead of bouncing.
class RefreshUnavailableError extends Error {}

// Decode a JWT's `exp` (epoch seconds) WITHOUT verifying the signature — this
// only drives proactive-refresh timing. Buffer is polyfilled app-wide; convert
// base64url→base64 first since the "base64" decoder doesn't remap -/_.
function decodeAccessTokenExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

// Single-flight guard: N concurrent 401s (or near-expiry calls) collapse into
// ONE /refresh round-trip. Every caller awaits the same promise; it clears on
// settle so the next cycle starts fresh.
let refreshSessionInFlight: Promise<string> | null = null;

function refreshSession(): Promise<string> {
  if (!refreshSessionInFlight) {
    refreshSessionInFlight = doRefreshSession().finally(() => {
      refreshSessionInFlight = null;
    });
  }
  return refreshSessionInFlight;
}

async function doRefreshSession(): Promise<string> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) {
    throw new RefreshUnavailableError("no refresh token");
  }
  // Plain fetch — NOT authedFetch — so a refresh never recurses through the
  // 401 interceptor.
  let res: Response;
  try {
    res = await fetch(`${getAuthBaseUrl()}${SESSION_REFRESH_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    throw new RefreshUnavailableError("refresh request failed"); // offline/network
  }

  if (res.ok) {
    const body = (await res.json().catch(() => null)) as {
      token?: unknown;
      refreshToken?: unknown;
    } | null;
    if (!body || typeof body.token !== "string" || typeof body.refreshToken !== "string") {
      throw new RefreshUnavailableError("malformed refresh response");
    }
    await storeSessionToken(body.token);
    await storeRefreshToken(body.refreshToken);
    return body.token;
  }

  if (res.status === 401) {
    // The server rejected THIS refresh token. A concurrent refresher (another
    // tab) may already have rotated it — if the stored token changed out from
    // under us, retry against the winner's fresh access token rather than bounce.
    const latest = await getRefreshToken();
    if (latest && latest !== refreshToken) {
      const at = await getSessionToken();
      if (at) return at;
    }
    await clearRefreshToken();
    throw new OrchestraSessionExpiredError(); // authoritative — caller bounces
  }

  // 404 (old auth) / 5xx — transient. Retain the refresh token; the caller
  // degrades to the current access token.
  throw new RefreshUnavailableError(`refresh failed: ${res.status}`);
}

// Resolve an access token to attach, refreshing proactively when the current
// one is near expiry. Replaces the old requireSessionToken; callers of
// authedFetch see no API change.
async function getFreshAccessToken(): Promise<string> {
  const at = await getSessionToken();
  const exp = at ? decodeAccessTokenExp(at) : null;
  const nowSeconds = Date.now() / 1000;
  if (at && exp !== null && exp - nowSeconds > ACCESS_TOKEN_REFRESH_SKEW_SECONDS) {
    return at; // comfortably valid — no refresh
  }
  const rt = await getRefreshToken();
  if (!rt) {
    // Legacy AT-only session (or signed out) — preserve prior behavior exactly.
    if (at) return at;
    signalSessionExpired();
    throw new OrchestraSessionExpiredError();
  }
  try {
    return await refreshSession();
  } catch (err) {
    if (err instanceof OrchestraSessionExpiredError) {
      signalSessionExpired();
      throw err;
    }
    // Transient/unavailable refresh — degrade to the live access token so a
    // deploy-window 404 / offline blip near expiry doesn't bounce.
    if (at) return at;
    signalSessionExpired();
    throw new OrchestraSessionExpiredError();
  }
}

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${getAuthBaseUrl()}${path}`;
  const doFetch = (bearer: string): Promise<Response> =>
    fetch(url, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
    });

  const res = await doFetch(await getFreshAccessToken());
  if (res.status !== 401) {
    return res;
  }

  // Reactive path: the access token was rejected. The AT is already bad, so ANY
  // refresh failure here (dead or transient) is unrecoverable → one bounce.
  let freshToken: string;
  try {
    freshToken = await refreshSession();
  } catch {
    signalSessionExpired();
    throw new OrchestraSessionExpiredError();
  }
  const retry = await doFetch(freshToken);
  if (retry.status === 401) {
    // A freshly-minted access token still rejected → server-side account
    // problem, not a stale token.
    signalSessionExpired();
    throw new OrchestraSessionExpiredError();
  }
  return retry;
}

export async function storeSessionToken(token: string): Promise<void> {
  await AsyncStorage.setItem(SESSION_TOKEN_KEY, token);
}

export async function clearSession(): Promise<void> {
  // Best-effort server-side revoke — fire-and-forget so a hanging/offline
  // logout never stalls the caller (the session bounce awaits clearSession
  // before it navigates). The local clear is what actually ends the session.
  const refreshToken = await getRefreshToken();
  if (refreshToken) {
    void fetch(`${getAuthBaseUrl()}${SESSION_LOGOUT_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => {
      // ignore — logout is best-effort; the family also dies at its 30d expiry
    });
  }
  await AsyncStorage.removeItem(SESSION_TOKEN_KEY);
  await clearRefreshToken();
}

export async function hasSession(): Promise<boolean> {
  // A live refresh token counts as a session even if the access token has
  // expired — a cold start with only the RT must not flash the welcome screen.
  const [at, rt] = await Promise.all([getSessionToken(), getRefreshToken()]);
  return at !== null || rt !== null;
}

// The native OAuth redirect carries the session JWT in the URL FRAGMENT
// (#orchestra_session=<jwt>) rather than the query string, so the token never
// lands in server access logs or a Referer header. Keep this in sync with the
// auth service's native delivery in oauth-github.ts.
const SESSION_FRAGMENT_KEY = "orchestra_session";
const REFRESH_FRAGMENT_KEY = "orchestra_refresh";

export interface ParsedRedirectTokens {
  token: string | null;
  refreshToken: string | null;
}

// Pure extractor: pull the session + refresh tokens out of the deep-link URL
// that ASWebAuthenticationSession hands back. Exported for unit testing.
// URLSearchParams handles the multi-param fragment and percent-decoding; a
// missing/empty value yields null. A null `token` means a failed sign-in; a
// null `refreshToken` is normal against an auth service that predates 30-day
// sessions (the caller then keeps a legacy 1h session).
export function parseSessionTokenFromRedirectUrl(url: string): ParsedRedirectTokens {
  const hashIndex = url.indexOf("#");
  if (hashIndex === -1) {
    return { token: null, refreshToken: null };
  }
  const params = new URLSearchParams(url.slice(hashIndex + 1));
  const token = params.get(SESSION_FRAGMENT_KEY)?.trim();
  const refreshToken = params.get(REFRESH_FRAGMENT_KEY)?.trim();
  return {
    token: token ? token : null,
    refreshToken: refreshToken ? refreshToken : null,
  };
}

// Native sign-in handshake. Opens the GitHub OAuth flow in an in-app auth
// session (ASWebAuthenticationSession on iOS / Custom Tab on Android) and waits
// for the auth service to 302-redirect back to the app's `paseo://welcome`
// deep link with the session token in the fragment. The redirect URI MUST match
// the auth service's native allowlist (ORCHESTRA_NATIVE_REDIRECT_URIS; dev
// default "paseo://welcome").
export async function loginWithOAuthNative(): Promise<{ accountId: string }> {
  if (isWeb) {
    return Promise.reject(new Error("Native OAuth login is not available on web — use the popup"));
  }

  // For a standalone build (scheme `paseo`) this resolves to "paseo://welcome".
  const redirectUri = Linking.createURL("welcome");
  const authUrl =
    `${getAuthBaseUrl()}/oauth/github/start` +
    `?return_to=${encodeURIComponent(redirectUri)}&platform=native`;

  const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUri);
  if (result.type !== "success") {
    // cancel / dismiss / locked — the user backed out or the session closed
    // without a redirect. Surface a typed-ish error for the caller to log.
    throw new Error(`Orchestra sign-in did not complete (${result.type})`);
  }

  const { token, refreshToken } = parseSessionTokenFromRedirectUrl(result.url);
  if (!token) {
    throw new Error("Orchestra sign-in redirect did not contain a session token");
  }

  // Reuse the existing storage + connect path verbatim; persist the refresh
  // token too when present (absent → legacy 1h session against an old auth).
  await storeSessionToken(token);
  if (refreshToken) {
    await storeRefreshToken(refreshToken);
  }
  // The native redirect delivers the tokens only; the accountId is derived from
  // the session bearer on subsequent calls. The welcome screen ignores this
  // value, so "unknown" matches the web popup's fallback shape.
  return { accountId: "unknown" };
}

// Platform dispatcher: web keeps the popup + postMessage handshake; native uses
// the deep-link auth session. Both resolve the same shape and both persist the
// session via storeSessionToken, so callers stay platform-agnostic.
export function loginWithOrchestra(): Promise<{ accountId: string }> {
  return isWeb ? loginWithOAuthPopup() : loginWithOAuthNative();
}

export function loginWithOAuthPopup(): Promise<{ accountId: string }> {
  if (!isWeb) {
    return Promise.reject(new Error("OAuth popup login is only supported on web at D-1"));
  }

  return new Promise((resolve, reject) => {
    const returnTo = window.location.origin + "/welcome";
    const authUrl = `${getAuthBaseUrl()}/oauth/github/start?return_to=${encodeURIComponent(returnTo)}`;

    const popup = window.open(authUrl, "orchestra-oauth", "width=600,height=700");
    if (!popup) {
      reject(new Error("Failed to open OAuth popup — check your popup blocker"));
      return;
    }

    function onMessage(event: MessageEvent) {
      if (!event.data || typeof event.data !== "object") return;
      if (event.data.type !== "orchestra:session") return;

      window.removeEventListener("message", onMessage);
      clearInterval(pollTimer);

      const { token, refreshToken, accountId } = event.data as {
        type: string;
        token: string;
        refreshToken?: string;
        accountId?: string;
      };

      void (async () => {
        await storeSessionToken(token);
        if (typeof refreshToken === "string" && refreshToken.length > 0) {
          await storeRefreshToken(refreshToken);
        }
      })().then(() => {
        resolve({ accountId: accountId ?? "unknown" });
        return undefined;
      });
    }

    const pollTimer = setInterval(() => {
      if (popup.closed) {
        clearInterval(pollTimer);
        window.removeEventListener("message", onMessage);
        reject(new Error("OAuth popup was closed before completing sign-in"));
      }
    }, 500);

    window.addEventListener("message", onMessage);
  });
}

export async function listWorkspaces(): Promise<WorkspaceRecord[]> {
  const res = await authedFetch("/api/v1/cloud/workspaces");
  if (!res.ok) {
    throw new Error(`Failed to list workspaces: ${res.status}`);
  }
  const body = (await res.json()) as { workspaces: unknown[] };
  return (body.workspaces ?? []).map(normalizeWorkspaceRecord);
}

export async function createWorkspace(input: {
  repoUrl: string | null;
  displayName?: string;
}): Promise<WorkspaceRecord> {
  const res = await authedFetch("/api/v1/cloud/workspaces", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "unknown error");
    throw new Error(`Failed to create workspace: ${res.status} — ${body}`);
  }
  return normalizeWorkspaceRecord(await res.json());
}

// Single-discriminator helper (F11 design-out): route every consumer through
// here so a future "billing_locked" / new-state addition doesn't need a grep
// across the codebase. Use this instead of comparing workspace.state inline.
export function getCloudWorkspaceState(workspace: WorkspaceRecord): CloudWorkspaceState {
  return workspace.state;
}

// NOTE: distinct from the on-host WS RPC client.archiveWorkspace (worktree
// "hide from sidebar"). This is the cloud-tenancy archive: flips DDB
// state="archived", schedules the EventBridge T-24h/T-0 GC, and StopTasks
// the per-workspace daemon container asynchronously via the lifecycle
// worker. See workspace-lifecycle.md § "States".
export async function archiveCloudWorkspace(workspaceId: string): Promise<WorkspaceRecord> {
  const res = await authedFetch(`/api/v1/cloud/workspaces/${workspaceId}/archive`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "unknown error");
    throw new Error(`Failed to archive workspace: ${res.status} — ${body}`);
  }
  return normalizeWorkspaceRecord(await res.json());
}

export async function unarchiveCloudWorkspace(workspaceId: string): Promise<WorkspaceRecord> {
  const res = await authedFetch(`/api/v1/cloud/workspaces/${workspaceId}/unarchive`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "unknown error");
    throw new Error(`Failed to unarchive workspace: ${res.status} — ${body}`);
  }
  return normalizeWorkspaceRecord(await res.json());
}

// COMPAT(per-user-credential): per-workspace credential write. The credential
// is now per-account (D-3.5b, Decision #2) — set once via the account endpoints
// below and inherited by every workspace. This per-workspace writer is retained
// only for the migration window; remove after migration completes (target
// 2026-12).
export async function setAnthropicCredential(
  workspaceId: string,
  apiKey: string,
): Promise<{ status: "ok" }> {
  const res = await authedFetch(`/api/v1/cloud/workspaces/${workspaceId}/anthropic-credential`, {
    method: "POST",
    body: JSON.stringify({ apiKey }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "unknown error");
    throw new Error(`Failed to set Anthropic credential: ${res.status} — ${body}`);
  }
  return (await res.json()) as { status: "ok" };
}

// ---------------------------------------------------------------------------
// Account-scoped Anthropic credential (D-3.5b — per-user credential)
//
// The credential is per-ACCOUNT, set once and inherited by all the account's
// workspaces. Identity is derived from the session bearer only — there is NO
// accountId in any URL or body, so the app cannot address another user's
// account (cross-user isolation is enforced at the API + IAM, not the client).
// The status endpoint returns only {set, updatedAt} metadata — the credential
// value is never read back (write-only UI; no value-returning endpoint exists).
// ---------------------------------------------------------------------------

const ACCOUNT_ANTHROPIC_CREDENTIAL_PATH = "/api/v1/cloud/account/anthropic-credential";

export interface AccountCredentialStatus {
  set: boolean;
  updatedAt?: string;
}

export async function getAccountCredentialStatus(): Promise<AccountCredentialStatus> {
  const res = await authedFetch(ACCOUNT_ANTHROPIC_CREDENTIAL_PATH);
  if (!res.ok) {
    const body = await res.text().catch(() => "unknown error");
    throw new Error(`Failed to read Anthropic credential status: ${res.status} — ${body}`);
  }
  const body = (await res.json().catch(() => ({}))) as { set?: unknown; updatedAt?: unknown };
  const status: AccountCredentialStatus = { set: body.set === true };
  if (typeof body.updatedAt === "string") {
    status.updatedAt = body.updatedAt;
  }
  return status;
}

export async function setAccountAnthropicCredential(apiKey: string): Promise<{ status: "ok" }> {
  const res = await authedFetch(ACCOUNT_ANTHROPIC_CREDENTIAL_PATH, {
    method: "POST",
    body: JSON.stringify({ apiKey }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "unknown error");
    throw new Error(`Failed to set Anthropic credential: ${res.status} — ${body}`);
  }
  return (await res.json()) as { status: "ok" };
}

export async function removeAccountAnthropicCredential(): Promise<{ status: "ok" }> {
  const res = await authedFetch(ACCOUNT_ANTHROPIC_CREDENTIAL_PATH, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "unknown error");
    throw new Error(`Failed to remove Anthropic credential: ${res.status} — ${body}`);
  }
  return (await res.json()) as { status: "ok" };
}

// Discriminated result of POST /api/v1/cloud/workspaces/:id/token. Mirrors the
// status-code matrix PLAN-auth-and-shared Task 16 defined: a single endpoint
// returning one of six shapes depending on the workspace's lifecycle state.
// Treating any 2xx as `{token, expiresAt}` (the pre-D-2 behavior) silently
// breaks on the 202 "resuming" shape, so every caller must dispatch on
// `.status`.
export type MintWorkspaceTokenResult =
  | { status: "active"; token: string; expiresAt: number }
  | { status: "resuming"; retryAfterMs: number }
  | { status: "archived"; canUnarchive: boolean }
  | { status: "billing_locked"; reactivateUrl: string | null }
  | { status: "provisioning"; retryAfterMs: number }
  | { status: "provisioning_failed"; retryable: boolean };

async function readJsonOrEmpty(res: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export async function mintWorkspaceToken(workspaceId: string): Promise<MintWorkspaceTokenResult> {
  const res = await authedFetch(`/api/v1/cloud/workspaces/${workspaceId}/token`, {
    method: "POST",
  });

  if (res.status === 200) {
    const body = await readJsonOrEmpty(res);
    const token = typeof body.token === "string" ? body.token : "";
    const expiresAt = asNumber(body.expiresAt, 0);
    if (!token) {
      throw new Error("Failed to mint workspace token: 200 response missing token");
    }
    return { status: "active", token, expiresAt };
  }

  if (res.status === 202) {
    const body = await readJsonOrEmpty(res);
    return { status: "resuming", retryAfterMs: asNumber(body.retryAfterMs, 1500) };
  }

  if (res.status === 402) {
    const body = await readJsonOrEmpty(res);
    return { status: "billing_locked", reactivateUrl: asStringOrNull(body.reactivateUrl) };
  }

  if (res.status === 503) {
    const body = await readJsonOrEmpty(res);
    return { status: "provisioning", retryAfterMs: asNumber(body.retryAfterMs, 2000) };
  }

  if (res.status === 409) {
    // Two shapes share 409: archived (carries `canUnarchive`) vs
    // provisioning_failed (carries `retryable`). Disambiguate by which key is
    // present in the body. If neither is present (e.g. a future variant) fall
    // through to the generic throw so it can't masquerade as either.
    const body = await readJsonOrEmpty(res);
    if ("canUnarchive" in body) {
      return { status: "archived", canUnarchive: asBoolean(body.canUnarchive, true) };
    }
    if ("retryable" in body) {
      return { status: "provisioning_failed", retryable: asBoolean(body.retryable, false) };
    }
  }

  // Preserve the pre-D-2 throw shape for everything else (genuinely
  // unexpected status codes) so the caller's catch logs include the code.
  const body = await res.text().catch(() => "unknown error");
  throw new Error(`Failed to mint workspace token: ${res.status} — ${body}`);
}

// D-3.5a (app T-3) — the signed-in user's GitHub repositories, served by the
// cloud auth service's repo-list proxy (cloud-proprietary; the GitHub token is
// injected server-side). `cloneUrl` is credential-free — the token is added at
// clone time by the daemon, never exposed to the client. The picker feeds
// `cloneUrl` straight into `addProject({source:{kind:"github_repo", repoUrl}})`.
export interface GithubRepoSummary {
  fullName: string;
  cloneUrl: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string;
}

export interface ListGithubReposResult {
  repos: GithubRepoSummary[];
  // The page token to pass back for the next page, or null when exhausted.
  nextPage: number | null;
}

export interface ListGithubReposInput {
  page?: number;
  perPage?: number;
  search?: string;
}

function normalizeGithubRepoSummary(raw: unknown): GithubRepoSummary | null {
  const record = (raw ?? {}) as Record<string, unknown>;
  const fullName = typeof record.fullName === "string" ? record.fullName : null;
  const cloneUrl = typeof record.cloneUrl === "string" ? record.cloneUrl : null;
  if (!fullName || !cloneUrl) {
    return null;
  }
  return {
    fullName,
    cloneUrl,
    private: record.private === true,
    defaultBranch: typeof record.defaultBranch === "string" ? record.defaultBranch : "main",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
  };
}

export async function listGithubRepos(
  input: ListGithubReposInput = {},
): Promise<ListGithubReposResult> {
  const params = new URLSearchParams();
  if (typeof input.page === "number") {
    params.set("page", String(input.page));
  }
  if (typeof input.perPage === "number") {
    params.set("perPage", String(input.perPage));
  }
  const search = input.search?.trim();
  if (search) {
    params.set("search", search);
  }
  const queryString = params.toString();
  const res = await authedFetch(
    `/api/v1/cloud/github/repos${queryString ? `?${queryString}` : ""}`,
  );
  if (!res.ok) {
    throw new Error(`Failed to list GitHub repos: ${res.status}`);
  }
  const body = (await res.json()) as { repos?: unknown[]; nextPage?: unknown };
  const repos = (body.repos ?? [])
    .map(normalizeGithubRepoSummary)
    .filter((repo): repo is GithubRepoSummary => repo !== null);
  const nextPage = typeof body.nextPage === "number" ? body.nextPage : null;
  return { repos, nextPage };
}

// D-3.4: Derive the per-workspace daemon WebSocket URL from the workspaceId.
// Replaces the single-workspace `EXPO_PUBLIC_ORCHESTRA_DAEMON_WS_URL` fallback —
// every workspace's WS URL is now derived at probe time, so a single app build
// can reach any workspace the user owns. See utils/orchestra-daemon-url.ts for
// the env-var contract (hostname suffix + dev override).
export function getOrchestraDaemonWsUrl(workspaceId: string): string {
  return deriveDaemonWsUrlForWorkspace(workspaceId);
}

export function getOrchestraAuthUrl(): string {
  return getAuthBaseUrl();
}

// Out-of-band provider snapshot fetch (PLAN-app Task 4). Closes prior-attempt
// F1: the model picker is queryable BEFORE any daemon container exists, so
// the cloud client can render the provider list at app startup. The auth
// service serves the manifest from a static @orchestra/cloud-shared TS
// constant (CROSS-STREAM-SYNTHESIS § 1 C2, commit 9dc8972). No auth header
// — the catalog is account-agnostic and cache-friendly (ETag-driven 304).
//
// Anti-drift CI (PLAN-auth-and-shared Task 17) keeps the cloud-shared copy
// aligned with the AGPL daemon's models.ts source-of-truth.

export interface CloudProviderModelSnapshot {
  id: string;
  displayName: string;
  description: string;
  contextWindow: number;
  deprecated: boolean;
  isDefault?: boolean;
}

export interface CloudProviderSnapshotEntry {
  id: string;
  displayName: string;
  models: CloudProviderModelSnapshot[];
}

export interface CloudProvidersSnapshotResponse {
  version: string;
  generatedAt: string;
  providers: CloudProviderSnapshotEntry[];
}

export async function getCloudProvidersSnapshot(): Promise<CloudProvidersSnapshotResponse> {
  // No-auth GET — the catalog is the same for every account. The auth
  // service decides whether to gate by IP / rate-limit; the app does not
  // attach the session token.
  const res = await fetch(`${getAuthBaseUrl()}/api/v1/cloud/providers/snapshot`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch provider snapshot: ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  return normalizeCloudProvidersSnapshot(body);
}

export function normalizeCloudProvidersSnapshot(body: unknown): CloudProvidersSnapshotResponse {
  const obj = (body ?? {}) as Record<string, unknown>;
  const version = typeof obj.version === "string" ? obj.version : "unknown";
  const generatedAt = typeof obj.generatedAt === "string" ? obj.generatedAt : "";
  const rawProviders = Array.isArray(obj.providers) ? obj.providers : [];
  const providers: CloudProviderSnapshotEntry[] = rawProviders
    .map((rawProvider): CloudProviderSnapshotEntry | null => {
      const p = (rawProvider ?? {}) as Record<string, unknown>;
      const id = typeof p.id === "string" ? p.id : null;
      const displayName = typeof p.displayName === "string" ? p.displayName : (id ?? "Unknown");
      if (!id) return null;
      const rawModels = Array.isArray(p.models) ? p.models : [];
      const models: CloudProviderModelSnapshot[] = rawModels
        .map((rawModel): CloudProviderModelSnapshot | null => {
          const m = (rawModel ?? {}) as Record<string, unknown>;
          const modelId = typeof m.id === "string" ? m.id : null;
          if (!modelId) return null;
          const out: CloudProviderModelSnapshot = {
            id: modelId,
            displayName: typeof m.displayName === "string" ? m.displayName : modelId,
            description: typeof m.description === "string" ? m.description : "",
            contextWindow:
              typeof m.contextWindow === "number" && Number.isFinite(m.contextWindow)
                ? m.contextWindow
                : 0,
            deprecated: m.deprecated === true,
          };
          if (m.isDefault === true) out.isDefault = true;
          return out;
        })
        .filter((m): m is CloudProviderModelSnapshot => m !== null);
      return { id, displayName, models };
    })
    .filter((p): p is CloudProviderSnapshotEntry => p !== null);
  return { version, generatedAt, providers };
}
