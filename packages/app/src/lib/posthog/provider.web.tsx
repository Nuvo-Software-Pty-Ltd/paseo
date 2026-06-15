// Web AnalyticsProvider — initializes posthog-js and exposes the client via
// posthog-js/react context (usePostHog()). No-ops to a passthrough when
// telemetry is disabled. Metro resolves this for web; native uses provider.tsx.

import { PostHogProvider } from "posthog-js/react";
import { posthog } from "posthog-js";
import { useMemo, type ReactNode } from "react";
import { initAnalytics } from "./analytics";

export function AnalyticsProvider({ children }: { children: ReactNode }) {
  const enabled = useMemo(() => initAnalytics(), []);
  if (!enabled) return children;
  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}
