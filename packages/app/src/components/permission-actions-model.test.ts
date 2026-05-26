import { describe, expect, it } from "vitest";
import type { AgentPermissionAction } from "@server/server/agent/agent-sdk-types";
import {
  buildPermissionResponse,
  isHardAbortAction,
  PERMISSION_ALLOW_ACTION_ID,
  PERMISSION_ALLOW_PLAN_ACTION_ID,
  PERMISSION_DENY_BLOCK_ACTION_ID,
  PERMISSION_DENY_BLOCK_LABEL,
  PERMISSION_DENY_STOP_ACTION_ID,
  PERMISSION_DENY_STOP_LABEL,
  resolveDefaultPermissionActions,
} from "./permission-actions-model";

describe("resolveDefaultPermissionActions", () => {
  it("renders Stop / Block / Accept for a non-plan tool request", () => {
    const actions = resolveDefaultPermissionActions({ isPlanRequest: false });
    expect(actions.map((a) => a.id)).toEqual([
      PERMISSION_DENY_STOP_ACTION_ID,
      PERMISSION_DENY_BLOCK_ACTION_ID,
      PERMISSION_ALLOW_ACTION_ID,
    ]);
    expect(actions.map((a) => a.label)).toEqual([
      PERMISSION_DENY_STOP_LABEL,
      PERMISSION_DENY_BLOCK_LABEL,
      "Accept",
    ]);
  });

  it("renders Stop / Block / Implement for a plan request", () => {
    const actions = resolveDefaultPermissionActions({ isPlanRequest: true });
    expect(actions.map((a) => a.id)).toEqual([
      PERMISSION_DENY_STOP_ACTION_ID,
      PERMISSION_DENY_BLOCK_ACTION_ID,
      PERMISSION_ALLOW_PLAN_ACTION_ID,
    ]);
    expect(actions[2]?.label).toBe("Implement");
  });

  it("marks Stop with the destructive variant so the UI can visually distinguish it", () => {
    const actions = resolveDefaultPermissionActions({ isPlanRequest: false });
    const stop = actions.find((a) => a.id === PERMISSION_DENY_STOP_ACTION_ID);
    const block = actions.find((a) => a.id === PERMISSION_DENY_BLOCK_ACTION_ID);
    expect(stop?.variant).toBe("danger");
    expect(block?.variant).toBe("secondary");
  });
});

const stopAction: AgentPermissionAction = {
  id: PERMISSION_DENY_STOP_ACTION_ID,
  label: PERMISSION_DENY_STOP_LABEL,
  behavior: "deny",
  variant: "danger",
};

const blockAction: AgentPermissionAction = {
  id: PERMISSION_DENY_BLOCK_ACTION_ID,
  label: PERMISSION_DENY_BLOCK_LABEL,
  behavior: "deny",
  variant: "secondary",
};

const allowAction: AgentPermissionAction = {
  id: PERMISSION_ALLOW_ACTION_ID,
  label: "Accept",
  behavior: "allow",
  variant: "primary",
};

describe("buildPermissionResponse", () => {
  it("stamps interrupt:true ONLY on the Stop action (hard abort)", () => {
    const response = buildPermissionResponse({ action: stopAction });
    expect(response).toEqual({
      behavior: "deny",
      selectedActionId: PERMISSION_DENY_STOP_ACTION_ID,
      message: "Denied by user",
      interrupt: true,
    });
  });

  it("omits interrupt on the Block action (graceful tool-error)", () => {
    const response = buildPermissionResponse({ action: blockAction });
    expect(response).toEqual({
      behavior: "deny",
      selectedActionId: PERMISSION_DENY_BLOCK_ACTION_ID,
      message: "Denied by user",
    });
    // Verify the key is truly absent, not just undefined. The daemon
    // distinguishes "missing" from "false" — both close the prompt, but
    // missing keeps the turn alive while explicit false would not.
    expect("interrupt" in response).toBe(false);
  });

  it("does not stamp interrupt on the allow action", () => {
    const response = buildPermissionResponse({ action: allowAction });
    expect(response).toEqual({
      behavior: "allow",
      selectedActionId: PERMISSION_ALLOW_ACTION_ID,
    });
  });

  it("propagates the user-typed deny message verbatim on both deny branches", () => {
    const userMessage = "explain what you want and try again";
    const stop = buildPermissionResponse({
      action: stopAction,
      userTypedDenyMessage: userMessage,
    });
    const block = buildPermissionResponse({
      action: blockAction,
      userTypedDenyMessage: userMessage,
    });
    if (stop.behavior !== "deny" || block.behavior !== "deny") {
      throw new Error("expected deny");
    }
    expect(stop.message).toBe(userMessage);
    expect(block.message).toBe(userMessage);
  });

  it("falls back to the default message when the user typed nothing or whitespace only", () => {
    expect(
      buildPermissionResponse({ action: blockAction, userTypedDenyMessage: "" }),
    ).toMatchObject({ message: "Denied by user" });
    expect(
      buildPermissionResponse({ action: blockAction, userTypedDenyMessage: "   " }),
    ).toMatchObject({ message: "Denied by user" });
  });

  it("trims whitespace from a user-typed message before sending", () => {
    const trimmed = buildPermissionResponse({
      action: blockAction,
      userTypedDenyMessage: "  please rephrase  ",
    });
    if (trimmed.behavior !== "deny") throw new Error("expected deny");
    // The plan calls for the user-typed message to reach the wire as
    // response.message; trimming is a small client-side hygiene step that
    // would otherwise dump indistinguishable leading/trailing whitespace
    // into the daemon's tool-result feedback channel.
    expect(trimmed.message).toBe("please rephrase");
  });
});

describe("isHardAbortAction", () => {
  it("returns true for the Stop action", () => {
    expect(isHardAbortAction(stopAction)).toBe(true);
  });

  it("returns false for the Block action", () => {
    expect(isHardAbortAction(blockAction)).toBe(false);
  });

  it("returns false for the Allow action", () => {
    expect(isHardAbortAction(allowAction)).toBe(false);
  });

  it("returns false for a provider-supplied action with a stop-like label (label is not authoritative)", () => {
    const providerAction: AgentPermissionAction = {
      id: "provider-stop",
      label: "Stop",
      behavior: "deny",
    };
    expect(isHardAbortAction(providerAction)).toBe(false);
  });
});
