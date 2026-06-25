// Pure model for the in-timeline permission card's default action set and
// the action → response mapping. Round-19 binding
// (paseo-cloud-daemon/examples/websocket/
//  round-19-permission-deny-interrupt-{true,omitted}.jsonl):
//
//   interrupt:true   → hard abort. Agent's terminal state is status:"error",
//                       attentionReason:"error". Surface the abort banner.
//   interrupt omitted → graceful tool-error. Prompt closes; the deny
//                       `message` becomes the tool result; agent's next
//                       assistant_message acknowledges the deny and the turn
//                       ends with status:"idle", attentionReason:"finished".
//
// When `request.actions[]` is provider-supplied (Codex's "Always allow"
// etc.), we render those verbatim. The two-default fallback only applies
// when the daemon emits no actions of its own. See PLAN-app.md Task 3.

import type {
  AgentPermissionAction,
  AgentPermissionResponse,
} from "@getpaseo/protocol/agent-types";

// Canonical action IDs for the two default deny variants. Keep them stable
// so e2e selectors and analytics keys don't drift.
export const PERMISSION_DENY_BLOCK_ACTION_ID = "reject";
export const PERMISSION_DENY_STOP_ACTION_ID = "stop";
export const PERMISSION_ALLOW_ACTION_ID = "accept";
export const PERMISSION_ALLOW_PLAN_ACTION_ID = "implement";

export const PERMISSION_DENY_BLOCK_LABEL = "Block this call";
export const PERMISSION_DENY_STOP_LABEL = "Stop the agent";

// Default fallback message when the user does not type their own deny
// message. The plan calls out that the user-typed message reaches the wire
// as response.message in both branches; we still emit a default so the
// daemon's tool-result/assistant-message path has something to work with.
export const DEFAULT_DENY_MESSAGE = "Denied by user";

interface ResolveDefaultPermissionActionsInput {
  // True when the underlying permission request is a "plan" request, so the
  // primary "accept" action is labeled "Implement" instead of "Accept".
  isPlanRequest: boolean;
}

// The two-default-deny fallback used when the daemon does not supply
// `request.actions[]`. Order matters: the visually destructive
// "Stop the agent" action comes BEFORE the safer "Block this call" so a
// destructive press requires deliberate selection. Both share the same row
// position as a single "Deny" used to.
export function resolveDefaultPermissionActions(
  input: ResolveDefaultPermissionActionsInput,
): AgentPermissionAction[] {
  const acceptId = input.isPlanRequest
    ? PERMISSION_ALLOW_PLAN_ACTION_ID
    : PERMISSION_ALLOW_ACTION_ID;
  return [
    {
      id: PERMISSION_DENY_STOP_ACTION_ID,
      label: PERMISSION_DENY_STOP_LABEL,
      behavior: "deny",
      variant: "danger",
      intent: "dismiss",
    },
    {
      id: PERMISSION_DENY_BLOCK_ACTION_ID,
      label: PERMISSION_DENY_BLOCK_LABEL,
      behavior: "deny",
      variant: "secondary",
      intent: "dismiss",
    },
    {
      id: acceptId,
      label: input.isPlanRequest ? "Implement" : "Accept",
      behavior: "allow",
      variant: "primary",
    },
  ];
}

interface BuildPermissionResponseInput {
  action: AgentPermissionAction;
  // The user-typed message (when the card exposes a deny-message textarea)
  // OR undefined to fall back to DEFAULT_DENY_MESSAGE on deny actions.
  userTypedDenyMessage?: string;
}

// Maps a clicked action to the wire response. Stamps `interrupt:true` ONLY
// on the canonical "Stop the agent" action; every other deny stays graceful.
// Provider-supplied actions never carry an `interrupt` flag from the
// schema, so they always behave as graceful denies regardless of label —
// upstream provider semantics decide which actions are destructive.
export function buildPermissionResponse(
  input: BuildPermissionResponseInput,
): AgentPermissionResponse {
  const { action, userTypedDenyMessage } = input;
  if (action.behavior === "allow") {
    return {
      behavior: "allow",
      selectedActionId: action.id,
    };
  }
  // behavior === "deny"
  const message = userTypedDenyMessage?.trim() || DEFAULT_DENY_MESSAGE;
  if (action.id === PERMISSION_DENY_STOP_ACTION_ID) {
    return {
      behavior: "deny",
      selectedActionId: action.id,
      message,
      interrupt: true,
    };
  }
  return {
    behavior: "deny",
    selectedActionId: action.id,
    message,
  };
}

// Some downstream UI surfaces (the abort banner that ties to the agent's
// `status:"error"` terminal state) need to know whether the action that was
// just dispatched was a hard-abort. Exported as a helper so callers don't
// reach into the response shape directly.
export function isHardAbortAction(action: AgentPermissionAction): boolean {
  return action.behavior === "deny" && action.id === PERMISSION_DENY_STOP_ACTION_ID;
}
