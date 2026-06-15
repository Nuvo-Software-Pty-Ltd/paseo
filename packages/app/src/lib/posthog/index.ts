// Public surface of the PostHog integration. Provider / analytics resolve to the
// platform implementation (.web vs native) via Metro; everything else is shared.

export { analytics } from "./analytics";
export { AnalyticsProvider } from "./provider";
export { AnalyticsIdentitySync } from "./identity-sync";
export { RootErrorBoundary } from "./error-boundary";
export { maskPaneProps } from "./mask";
export { isPosthogEnabled } from "./config";
