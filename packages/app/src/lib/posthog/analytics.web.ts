// Web analytics implementation backed by posthog-js (rrweb session replay +
// exception autocapture). Metro resolves this file for the web bundle; native
// uses analytics.ts. Nothing here is imported on native, so posthog-js never
// reaches the React Native bundle.

import { posthog } from "posthog-js";
import {
  type Analytics,
  getEnvironment,
  getPosthogHost,
  getPosthogKey,
  WEB_MASK_SELECTOR,
} from "./config";

let initialized = false;

/**
 * Initialize posthog-js once. Returns true when telemetry is active (a key was
 * present), false when it no-ops (self-host build without a key). Idempotent.
 */
export function initAnalytics(): boolean {
  if (initialized) return true;
  const key = getPosthogKey();
  if (!key) return false;

  posthog.init(key, {
    api_host: getPosthogHost(),
    // Only create person profiles for identified (signed-in) users.
    person_profiles: "identified_only",
    autocapture: true,
    capture_pageview: true,
    capture_pageleave: true,
    // Error Tracking: autocapture unhandled errors + promise rejections.
    capture_exceptions: true,
    session_recording: {
      // Inputs are masked by default; additionally redact code/terminal/agent
      // panes tagged with data-ph-mask (see mask.ts). Layout is preserved.
      maskAllInputs: true,
      maskTextSelector: WEB_MASK_SELECTOR,
    },
  });
  posthog.register({ environment: getEnvironment() });
  initialized = true;
  return true;
}

export const analytics: Analytics = {
  identify(distinctId, properties) {
    if (initialized) posthog.identify(distinctId, properties);
  },
  capture(event, properties) {
    if (initialized) posthog.capture(event, properties);
  },
  captureException(error, properties) {
    if (initialized) posthog.captureException(error, properties);
  },
  register(properties) {
    if (initialized) posthog.register(properties);
  },
  reset() {
    if (initialized) posthog.reset();
  },
};
