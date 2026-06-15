// Native analytics implementation backed by posthog-react-native (native session
// replay via @posthog/react-native-plugin + native error tracking). Metro
// resolves this file for iOS/Android; web uses analytics.web.ts. posthog-react-
// native never reaches the web bundle.
//
// Note: this file mirrors analytics.web.ts's export surface (analytics +
// initAnalytics) so TypeScript — which resolves bare `./analytics` to this .ts
// file for both provider variants — typechecks provider.web.tsx too.

import PostHog from "posthog-react-native";
import { type Analytics, getEnvironment, getPosthogHost, getPosthogKey } from "./config";

let client: PostHog | null = null;
let resolved = false;

/**
 * Lazily construct the PostHog client once. Returns null when telemetry is
 * disabled (self-host build without a key) — the provider then renders children
 * unchanged. The instance is shared by the provider (for hooks / replay) and the
 * imperative `analytics` surface below (used from the error boundary).
 */
export function getClient(): PostHog | null {
  if (resolved) return client;
  resolved = true;
  const key = getPosthogKey();
  if (!key) return null;

  client = new PostHog(key, {
    host: getPosthogHost(),
    enableSessionReplay: true,
    sessionReplayConfig: {
      // Native baseline: redact all text inputs and images. Per-view masking of
      // code/terminal panes is a follow-up verified during the native build pass.
      maskAllTextInputs: true,
      maskAllImages: true,
    },
    // Error Tracking. The web side autocaptures via posthog-js `capture_exceptions`; on native we
    // enable the SDK's own autocapture: `uncaughtExceptions` hooks ErrorUtils.setGlobalHandler,
    // `unhandledRejections` covers rejected promises, and `nativeCrashes` reports native iOS/Android
    // crashes via @posthog/react-native-plugin. RootErrorBoundary still handles render errors — a
    // boundary-caught error never reaches the global handler, so there's no double-capture. `console`
    // capture is intentionally omitted to avoid flooding Error Tracking with warnings.
    errorTracking: {
      autocapture: {
        uncaughtExceptions: true,
        unhandledRejections: true,
        nativeCrashes: true,
      },
    },
  });
  client.register({ environment: getEnvironment() });
  return client;
}

/** Initialize the native client; returns true when telemetry is active. */
export function initAnalytics(): boolean {
  return getClient() !== null;
}

export const analytics: Analytics = {
  identify(distinctId, properties) {
    getClient()?.identify(distinctId, properties as Parameters<PostHog["identify"]>[1]);
  },
  capture(event, properties) {
    getClient()?.capture(event, properties as Parameters<PostHog["capture"]>[1]);
  },
  captureException(error, properties) {
    getClient()?.captureException(error, properties as Parameters<PostHog["captureException"]>[1]);
  },
  register(properties) {
    getClient()?.register(properties as Parameters<PostHog["register"]>[0]);
  },
  reset() {
    getClient()?.reset();
  },
};
