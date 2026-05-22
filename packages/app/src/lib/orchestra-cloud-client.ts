import AsyncStorage from "@react-native-async-storage/async-storage";
import { isWeb } from "@/constants/platform";

const SESSION_TOKEN_KEY = "orchestra:session_token";

const DEFAULT_AUTH_URL = "http://orchestra-dev-1104346820.ap-southeast-2.elb.amazonaws.com";

function getAuthBaseUrl(): string {
  return process.env.EXPO_PUBLIC_ORCHESTRA_AUTH_URL?.trim() || DEFAULT_AUTH_URL;
}

function getDaemonWsUrl(): string {
  const base = process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_WS_URL?.trim() || DEFAULT_AUTH_URL;
  const wsScheme = base.startsWith("https") ? "wss" : "ws";
  const httpStripped = base.replace(/^https?:\/\//, "");
  return `${wsScheme}://${httpStripped}/ws`;
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
  const rawState = record.state;
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

async function requireSessionToken(): Promise<string> {
  const token = await getSessionToken();
  if (!token) {
    signalSessionExpired();
    throw new OrchestraSessionExpiredError();
  }
  return token;
}

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await requireSessionToken();
  const url = `${getAuthBaseUrl()}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (res.status === 401) {
    signalSessionExpired();
    throw new OrchestraSessionExpiredError();
  }
  return res;
}

export async function storeSessionToken(token: string): Promise<void> {
  await AsyncStorage.setItem(SESSION_TOKEN_KEY, token);
}

export async function clearSession(): Promise<void> {
  await AsyncStorage.removeItem(SESSION_TOKEN_KEY);
}

export async function hasSession(): Promise<boolean> {
  const token = await getSessionToken();
  return token !== null;
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

      const { token, accountId } = event.data as {
        type: string;
        token: string;
        accountId?: string;
      };

      void storeSessionToken(token).then(() => {
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

// NOTE: GET /api/v1/cloud/github/repos does not exist yet in Phase 3.
// For D-1, users paste a repo URL by hand. This is a small follow-up for a
// future phase that adds a GitHub repo proxy route to the auth service.
export async function listGithubRepos(): Promise<
  Array<{ full_name: string; private: boolean; updated_at: string }>
> {
  const res = await authedFetch("/api/v1/cloud/github/repos");
  if (!res.ok) {
    throw new Error(`Failed to list GitHub repos: ${res.status}`);
  }
  return (await res.json()) as Array<{ full_name: string; private: boolean; updated_at: string }>;
}

export function getOrchestraDaemonWsUrl(): string {
  return getDaemonWsUrl();
}

export function getOrchestraAuthUrl(): string {
  return getAuthBaseUrl();
}
