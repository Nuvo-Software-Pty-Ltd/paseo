// Web: no Keychain, so the refresh token lives in AsyncStorage (localStorage on
// web) exactly like the access token. Metro/vitest resolve this variant for the
// web bundle; expo-secure-store is never imported here.
import AsyncStorage from "@react-native-async-storage/async-storage";

const REFRESH_TOKEN_KEY = "orchestra:refresh_token";

export async function getRefreshToken(): Promise<string | null> {
  return AsyncStorage.getItem(REFRESH_TOKEN_KEY);
}

export async function storeRefreshToken(token: string): Promise<void> {
  await AsyncStorage.setItem(REFRESH_TOKEN_KEY, token);
}

export async function clearRefreshToken(): Promise<void> {
  await AsyncStorage.removeItem(REFRESH_TOKEN_KEY);
}
