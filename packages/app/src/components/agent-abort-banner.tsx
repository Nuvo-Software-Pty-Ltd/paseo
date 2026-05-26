import { useCallback } from "react";
import { View, Text, Pressable } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { shouldShowAbortBanner, useAbortedAgentsStore } from "@/stores/aborted-agents-store";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

// Locked banner copy. T3 acceptance: "Stop the agent" lands the daemon's
// terminal state at status:"error", attentionReason:"error"; the banner ties
// to that state and offers a Dismiss affordance that clears the agent's
// attention via the existing daemon.clearAgentAttention(...) RPC.
export const ABORT_BANNER_COPY = "You stopped this agent. Send a message to continue.";

interface AgentAbortBannerProps {
  serverId: string;
  agentId: string;
  agentStatus: string | null | undefined;
  attentionReason: string | null | undefined;
}

export function AgentAbortBanner({
  serverId,
  agentId,
  agentStatus,
  attentionReason,
}: AgentAbortBannerProps) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isUserAborted = useAbortedAgentsStore((state) => state.abortedAgentIds.has(agentId));
  const clearAborted = useAbortedAgentsStore((state) => state.clearAborted);

  const handleDismiss = useCallback(() => {
    clearAborted(agentId);
    if (client && isConnected) {
      client.clearAgentAttention(agentId).catch(() => {
        // attention-clear is best-effort; the user-stop registry is the
        // load-bearing state. A failed clear leaves the daemon's attention
        // flag set but the banner already dismissed from the user's view.
      });
    }
  }, [agentId, client, clearAborted, isConnected]);

  if (!shouldShowAbortBanner({ agentStatus, attentionReason, isUserAborted })) {
    return null;
  }

  return (
    <View style={styles.container} accessibilityLabel="agent-abort-banner">
      <Text style={styles.text}>{ABORT_BANNER_COPY}</Text>
      <Pressable
        onPress={handleDismiss}
        accessibilityRole="button"
        testID="agent-abort-banner-dismiss"
        style={styles.dismissButton}
      >
        <Text style={styles.dismissText}>Dismiss</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderLeftWidth: theme.borderWidth[2] ?? 2,
    borderLeftColor: theme.colors.destructive,
  },
  text: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  dismissButton: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
  },
  dismissText: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
  },
})) as unknown as Record<string, object>;
