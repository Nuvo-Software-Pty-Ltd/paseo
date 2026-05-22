const DEFAULT_DEBOUNCE_MS = 100;

export interface SessionExpiredBounceDeps {
  clearSession: () => Promise<void>;
  replace: (route: string) => void;
  debounceMs?: number;
  warn?: (message: string, ...args: unknown[]) => void;
}

export interface SessionExpiredBounce {
  trigger: () => void;
}

// Pure coordinator: collapse N concurrent session-expired signals into a single
// clearSession + router.replace pair. Re-arms after the debounce window so a
// subsequent (post-sign-in) expiry can still bounce.
export function createSessionExpiredBounce(deps: SessionExpiredBounceDeps): SessionExpiredBounce {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const warn = deps.warn ?? console.warn;
  let bouncing = false;
  return {
    trigger: () => {
      if (bouncing) {
        return;
      }
      bouncing = true;
      warn("[Orchestra] Session expired — bouncing to /welcome");
      void deps
        .clearSession()
        .catch((error) => {
          warn("[Orchestra] Failed to clear session token during bounce", error);
        })
        .finally(() => {
          deps.replace("/welcome?reason=session-expired");
          setTimeout(() => {
            bouncing = false;
          }, debounceMs);
        });
    },
  };
}
