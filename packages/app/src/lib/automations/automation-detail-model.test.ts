import { describe, expect, it, vi } from "vitest";
import type { StoredSchedule } from "@getpaseo/protocol/schedule/types";
import type { WebhookTrigger } from "@getpaseo/protocol/trigger/types";
import {
  type AutomationDetailClient,
  isAutomationNotFoundError,
  resolveAutomationDetail,
} from "./automation-detail-model";

const schedule = { id: "auto-1", name: "Nightly" } as StoredSchedule;
const trigger = { id: "auto-1", name: "Deploy hook" } as WebhookTrigger;

// Daemon throw shapes the resolver must distinguish (see DaemonRpcError).
const SCHEDULE_NOT_FOUND = new Error(
  "Schedule not found: auto-1 requestType=schedule/inspect code=schedule_request_failed",
);
const CONNECTION_ERROR = new Error("Timeout waiting for message schedule/inspect/response");

// The REAL runtime shape on web. `DaemonRpcError` extends Error, but the app's
// web bundle re-transpiles that class through Metro/Babel, where a subclass of
// the built-in Error does not reliably satisfy `error instanceof Error`. We
// reproduce that here as a plain object carrying the same `.message`, `.code`,
// and `.requestType` — the previous `instanceof Error` guard returned false for
// this and re-threw the raw "Schedule not found" error on the webhook detail.
const SCHEDULE_NOT_FOUND_RPC = {
  name: "DaemonRpcError",
  message: "Schedule not found: auto-1 requestType=schedule/inspect code=schedule_request_failed",
  requestType: "schedule/inspect",
  code: "schedule_request_failed",
} as const;

function makeClient(overrides: Partial<AutomationDetailClient> = {}): AutomationDetailClient {
  return {
    scheduleInspect: vi.fn(async () => ({ schedule: null })),
    scheduleLogs: vi.fn(async () => ({ runs: [] })),
    triggerInspect: vi.fn(async () => ({ trigger: null })),
    triggerLogs: vi.fn(async () => ({ runs: [] })),
    ...overrides,
  };
}

describe("isAutomationNotFoundError", () => {
  it("matches schedule and webhook not-found throws", () => {
    expect(isAutomationNotFoundError(SCHEDULE_NOT_FOUND)).toBe(true);
    expect(isAutomationNotFoundError(new Error("Webhook trigger not found: auto-1"))).toBe(true);
  });

  it("matches the transpiled RPC error shape that is not an Error instance", () => {
    // Regression: on web `instanceof Error` is false for this object, but it is
    // still a genuine schedule not-found and must be treated as one.
    expect(isAutomationNotFoundError(SCHEDULE_NOT_FOUND_RPC)).toBe(true);
  });

  it("does not match connection/host errors or non-errors", () => {
    expect(isAutomationNotFoundError(CONNECTION_ERROR)).toBe(false);
    expect(isAutomationNotFoundError(new Error("Host is not connected"))).toBe(false);
    // A non-not-found schedule RPC failure (same code, different message) must
    // still propagate — we discriminate on the message, never on the code.
    expect(
      isAutomationNotFoundError({
        name: "DaemonRpcError",
        message: "Permission denied requestType=schedule/inspect code=schedule_request_failed",
        code: "schedule_request_failed",
      }),
    ).toBe(false);
    expect(isAutomationNotFoundError("not found")).toBe(false);
    expect(isAutomationNotFoundError(null)).toBe(false);
  });
});

describe("resolveAutomationDetail", () => {
  it("inspects the schedule store directly when kind is schedule", async () => {
    const client = makeClient({ scheduleInspect: vi.fn(async () => ({ schedule })) });

    const result = await resolveAutomationDetail({
      client,
      automationId: "auto-1",
      kind: "schedule",
      webhookSupported: true,
    });

    expect(result).toEqual({ kind: "schedule", record: schedule, runs: [] });
    // Known kind: never probes the webhook store.
    expect(client.triggerInspect).not.toHaveBeenCalled();
  });

  it("inspects the webhook store directly when kind is webhook", async () => {
    const client = makeClient({ triggerInspect: vi.fn(async () => ({ trigger })) });

    const result = await resolveAutomationDetail({
      client,
      automationId: "auto-1",
      kind: "webhook",
      webhookSupported: true,
    });

    expect(result).toEqual({ kind: "webhook", record: trigger, runs: [] });
    expect(client.scheduleInspect).not.toHaveBeenCalled();
  });

  it("resolves a webhook via fallback when the schedule probe throws not-found", async () => {
    const client = makeClient({
      scheduleInspect: vi.fn(async () => {
        throw SCHEDULE_NOT_FOUND;
      }),
      triggerInspect: vi.fn(async () => ({ trigger })),
    });

    const result = await resolveAutomationDetail({
      client,
      automationId: "auto-1",
      kind: undefined,
      webhookSupported: true,
    });

    expect(result).toEqual({ kind: "webhook", record: trigger, runs: [] });
  });

  it("resolves a webhook when the kind-less schedule probe throws the transpiled RPC error", async () => {
    // The production bug: kind is dropped on a web refresh/deep-link, the
    // schedule probe throws the real (non-Error) RPC object, and the resolver
    // must still fall through to the webhook store instead of surfacing it raw.
    const client = makeClient({
      scheduleInspect: vi.fn(async () => {
        throw SCHEDULE_NOT_FOUND_RPC;
      }),
      triggerInspect: vi.fn(async () => ({ trigger })),
    });

    const result = await resolveAutomationDetail({
      client,
      automationId: "auto-1",
      kind: undefined,
      webhookSupported: true,
    });

    expect(result).toEqual({ kind: "webhook", record: trigger, runs: [] });
  });

  it("resolves a schedule via probe when no kind is provided", async () => {
    const client = makeClient({ scheduleInspect: vi.fn(async () => ({ schedule })) });

    const result = await resolveAutomationDetail({
      client,
      automationId: "auto-1",
      kind: undefined,
      webhookSupported: true,
    });

    expect(result.kind).toBe("schedule");
    expect(client.triggerInspect).not.toHaveBeenCalled();
  });

  it("throws not-found when neither store has the id", async () => {
    const client = makeClient({
      scheduleInspect: vi.fn(async () => {
        throw SCHEDULE_NOT_FOUND;
      }),
      triggerInspect: vi.fn(async () => ({ trigger: null })),
    });

    await expect(
      resolveAutomationDetail({
        client,
        automationId: "auto-1",
        kind: undefined,
        webhookSupported: true,
      }),
    ).rejects.toThrow("Automation not found");
  });

  it("re-throws a connection/host error from the probe instead of swallowing it", async () => {
    const client = makeClient({
      scheduleInspect: vi.fn(async () => {
        throw CONNECTION_ERROR;
      }),
      triggerInspect: vi.fn(async () => ({ trigger })),
    });

    await expect(
      resolveAutomationDetail({
        client,
        automationId: "auto-1",
        kind: undefined,
        webhookSupported: true,
      }),
    ).rejects.toThrow("Timeout waiting for message");
    // A real error must surface — we must NOT silently fall through to webhook.
    expect(client.triggerInspect).not.toHaveBeenCalled();
  });

  it("does not probe the webhook store when the capability is absent", async () => {
    const client = makeClient({
      scheduleInspect: vi.fn(async () => {
        throw SCHEDULE_NOT_FOUND;
      }),
    });

    await expect(
      resolveAutomationDetail({
        client,
        automationId: "auto-1",
        kind: undefined,
        webhookSupported: false,
      }),
    ).rejects.toThrow("Automation not found");
    expect(client.triggerInspect).not.toHaveBeenCalled();
  });
});
