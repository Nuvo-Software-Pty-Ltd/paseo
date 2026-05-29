// D-3.4: Per-workspace Orchestra daemon WebSocket URL derivation.
//
// Each workspace gets its own ALB-routed daemon hostname in the cloud stack:
//   wss://<wsId-hyphenized>.<hostname-suffix>/ws
//
// The hostname-suffix is configurable via env so the same app build can be
// pointed at dev / staging / prod. The `_` → `-` substitution mirrors the
// backend's ALB-rule hostname (see lifecycle-worker/lib/alb-routing.ts);
// daemon workspaceIds are `ws_xxxxxxxx` shaped, but ALB host headers cannot
// contain underscores, so the backend hyphenizes when creating the listener
// rule. The frontend must mirror that substitution or the WebSocket upgrade
// will land on the wrong ALB target group (or no rule at all).
//
// Env contract:
//   EXPO_PUBLIC_ORCHESTRA_DAEMON_HOSTNAME_SUFFIX — base hostname suffix for
//     per-workspace daemons. Default is `.dev.orchestra.nuvo.software`. Set
//     to `.orchestra.nuvo.software` (prod) or `.staging.orchestra.nuvo.software`
//     (staging) at build time via Expo's `EXPO_PUBLIC_*` mechanism. The
//     leading "." is optional — both `.dev.orchestra.nuvo.software` and
//     `dev.orchestra.nuvo.software` are accepted; we normalize.
//
//   EXPO_PUBLIC_ORCHESTRA_DAEMON_WS_URL — DEV-ONLY override that bypasses
//     workspace-based derivation and uses a single fixed URL. Useful for
//     pointing the app at a local daemon (`ws://localhost:6767/ws`) or at
//     a single test workspace during one-off debugging. NOT suitable as a
//     production fallback — only one workspace is reachable while this is
//     set. Pre-D-3.4 this was the sole URL source; now it is the escape
//     hatch.

const DEFAULT_DAEMON_HOSTNAME_SUFFIX = "dev.orchestra.nuvo.software";

/**
 * Convert a workspaceId into the ALB-routable hostname segment. Mirrors the
 * backend's `workspaceId.replace(/_/g, "-")` rule because ALB host headers
 * cannot contain underscores. See D-3.3 / PR #44 in paseo-cloud-daemon
 * LEARNINGS.md.
 *
 * Exported for tests; the runtime path goes through
 * {@link deriveDaemonWsUrlForWorkspace}.
 */
export function hyphenizeWorkspaceIdForHostname(workspaceId: string): string {
  return workspaceId.replace(/_/g, "-");
}

function normalizeHostnameSuffix(rawSuffix: string): string {
  const trimmed = rawSuffix.trim();
  if (!trimmed) return DEFAULT_DAEMON_HOSTNAME_SUFFIX;
  // Strip any leading "." so we can join unambiguously below.
  return trimmed.replace(/^\.+/, "");
}

function getDevOverrideUrl(): string | null {
  const raw = process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_WS_URL?.trim();
  return raw && raw.length > 0 ? raw : null;
}

function getHostnameSuffix(): string {
  const raw = process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_HOSTNAME_SUFFIX ?? "";
  return normalizeHostnameSuffix(raw);
}

/**
 * Coerce a configured base URL (which may or may not include scheme / path)
 * into a `ws://…/ws` or `wss://…/ws` form. Mirrors the pre-D-3.4
 * coercion behavior of the dev override so existing dev configs that point at
 * a local HTTP URL keep working.
 */
function coerceToWebSocketUrl(input: string): string {
  // Already a ws/wss URL — pass through unchanged so callers can specify a
  // non-default path if they really want to (though everything else in the
  // stack assumes `/ws`).
  if (input.startsWith("ws://") || input.startsWith("wss://")) {
    return input;
  }
  const wsScheme = input.startsWith("https://") ? "wss" : "ws";
  const httpStripped = input.replace(/^https?:\/\//, "");
  // Drop trailing slashes before appending `/ws` so we don't end up with
  // `…//ws`.
  const noTrailing = httpStripped.replace(/\/+$/, "");
  return `${wsScheme}://${noTrailing}/ws`;
}

/**
 * Derive the WebSocket URL for a specific workspace's cloud daemon.
 *
 * Resolution order:
 *   1. `EXPO_PUBLIC_ORCHESTRA_DAEMON_WS_URL` (dev override, ignores workspaceId)
 *   2. Default: `wss://<hyphenized-wsId>.<hostname-suffix>/ws`
 *
 * @param workspaceId daemon-side workspace identifier (e.g. `ws_74d480de`).
 *   Must be a non-empty string unless the dev override is set.
 * @throws Error when no workspaceId is provided and no dev override is set.
 */
export function deriveDaemonWsUrlForWorkspace(workspaceId: string): string {
  const override = getDevOverrideUrl();
  if (override) {
    return coerceToWebSocketUrl(override);
  }

  const trimmedId = workspaceId.trim();
  if (!trimmedId) {
    throw new Error(
      "Cannot derive Orchestra daemon WS URL: workspaceId is required. " +
        "Set EXPO_PUBLIC_ORCHESTRA_DAEMON_WS_URL to override during local development.",
    );
  }

  const hostnameSegment = hyphenizeWorkspaceIdForHostname(trimmedId);
  const suffix = getHostnameSuffix();
  return `wss://${hostnameSegment}.${suffix}/ws`;
}
