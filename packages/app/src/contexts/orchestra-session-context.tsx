import { useEffect, type ReactNode } from "react";
import { useRouter, type Href } from "expo-router";
import { clearSession, onOrchestraSessionExpired } from "@/lib/orchestra-cloud-client";
import { useProactiveSessionRefresh } from "@/hooks/use-proactive-session-refresh";
import { createSessionExpiredBounce } from "./orchestra-session-bounce";

export function OrchestraSessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();

  // Fix B: keep the access token fresh on launch + foreground so the workspace
  // WS connect path never has to refresh mid-connect (the first-launch
  // "stuck connecting" bug). Mounts here, before the host-runtime boot effect.
  useProactiveSessionRefresh();

  useEffect(() => {
    const bounce = createSessionExpiredBounce({
      clearSession,
      replace: (route) => router.replace(route as Href),
    });
    const unsubscribe = onOrchestraSessionExpired(() => {
      bounce.trigger();
    });
    return () => {
      unsubscribe();
    };
  }, [router]);

  return children;
}
