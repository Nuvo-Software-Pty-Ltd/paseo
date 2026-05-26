import { describe, expect, it } from "vitest";
import {
  fromWireWorkspaceHardDeleteImminentEvent,
  toWireWorkspaceHardDeleteImminentEvent,
  WorkspaceHardDeleteImminentEventSchema,
  WorkspaceHardDeleteImminentEventWireSchema,
  type WorkspaceHardDeleteImminentEvent,
  type WorkspaceHardDeleteImminentEventWire,
} from "./cloud-webhook-events.js";

const VALID_EVENT: WorkspaceHardDeleteImminentEvent = {
  eventType: "workspace.hard_delete_imminent",
  workspaceId: "ws_abc",
  accountId: "acc_1",
  archivedAt: "2026-05-22T00:00:00.000Z",
  scheduledPurgeAt: "2026-06-21T00:00:00.000Z",
};

const VALID_WIRE: WorkspaceHardDeleteImminentEventWire = {
  event_type: "workspace.hard_delete_imminent",
  workspace_id: "ws_abc",
  account_id: "acc_1",
  archived_at: "2026-05-22T00:00:00.000Z",
  scheduled_purge_at: "2026-06-21T00:00:00.000Z",
};

describe("WorkspaceHardDeleteImminentEventSchema (camelCase, in-TS)", () => {
  it("parses a valid event round-trip", () => {
    const parsed = WorkspaceHardDeleteImminentEventSchema.parse(VALID_EVENT);
    expect(parsed).toEqual(VALID_EVENT);
  });

  it("rejects unknown fields under .strict()", () => {
    const withExtra = { ...VALID_EVENT, extra: "nope" };
    expect(() => WorkspaceHardDeleteImminentEventSchema.parse(withExtra)).toThrow();
  });

  it("rejects an empty workspaceId", () => {
    expect(() =>
      WorkspaceHardDeleteImminentEventSchema.parse({ ...VALID_EVENT, workspaceId: "" }),
    ).toThrow();
  });

  it("rejects an empty accountId", () => {
    expect(() =>
      WorkspaceHardDeleteImminentEventSchema.parse({ ...VALID_EVENT, accountId: "" }),
    ).toThrow();
  });

  it("rejects a non-ISO archivedAt", () => {
    expect(() =>
      WorkspaceHardDeleteImminentEventSchema.parse({
        ...VALID_EVENT,
        archivedAt: "not a datetime",
      }),
    ).toThrow();
  });

  it("rejects a wrong eventType literal", () => {
    expect(() =>
      WorkspaceHardDeleteImminentEventSchema.parse({
        ...VALID_EVENT,
        eventType: "workspace.other",
      }),
    ).toThrow();
  });
});

describe("WorkspaceHardDeleteImminentEventWireSchema (snake_case, on-the-wire)", () => {
  it("parses a valid wire payload round-trip", () => {
    const parsed = WorkspaceHardDeleteImminentEventWireSchema.parse(VALID_WIRE);
    expect(parsed).toEqual(VALID_WIRE);
  });

  it("rejects unknown fields under .strict()", () => {
    const withExtra = { ...VALID_WIRE, extra: "nope" };
    expect(() => WorkspaceHardDeleteImminentEventWireSchema.parse(withExtra)).toThrow();
  });

  it("rejects camelCase keys (would silently lose snake_case fields if accepted)", () => {
    expect(() => WorkspaceHardDeleteImminentEventWireSchema.parse(VALID_EVENT)).toThrow();
  });

  it("rejects a non-ISO scheduled_purge_at", () => {
    expect(() =>
      WorkspaceHardDeleteImminentEventWireSchema.parse({
        ...VALID_WIRE,
        scheduled_purge_at: "not a datetime",
      }),
    ).toThrow();
  });
});

describe("transform between camelCase and snake_case", () => {
  it("toWire produces a payload that the wire schema accepts", () => {
    const wire = toWireWorkspaceHardDeleteImminentEvent(VALID_EVENT);
    expect(wire).toEqual(VALID_WIRE);
    expect(() => WorkspaceHardDeleteImminentEventWireSchema.parse(wire)).not.toThrow();
  });

  it("fromWire produces a payload that the in-TS schema accepts", () => {
    const evt = fromWireWorkspaceHardDeleteImminentEvent(VALID_WIRE);
    expect(evt).toEqual(VALID_EVENT);
    expect(() => WorkspaceHardDeleteImminentEventSchema.parse(evt)).not.toThrow();
  });

  it("toWire ∘ fromWire is identity on a valid wire payload", () => {
    expect(
      toWireWorkspaceHardDeleteImminentEvent(fromWireWorkspaceHardDeleteImminentEvent(VALID_WIRE)),
    ).toEqual(VALID_WIRE);
  });

  it("fromWire ∘ toWire is identity on a valid in-TS event", () => {
    expect(
      fromWireWorkspaceHardDeleteImminentEvent(toWireWorkspaceHardDeleteImminentEvent(VALID_EVENT)),
    ).toEqual(VALID_EVENT);
  });
});
