import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { InMemoryDynamoClient } from "../cloud-dynamo-client.js";
import type { AgentPermissionRequest } from "./agent-sdk-types.js";
import {
  AgentPermissionRequestRecordSchema,
  DynamoPermissionStore,
  FileBackedPermissionStore,
  InMemoryPermissionStore,
  recordFromRequest,
  type AgentPermissionRequestRecord,
} from "./permission-store.js";

const logger = pino({ level: "silent" });

// Round-19 capture shapes (permission.md § "deny side-effects").
// Both deny shapes must round-trip through put → loadAll → delete
// byte-identical for the `resolution` field. The shape we persist is
// the REQUEST (server-initiated); the resolution travels via WS push.
// Persisting the request lets a cross-restart resume re-emit the
// request to a reconnecting client.

const REQUEST_INTERRUPT_TRUE: AgentPermissionRequest = {
  id: "perm-001",
  provider: "claude",
  name: "Bash",
  kind: "tool",
  title: "Run curl",
  description: "Execute curl on example.com",
  input: { command: "curl https://example.com" },
  actions: [
    { id: "allow", label: "Allow", behavior: "allow" },
    { id: "deny", label: "Deny", behavior: "deny", variant: "danger" },
  ],
};

const REQUEST_INTERRUPT_OMITTED: AgentPermissionRequest = {
  id: "perm-002",
  provider: "claude",
  name: "Edit",
  kind: "tool",
  input: { file_path: "/tmp/x", old_string: "a", new_string: "b" },
};

interface StoreFixture {
  store: InMemoryPermissionStore | FileBackedPermissionStore | DynamoPermissionStore;
  cleanup: () => Promise<void>;
}

async function buildInMemoryFixture(): Promise<StoreFixture> {
  return { store: new InMemoryPermissionStore(), cleanup: async () => {} };
}

async function buildFileBackedFixture(): Promise<StoreFixture> {
  const dir = await mkdtemp(join(tmpdir(), "perm-store-test-"));
  return {
    store: new FileBackedPermissionStore({ paseoHome: dir, logger }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function buildDynamoFixture(): Promise<StoreFixture> {
  return {
    store: new DynamoPermissionStore({
      client: new InMemoryDynamoClient(),
      workspaceId: "ws_test",
      logger,
    }),
    cleanup: async () => {},
  };
}

function filterByAgent(all: AgentPermissionRequestRecord[], agentId: string) {
  return all.filter((r) => r.agentId === agentId);
}

function sortById(records: AgentPermissionRequestRecord[]): string[] {
  return records.map((r) => r.request.id).sort();
}

function describePermissionStoreContract(label: string, build: () => Promise<StoreFixture>): void {
  describe(label, () => {
    let fixture: StoreFixture;

    beforeEach(async () => {
      fixture = await build();
    });

    afterEach(async () => {
      await fixture.cleanup();
    });

    test("loadAll returns [] when empty", async () => {
      expect(await fixture.store.loadAll()).toEqual([]);
    });

    test("put + loadAll round-trips a request with interrupt:true semantics intact", async () => {
      await fixture.store.put(recordFromRequest("agent-A", REQUEST_INTERRUPT_TRUE));
      const all = await fixture.store.loadAll();
      expect(all).toHaveLength(1);
      expect(all[0].agentId).toBe("agent-A");
      expect(all[0].request.id).toBe("perm-001");
      expect(all[0].request.actions).toEqual([
        { id: "allow", label: "Allow", behavior: "allow" },
        { id: "deny", label: "Deny", behavior: "deny", variant: "danger" },
      ]);
    });

    test("put + loadAll round-trips a request with interrupt-omitted semantics intact", async () => {
      await fixture.store.put(recordFromRequest("agent-B", REQUEST_INTERRUPT_OMITTED));
      const all = await fixture.store.loadAll();
      expect(all).toHaveLength(1);
      expect(all[0].request.actions).toBeUndefined();
      expect(all[0].request.input).toEqual({
        file_path: "/tmp/x",
        old_string: "a",
        new_string: "b",
      });
    });

    test("multiple permissions for the same agent share one storage unit", async () => {
      await fixture.store.put(recordFromRequest("agent-X", REQUEST_INTERRUPT_TRUE));
      await fixture.store.put(recordFromRequest("agent-X", REQUEST_INTERRUPT_OMITTED));
      const all = filterByAgent(await fixture.store.loadAll(), "agent-X");
      expect(all).toHaveLength(2);
      expect(sortById(all)).toEqual(["perm-001", "perm-002"]);
    });

    test("delete removes one row without touching siblings on the same agent", async () => {
      await fixture.store.put(recordFromRequest("agent-X", REQUEST_INTERRUPT_TRUE));
      await fixture.store.put(recordFromRequest("agent-X", REQUEST_INTERRUPT_OMITTED));
      await fixture.store.delete("agent-X", "perm-001");
      const remaining = filterByAgent(await fixture.store.loadAll(), "agent-X");
      expect(remaining).toHaveLength(1);
      expect(remaining[0].request.id).toBe("perm-002");
    });

    test("delete(unknown) is a no-op (does not throw)", async () => {
      await expect(fixture.store.delete("nobody", "nothing")).resolves.not.toThrow();
    });

    test("deleteAllForAgent clears every row for the agent", async () => {
      await fixture.store.put(recordFromRequest("agent-X", REQUEST_INTERRUPT_TRUE));
      await fixture.store.put(recordFromRequest("agent-X", REQUEST_INTERRUPT_OMITTED));
      await fixture.store.put(recordFromRequest("agent-Y", REQUEST_INTERRUPT_TRUE));
      await fixture.store.deleteAllForAgent("agent-X");
      const all = await fixture.store.loadAll();
      const agentIds = all.map((r) => r.agentId).sort();
      expect(agentIds).toEqual(["agent-Y"]);
    });
  });
}

describe("PermissionStore — shared contract", () => {
  describePermissionStoreContract("InMemoryPermissionStore", buildInMemoryFixture);
  describePermissionStoreContract("FileBackedPermissionStore", buildFileBackedFixture);
  describePermissionStoreContract("DynamoPermissionStore", buildDynamoFixture);
});

describe("AgentPermissionRequestRecordSchema", () => {
  test("parses a valid record", () => {
    const record: AgentPermissionRequestRecord = recordFromRequest(
      "agent-Z",
      REQUEST_INTERRUPT_TRUE,
    );
    const parsed = AgentPermissionRequestRecordSchema.parse(record);
    expect(parsed.agentId).toBe("agent-Z");
  });

  test("rejects an empty agentId", () => {
    const bad = recordFromRequest("", REQUEST_INTERRUPT_TRUE);
    expect(() => AgentPermissionRequestRecordSchema.parse(bad)).toThrow();
  });

  test("rejects an unknown kind", () => {
    const bad = {
      ...recordFromRequest("agent-Z", REQUEST_INTERRUPT_TRUE),
      request: { ...REQUEST_INTERRUPT_TRUE, kind: "shenanigans" },
    };
    expect(() => AgentPermissionRequestRecordSchema.parse(bad)).toThrow();
  });
});

describe("FileBackedPermissionStore — cross-restart parity", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "perm-store-restart-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("a freshly-constructed store sees rows written by a prior instance (simulated restart)", async () => {
    const store1 = new FileBackedPermissionStore({ paseoHome: dir, logger });
    await store1.put(recordFromRequest("agent-A", REQUEST_INTERRUPT_TRUE));
    await store1.put(recordFromRequest("agent-A", REQUEST_INTERRUPT_OMITTED));

    const store2 = new FileBackedPermissionStore({ paseoHome: dir, logger });
    const all = await store2.loadAll();
    expect(all).toHaveLength(2);
    expect(all.every((r) => r.agentId === "agent-A")).toBe(true);
  });
});
