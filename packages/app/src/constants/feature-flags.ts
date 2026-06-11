// Build-time feature flags.
//
// EXPO_PUBLIC_* vars are inlined by `expo export` at build time (Expo's Babel
// plugin statically replaces each `process.env.EXPO_PUBLIC_*` member access).
// Each flag is read through a function so the same member access is inlined in
// production AND can be toggled via process.env in unit tests.
//
// Defaults preserve the open-source self-host experience; the Orchestra cloud
// web build overrides them in orchestra-cloud-private's deploy-web workflow.

/**
 * Whether the welcome screen offers self-host connection methods (Direct
 * connection, Paste pairing link, Scan QR code).
 *
 * Default ON — a self-hosted or desktop build needs these to connect to a
 * daemon. The Orchestra cloud web build sets
 * `EXPO_PUBLIC_SELF_HOST_ENABLED="false"` so the welcome screen offers ONLY
 * "Connect to Orchestra".
 */
export function isSelfHostConnectionsEnabled(): boolean {
  return process.env.EXPO_PUBLIC_SELF_HOST_ENABLED !== "false";
}
