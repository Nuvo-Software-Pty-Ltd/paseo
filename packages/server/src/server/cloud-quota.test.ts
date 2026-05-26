import { describe, expect, it } from "vitest";

import {
  fromWireQuotaExceeded,
  QuotaExceededError,
  QuotaExceededWireSchema,
  toWireQuotaExceeded,
  tryParseQuotaExceededBody,
  type QuotaExceededPayload,
} from "./cloud-quota.js";

describe("cloud-quota — T-12 envelope (synthesis A8)", () => {
  it("round-trips a typed quota payload through the snake_case wire schema", () => {
    const payload: QuotaExceededPayload = {
      code: "quota_exceeded",
      quotaClass: "agent_count",
      current: 10,
      cap: 10,
    };
    const wire = toWireQuotaExceeded(payload);
    expect(wire).toEqual({
      code: "quota_exceeded",
      quota_class: "agent_count",
      current: 10,
      cap: 10,
    });
    const parsed = QuotaExceededWireSchema.parse(wire);
    expect(fromWireQuotaExceeded(parsed)).toEqual(payload);
  });

  it("accepts open-ended quotaClass strings (forward-compat)", () => {
    const payload: QuotaExceededPayload = {
      code: "quota_exceeded",
      quotaClass: "some_future_class",
      current: 1,
      cap: 1,
    };
    const wire = toWireQuotaExceeded(payload);
    expect(QuotaExceededWireSchema.parse(wire).quota_class).toBe("some_future_class");
  });

  it("tryParseQuotaExceededBody parses a valid 429 body", () => {
    const body = JSON.stringify({
      code: "quota_exceeded",
      quota_class: "outbound_api_spend",
      current: 500.5,
      cap: 500,
    });
    const parsed = tryParseQuotaExceededBody(body);
    expect(parsed).toEqual({
      code: "quota_exceeded",
      quotaClass: "outbound_api_spend",
      current: 500.5,
      cap: 500,
    });
  });

  it("tryParseQuotaExceededBody returns null on malformed JSON", () => {
    expect(tryParseQuotaExceededBody("not-json")).toBeNull();
  });

  it("tryParseQuotaExceededBody returns null on missing fields", () => {
    expect(tryParseQuotaExceededBody(JSON.stringify({ code: "quota_exceeded" }))).toBeNull();
  });

  it("tryParseQuotaExceededBody returns null on wrong code", () => {
    const body = JSON.stringify({
      code: "rate_limited",
      quota_class: "agent_count",
      current: 10,
      cap: 10,
    });
    expect(tryParseQuotaExceededBody(body)).toBeNull();
  });

  it("QuotaExceededError exposes the payload + a useful message", () => {
    const err = new QuotaExceededError({
      code: "quota_exceeded",
      quotaClass: "workspace_count",
      current: 3,
      cap: 3,
    });
    expect(err.name).toBe("QuotaExceededError");
    expect(err.message).toContain("workspace_count");
    expect(err.message).toContain("3 >= 3");
    expect(err.toPayload()).toEqual({
      code: "quota_exceeded",
      quotaClass: "workspace_count",
      current: 3,
      cap: 3,
    });
  });
});
