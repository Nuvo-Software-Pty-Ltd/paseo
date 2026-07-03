// Native: the refresh token is long-lived (30 days) and rotation-bound, so it
// goes in the iOS Keychain / Android Keystore via expo-secure-store
// (hardware-backed, excluded from device backups by default) — a step up from
// AsyncStorage. SecureStore keys disallow ":", so the key uses a dot. Plain
// get/set needs no config plugin; the native module links via autolinking.
import * as SecureStore from "expo-secure-store";

const REFRESH_TOKEN_KEY = "orchestra.refresh_token";

export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

export async function storeRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token);
}

export async function clearRefreshToken(): Promise<void> {
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
}
