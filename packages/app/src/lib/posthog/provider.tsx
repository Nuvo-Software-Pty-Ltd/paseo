// Native AnalyticsProvider — wraps the app in posthog-react-native's provider
// using the shared client (see analytics.ts). No-ops to a passthrough when
// telemetry is disabled. Metro resolves this for iOS/Android; web uses
// provider.web.tsx.

import { PostHogProvider } from "posthog-react-native";
import type { ReactNode } from "react";
import { getClient } from "./analytics";

// Stable reference so PostHogProvider doesn't receive a new object each render.
const AUTOCAPTURE = { captureTouches: true, captureScreens: true };

export function AnalyticsProvider({ children }: { children: ReactNode }) {
  const client = getClient();
  if (!client) return children;
  return (
    <PostHogProvider client={client} autocapture={AUTOCAPTURE}>
      {children}
    </PostHogProvider>
  );
}
