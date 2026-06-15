// PostHog configuration — shared across web and native.
//
// EXPO_PUBLIC_* vars are inlined by `expo export` at build time (Expo's Babel
// plugin statically replaces each `process.env.EXPO_PUBLIC_*` member access), so
// each one is read through a direct member access here. See
// constants/feature-flags.ts for the same pattern.
//
// Self-host posture: when EXPO_PUBLIC_POSTHOG_KEY is absent the whole
// integration no-ops (see provider.* and analytics.*). The open-source
// self-host build ships without the key and therefore never phones home; only
// the Orchestra cloud builds inject it (eas.json for iOS, deploy-web.yml for
// web).

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** Public PostHog project key, or undefined when telemetry is disabled. */
export function getPosthogKey(): string | undefined {
  const key = process.env.EXPO_PUBLIC_POSTHOG_KEY?.trim();
  return key ? key : undefined;
}

/** PostHog ingestion host (US cloud by default). */
export function getPosthogHost(): string {
  return process.env.EXPO_PUBLIC_POSTHOG_HOST?.trim() || DEFAULT_POSTHOG_HOST;
}

/** True when a key is present and telemetry should initialize. */
export function isPosthogEnabled(): boolean {
  return Boolean(getPosthogKey());
}

/**
 * Coarse deploy environment, derived from the daemon hostname suffix the build
 * already carries (see constants/feature-flags.ts and .env.example). Lets a
 * single PostHog project distinguish dev / staging / prod events.
 */
export function getEnvironment(): "dev" | "staging" | "prod" {
  const suffix =
    process.env.EXPO_PUBLIC_ORCHESTRA_DAEMON_HOSTNAME_SUFFIX?.trim() ||
    "dev.orchestra.nuvo.software";
  if (suffix.startsWith("dev.")) return "dev";
  if (suffix.startsWith("staging.")) return "staging";
  return "prod";
}

/**
 * CSS selector posthog-js uses to mask text in session replay. Panes that render
 * code / terminal / agent output are tagged with `data-ph-mask` via
 * maskPaneProps() so their text is redacted in recordings. See mask.ts.
 */
export const WEB_MASK_SELECTOR = "[data-ph-mask]";

/** Imperative analytics surface implemented per-platform in analytics.*.ts. */
export interface Analytics {
  identify(distinctId: string, properties?: Record<string, unknown>): void;
  capture(event: string, properties?: Record<string, unknown>): void;
  captureException(error: unknown, properties?: Record<string, unknown>): void;
  register(properties: Record<string, unknown>): void;
  reset(): void;
}
