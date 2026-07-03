// Platform-split storage for the 30-day Orchestra refresh token. Metro (and
// vitest, via resolve.extensions) picks the `.web` implementation
// (AsyncStorage/localStorage) or the `.native` implementation (iOS Keychain /
// Android Keystore via expo-secure-store). This `.d.ts` is the shared contract
// importers type against. The access token stays in AsyncStorage on every
// platform (see orchestra-cloud-client.ts) — only the longer-lived refresh
// token gets Keychain storage where the platform offers it.
export declare function getRefreshToken(): Promise<string | null>;
export declare function storeRefreshToken(token: string): Promise<void>;
export declare function clearRefreshToken(): Promise<void>;
