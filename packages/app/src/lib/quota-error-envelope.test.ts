import { describe, expect, it } from "vitest";
import {
  getQuotaErrorCopy,
  parseQuotaErrorEnvelope,
  QUOTA_CLASSES,
  type QuotaClass,
  type QuotaErrorEnvelope,
} from "./quota-error-envelope";

describe("parseQuotaErrorEnvelope", () => {
  it("parses the canonical envelope shape (WS rpc_error)", () => {
    const parsed = parseQuotaErrorEnvelope({
      code: "quota_exceeded",
      quotaClass: "workspace_count",
      current: 3,
      cap: 3,
    });
    expect(parsed).toEqual({
      code: "quota_exceeded",
      quotaClass: "workspace_count",
      current: 3,
      cap: 3,
    });
  });

  it("preserves retryAfterMs when present (REST 429 with Retry-After hint)", () => {
    const parsed = parseQuotaErrorEnvelope({
      code: "quota_exceeded",
      quotaClass: "agent_count",
      current: 10,
      cap: 10,
      retryAfterMs: 60_000,
    });
    expect(parsed?.retryAfterMs).toBe(60_000);
  });

  it("returns null for non-quota errors (different code)", () => {
    expect(
      parseQuotaErrorEnvelope({
        code: "other_error",
        quotaClass: "workspace_count",
        current: 1,
        cap: 1,
      }),
    ).toBeNull();
  });

  it("returns null for an unknown quotaClass (forward-compat: app from before cloud-shared added a class)", () => {
    expect(
      parseQuotaErrorEnvelope({
        code: "quota_exceeded",
        quotaClass: "future_class_v2",
        current: 1,
        cap: 1,
      }),
    ).toBeNull();
  });

  it("returns null for malformed shapes (non-number current/cap)", () => {
    expect(
      parseQuotaErrorEnvelope({
        code: "quota_exceeded",
        quotaClass: "agent_count",
        current: "3",
        cap: 3,
      }),
    ).toBeNull();
    expect(
      parseQuotaErrorEnvelope({
        code: "quota_exceeded",
        quotaClass: "agent_count",
        current: 3,
        cap: null,
      }),
    ).toBeNull();
  });

  it("returns null for null / undefined / primitives", () => {
    expect(parseQuotaErrorEnvelope(null)).toBeNull();
    expect(parseQuotaErrorEnvelope(undefined)).toBeNull();
    expect(parseQuotaErrorEnvelope("error")).toBeNull();
    expect(parseQuotaErrorEnvelope(42)).toBeNull();
  });
});

describe("getQuotaErrorCopy", () => {
  function envelope(quotaClass: QuotaClass): QuotaErrorEnvelope {
    return { code: "quota_exceeded", quotaClass, current: 3, cap: 3 };
  }

  it("workspace_count renders Archive + Upgrade affordances", () => {
    const copy = getQuotaErrorCopy(envelope("workspace_count"));
    expect(copy.message).toContain("workspace cap (3/3)");
    expect(copy.primaryCta?.kind).toBe("archive-workspaces");
    expect(copy.secondaryCta?.kind).toBe("upgrade-plan");
    expect(copy.silent).toBeUndefined();
  });

  it("agent_count renders Close agent + Upgrade affordances", () => {
    const copy = getQuotaErrorCopy(envelope("agent_count"));
    expect(copy.message).toContain("per-workspace agent cap (3/3)");
    expect(copy.primaryCta?.kind).toBe("close-agent");
    expect(copy.secondaryCta?.kind).toBe("upgrade-plan");
  });

  it("outbound_spend renders the Anthropic spend message + Upgrade", () => {
    const copy = getQuotaErrorCopy(envelope("outbound_spend"));
    expect(copy.message).toContain("Anthropic spend cap");
    expect(copy.secondaryCta?.kind).toBe("upgrade-plan");
  });

  it("loop_count renders the loop cap message + Upgrade", () => {
    const copy = getQuotaErrorCopy(envelope("loop_count"));
    expect(copy.message).toContain("per-workspace loop cap (3/3)");
    expect(copy.secondaryCta?.kind).toBe("upgrade-plan");
  });

  it("workspace_archived_count renders the archived-workspace cap message", () => {
    const copy = getQuotaErrorCopy(envelope("workspace_archived_count"));
    expect(copy.message).toContain("archived-workspace cap (3/3)");
    expect(copy.secondaryCta?.kind).toBe("upgrade-plan");
  });

  it("push_token_count is silent (operator-only, no user-facing render)", () => {
    const copy = getQuotaErrorCopy(envelope("push_token_count"));
    expect(copy.silent).toBe(true);
    expect(copy.message).toBe("");
  });

  it("each QUOTA_CLASSES member has a copy entry (exhaustiveness)", () => {
    for (const cls of QUOTA_CLASSES) {
      const copy = getQuotaErrorCopy(envelope(cls));
      // Either a non-empty message OR silent:true must be set.
      expect(copy.silent === true || copy.message.length > 0).toBe(true);
    }
  });
});
