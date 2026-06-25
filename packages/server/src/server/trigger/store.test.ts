import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { FileBackedWebhookTriggerStore } from "./store.js";
import type { WebhookTrigger } from "@getpaseo/protocol/trigger/types";

function baseTrigger(
  overrides: Partial<Omit<WebhookTrigger, "id">> = {},
): Omit<WebhookTrigger, "id"> {
  return {
    webhookId: "wh_public_abc",
    name: "deploy hook",
    prompt: "do the thing",
    target: { type: "new-agent", config: { provider: "claude", cwd: "/repo" } },
    payloadTemplate: null,
    enabled: true,
    ingressUrl: "https://host/hooks/wh_public_abc",
    secretFingerprint: "abc123",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastFiredAt: null,
    runs: [],
    cloudOwnerWorkspaceId: null,
    cloudOwnerAccountId: null,
    ...overrides,
  };
}

describe("FileBackedWebhookTriggerStore", () => {
  let dir: string;
  let store: FileBackedWebhookTriggerStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "trigger-store-test-"));
    store = new FileBackedWebhookTriggerStore(join(dir, "triggers"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("create assigns an 8-hex id and round-trips via get", async () => {
    const created = await store.create(baseTrigger());
    expect(created.id).toMatch(/^[0-9a-f]{8}$/);
    const fetched = await store.get(created.id);
    expect(fetched).toEqual(created);
  });

  test("getByWebhookId resolves the matching trigger only", async () => {
    const a = await store.create(baseTrigger({ webhookId: "wh_aaa" }));
    await store.create(baseTrigger({ webhookId: "wh_bbb" }));
    const found = await store.getByWebhookId("wh_aaa");
    expect(found?.id).toBe(a.id);
    expect(await store.getByWebhookId("wh_missing")).toBeNull();
  });

  test("delete removes the record", async () => {
    const created = await store.create(baseTrigger());
    await store.delete(created.id);
    expect(await store.get(created.id)).toBeNull();
  });

  test("get returns null for an unknown id", async () => {
    expect(await store.get("deadbeef")).toBeNull();
  });
});
