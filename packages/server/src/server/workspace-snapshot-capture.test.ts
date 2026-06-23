import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { attachWorkspaceSnapshotCapture } from "./persistence-hooks.js";
import {
  WorkspaceSnapshotStore,
  setWorkspaceSnapshotStoreForTesting,
  type SnapshotArgs,
  type WorkspaceSnapshotS3,
} from "./workspace-snapshot-store.js";

const noopS3: WorkspaceSnapshotS3 = {
  putObject: async () => {},
  getObjectBytes: async () => {
    throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
  },
  listObjectKeys: async () => [],
  deleteObjects: async () => {},
};

// Minimal AgentManagerStateSource double with a manual emit.
function fakeManager() {
  let cb: ((e: unknown) => void) | null = null;
  return {
    subscribe(c: (e: unknown) => void) {
      cb = c;
      return () => {
        cb = null;
      };
    },
    emit(e: unknown) {
      cb?.(e);
    },
    get subscribed() {
      return cb !== null;
    },
  };
}

const logger = pino({ level: "silent" });

describe("attachWorkspaceSnapshotCapture", () => {
  const savedEnv = { ...process.env };
  let store: WorkspaceSnapshotStore;
  let calls: SnapshotArgs[];

  beforeEach(() => {
    process.env.PASEO_CLOUD_MODE = "1";
    process.env.PASEO_PERSIST_WORKSPACE_SNAPSHOT = "1";
    process.env.PASEO_WORKSPACE_ID = "ws_x";
    store = new WorkspaceSnapshotStore({ logger, client: noopS3, bucket: "b" });
    calls = [];
    store.snapshot = async (args: SnapshotArgs) => {
      calls.push(args);
    };
    setWorkspaceSnapshotStoreForTesting(store);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    setWorkspaceSnapshotStoreForTesting(null);
  });

  test("turn-settle triggers a snapshot with the agent's cwd", async () => {
    const mgr = fakeManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detach = attachWorkspaceSnapshotCapture(logger, mgr as any, {
      periodicIntervalMs: 10_000,
    });
    expect(mgr.subscribed).toBe(true);
    mgr.emit({
      type: "agent_state",
      agent: { lifecycle: "idle", cwd: "/workspace/ws_x/repo", id: "a" },
    });
    await Promise.resolve();
    expect(calls).toEqual([{ workspaceId: "ws_x", repoDir: "/workspace/ws_x/repo" }]);
    await detach();
  });

  test("ignores closed agents and non-agent_state events", async () => {
    const mgr = fakeManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detach = attachWorkspaceSnapshotCapture(logger, mgr as any, {
      periodicIntervalMs: 10_000,
    });
    mgr.emit({
      type: "agent_state",
      agent: { lifecycle: "closed", cwd: "/workspace/ws_x/repo", id: "a" },
    });
    mgr.emit({ type: "turn_started", agent: { lifecycle: "running", cwd: "/x", id: "a" } });
    await Promise.resolve();
    expect(calls).toEqual([]);
    await detach();
  });

  test("disabled when the deploy flag is unset → never subscribes", async () => {
    process.env.PASEO_PERSIST_WORKSPACE_SNAPSHOT = "0";
    const mgr = fakeManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detach = attachWorkspaceSnapshotCapture(logger, mgr as any);
    expect(mgr.subscribed).toBe(false);
    await detach(); // no-op, must not throw
    expect(calls).toEqual([]);
  });

  test("shutdown detach performs one final flush of the active repo", async () => {
    const mgr = fakeManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detach = attachWorkspaceSnapshotCapture(logger, mgr as any, {
      periodicIntervalMs: 10_000,
    });
    mgr.emit({
      type: "agent_state",
      agent: { lifecycle: "idle", cwd: "/workspace/ws_x/repo", id: "a" },
    });
    await Promise.resolve();
    calls.length = 0; // disregard the turn-settle capture
    await detach();
    expect(calls).toEqual([{ workspaceId: "ws_x", repoDir: "/workspace/ws_x/repo" }]);
    expect(mgr.subscribed).toBe(false); // detach unsubscribed
  });
});
