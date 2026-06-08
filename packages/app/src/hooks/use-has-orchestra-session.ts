import { useQuery } from "@tanstack/react-query";
import { hasSession } from "@/lib/orchestra-cloud-client";

export const ORCHESTRA_SESSION_QUERY_KEY = ["orchestra", "has-session"] as const;

// Whether an Orchestra cloud session token is present. Used to gate cloud-only
// UI (e.g. the per-account provider-credential settings page) — pure on-host
// self-host has no cloud account and uses the operator's own ~/.claude, so the
// page is meaningless there. Defaults to false until the AsyncStorage read
// resolves.
export function useHasOrchestraSession(): boolean {
  const { data } = useQuery({
    queryKey: ORCHESTRA_SESSION_QUERY_KEY,
    queryFn: () => hasSession(),
    staleTime: 30_000,
    retry: false,
  });
  return data ?? false;
}
