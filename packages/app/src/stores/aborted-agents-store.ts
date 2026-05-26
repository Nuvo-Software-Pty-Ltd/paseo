import { create } from "zustand";

// Client-only registry of agent IDs the user just "Stop the agent"-ed via the
// permission card (T3 hard-abort branch). The daemon's terminal state for
// these agents is status:"error" + attentionReason:"error", which is
// indistinguishable from a real provider error from the wire alone.
// Recording the user-initiated stop here lets the abort banner know to
// render "You stopped this agent." copy instead of leaving the generic error
// attention banner. Round-19 binding:
// paseo-cloud-daemon/examples/websocket/
//   round-19-permission-deny-interrupt-true.jsonl.

interface AbortedAgentsState {
  // agentId → timestamp when the user pressed "Stop the agent".
  abortedAgentIds: ReadonlyMap<string, number>;
  markAborted: (agentId: string) => void;
  clearAborted: (agentId: string) => void;
  clearAll: () => void;
}

export const useAbortedAgentsStore = create<AbortedAgentsState>((set) => ({
  abortedAgentIds: new Map<string, number>(),
  markAborted: (agentId) =>
    set((state) => {
      const next = new Map(state.abortedAgentIds);
      next.set(agentId, Date.now());
      return { abortedAgentIds: next };
    }),
  clearAborted: (agentId) =>
    set((state) => {
      if (!state.abortedAgentIds.has(agentId)) return state;
      const next = new Map(state.abortedAgentIds);
      next.delete(agentId);
      return { abortedAgentIds: next };
    }),
  clearAll: () => set({ abortedAgentIds: new Map<string, number>() }),
}));

// Pure derivation: should the user-stopped abort banner show for this agent?
// Inputs: the agent's terminal status + attentionReason, plus whether the
// agent appears in the user-aborted registry.
export interface AbortBannerInput {
  agentStatus: string | null | undefined;
  attentionReason: string | null | undefined;
  isUserAborted: boolean;
}

export function shouldShowAbortBanner(input: AbortBannerInput): boolean {
  if (!input.isUserAborted) return false;
  if (input.agentStatus !== "error") return false;
  // attentionReason:"error" is what the daemon stamps on a turn_failed
  // terminal state. We could also accept null (user already dismissed
  // attention) but that path falls back to the generic UI — no banner.
  return input.attentionReason === "error";
}
