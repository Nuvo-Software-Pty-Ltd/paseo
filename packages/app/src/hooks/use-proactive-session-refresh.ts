import { useEffect, useRef } from "react";
import { proactivelyRefreshSession } from "@/lib/orchestra-cloud-client";
import { useAppVisible } from "@/hooks/use-app-visible";

// Fix B: keep the Orchestra access token fresh OUTSIDE the WS connect path.
// Refresh once on launch (mount) and again whenever the app returns to the
// foreground — the two moments at which a stale, near-expired access token would
// otherwise force a slow refresh *inside* the tight workspace-connect deadline
// (the first-launch "stuck connecting" bug). proactivelyRefreshSession is
// best-effort + single-flighted, so calling it eagerly is cheap and safe.
export function useProactiveSessionRefresh(): void {
  const visible = useAppVisible();
  const wasVisible = useRef(visible);

  // Launch: cold start with an expired access token should refresh before the
  // host runtime attempts its first cloud connect.
  useEffect(() => {
    void proactivelyRefreshSession();
  }, []);

  // Foreground: fire only on a background→foreground transition (the "reopened
  // after idle" case), not on every render or when going to the background.
  useEffect(() => {
    if (visible && !wasVisible.current) {
      void proactivelyRefreshSession();
    }
    wasVisible.current = visible;
  }, [visible]);
}
