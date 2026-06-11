// Pure welcome-screen action logic, separated from the component so it can be
// unit-tested without pulling in React Native / Expo modules (mirrors
// welcome-redirect.ts).

export type WelcomeActionKey =
  | "scan-qr"
  | "direct-connection"
  | "paste-pairing-link"
  | "orchestra-cloud";

// Self-host connection methods — hidden when self-host connections are disabled
// (the Orchestra cloud web build), leaving only "Connect to Orchestra".
const SELF_HOST_ACTION_KEYS = new Set<WelcomeActionKey>([
  "scan-qr",
  "direct-connection",
  "paste-pairing-link",
]);

export function isSelfHostWelcomeAction(key: WelcomeActionKey): boolean {
  return SELF_HOST_ACTION_KEYS.has(key);
}

// Drops self-host actions when self-host connections are disabled; otherwise
// returns the list unchanged. Generic over the action shape — only `key` is
// inspected.
export function filterWelcomeActions<T extends { key: WelcomeActionKey }>(
  actions: T[],
  selfHostEnabled: boolean,
): T[] {
  if (selfHostEnabled) return actions;
  return actions.filter((action) => !isSelfHostWelcomeAction(action.key));
}
