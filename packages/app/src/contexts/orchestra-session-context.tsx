import { useEffect, type ReactNode } from "react";
import { useRouter } from "expo-router";
import { clearSession, onOrchestraSessionExpired } from "@/lib/orchestra-cloud-client";
import { createSessionExpiredBounce } from "./orchestra-session-bounce";

export function OrchestraSessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();

  useEffect(() => {
    const bounce = createSessionExpiredBounce({
      clearSession,
      replace: (route) => router.replace(route),
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
