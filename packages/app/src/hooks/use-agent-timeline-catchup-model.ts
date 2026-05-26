// Pure state machine for the "Resuming from <timestamp>" indicator
// (PLAN-app.md Task 7). The hook layer (use-agent-timeline-catchup.ts —
// follow-up commit) wires this into the WS reconnect glue; this file owns
// the state transitions so they can be tested deterministically.
//
// Wire shape pinned: paseo-cloud-daemon/10-interfaces/websocket/catalog/
// agent-stream.md § Resumption. On WS reconnect the client sends
// `fetch_agent_timeline_request{direction:"after", cursor:{epoch,seq},
// subscribe:{subscriptionId}}`. The reducer classifies returned items as
// kind:"catch_up" vs live kind:"realtime"; UI side-effects (toast, sound,
// badge bump, push) read this kind and suppress for catchup.
//
// Epoch-mismatch handling: agent-stream.md § Resumption flags the daemon's
// response shape as UNVERIFIED. Defensive: if the response's first event's
// epoch != cursor.epoch, surface a soft "Timeline restarted" notice (not
// an error) and rewind the reducer to a fresh epoch starting from
// response.events[0].

export interface AgentTimelineCatchupState {
  // Whether the "Resuming from <timestamp>" banner should render.
  isCatchingUp: boolean;
  // The last-known-event timestamp to display in the banner. ISO string
  // verbatim from the daemon (or null on cold reconnect with no cursor).
  lastKnownTimestamp: string | null;
  // Set after an epoch mismatch is detected. UI surfaces this as a soft
  // "Timeline restarted" notice rather than an error.
  epochRestarted: boolean;
  // Stamped when catchup starts; allows the banner to enforce a minimum
  // visibility duration (PLAN-app.md OQ 4: 1-second minimum to avoid
  // flicker if catchup completes instantly).
  startedAt: number | null;
}

export function initialCatchupState(): AgentTimelineCatchupState {
  return {
    isCatchingUp: false,
    lastKnownTimestamp: null,
    epochRestarted: false,
    startedAt: null,
  };
}

interface BeginCatchupInput {
  lastKnownTimestamp: string | null;
  // Pass Date.now() at the caller — tests inject a fixed clock.
  now: number;
}

export function beginCatchup(input: BeginCatchupInput): AgentTimelineCatchupState {
  return {
    isCatchingUp: true,
    lastKnownTimestamp: input.lastKnownTimestamp,
    epochRestarted: false,
    startedAt: input.now,
  };
}

interface CompleteCatchupInput {
  state: AgentTimelineCatchupState;
  now: number;
  // Minimum visible duration in ms (default 1000 per OQ 4). The banner
  // stays up until either (a) catchup finishes AND minDurationMs has
  // elapsed since start, OR (b) the caller forces it via completeCatchup.
  minDurationMs?: number;
}

// Returns the new state if the banner can hide now, or the SAME state if
// the minimum-visibility window has not elapsed. Caller schedules a
// follow-up tick when the returned state is still isCatchingUp:true.
export function completeCatchup(input: CompleteCatchupInput): AgentTimelineCatchupState {
  const { state, now } = input;
  if (!state.isCatchingUp) return state;
  const minDurationMs = input.minDurationMs ?? 1000;
  if (state.startedAt === null) {
    return { ...state, isCatchingUp: false };
  }
  const elapsed = now - state.startedAt;
  if (elapsed < minDurationMs) {
    // Caller will tick again after (minDurationMs - elapsed) ms.
    return state;
  }
  return { ...state, isCatchingUp: false };
}

// Mark an epoch mismatch. UI surfaces this in a separate soft notice;
// the reducer rewinds to the new epoch independently.
export function markEpochRestarted(state: AgentTimelineCatchupState): AgentTimelineCatchupState {
  return { ...state, epochRestarted: true };
}

export function dismissEpochRestarted(state: AgentTimelineCatchupState): AgentTimelineCatchupState {
  return { ...state, epochRestarted: false };
}

// ---------------------------------------------------------------------------
// Side-effect suppression
// ---------------------------------------------------------------------------

// Stream-item classification: items returned in a catchup response carry
// kind:"catch_up"; live push items carry kind:"realtime" (per
// session-stream-reducers.ts). UI side-effects bound to incoming items
// (toast, sound, badge bump, push notification) check this kind and skip
// for catchup so a 30-second disconnect doesn't fire 30 seconds' worth of
// notifications all at once.
export type StreamItemKind = "catch_up" | "realtime";

interface SideEffectSuppressionInput {
  itemKind: StreamItemKind;
  // The reducer flips this to true while it's processing a catchup batch.
  // True overrides the per-item kind for items that pass through the
  // catchup window even if their kind is unset (defense-in-depth).
  isCatchingUp: boolean;
}

// Returns true when UI side-effects (toast, sound, badge bump, push)
// should be SKIPPED for this item.
export function shouldSuppressSideEffects(input: SideEffectSuppressionInput): boolean {
  if (input.itemKind === "catch_up") return true;
  if (input.isCatchingUp) return true;
  return false;
}
