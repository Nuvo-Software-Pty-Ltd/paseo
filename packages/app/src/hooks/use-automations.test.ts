import { describe, expect, it } from "vitest";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import type { WebhookTriggerSummary } from "@getpaseo/protocol/trigger/types";
import { removeScheduleFromListPayload, removeTriggerFromListPayload } from "./use-automations";

// Only `.id` is read by the helpers; minimal fixtures keep the intent clear.
const schedule = (id: string): ScheduleSummary => ({ id }) as unknown as ScheduleSummary;
const trigger = (id: string): WebhookTriggerSummary => ({ id }) as unknown as WebhookTriggerSummary;

describe("removeScheduleFromListPayload", () => {
  it("drops the matching schedule and preserves sibling rows + other fields", () => {
    const payload = { schedules: [schedule("a"), schedule("b")], error: null };
    expect(removeScheduleFromListPayload(payload, "a")).toEqual({
      schedules: [schedule("b")],
      error: null,
    });
  });

  it("is a no-op when the id is absent", () => {
    const payload = { schedules: [schedule("a")] };
    expect(removeScheduleFromListPayload(payload, "missing").schedules).toHaveLength(1);
  });

  it("returns an undefined payload unchanged (list never fetched)", () => {
    expect(removeScheduleFromListPayload(undefined, "a")).toBeUndefined();
  });
});

describe("removeTriggerFromListPayload", () => {
  it("drops the matching trigger and preserves sibling rows + other fields", () => {
    const payload = { triggers: [trigger("a"), trigger("b")], error: null };
    expect(removeTriggerFromListPayload(payload, "b")).toEqual({
      triggers: [trigger("a")],
      error: null,
    });
  });

  it("returns an undefined payload unchanged (list never fetched)", () => {
    expect(removeTriggerFromListPayload(undefined, "a")).toBeUndefined();
  });
});
