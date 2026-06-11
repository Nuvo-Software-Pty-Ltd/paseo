import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStore } from "../agent/agent-storage.js";
import { getCurrentWorkspaceAuth, workspaceAuthStorage } from "../cloud-auth.js";
import { TriggerService } from "./service.js";
import { FileBackedWebhookTriggerStore } from "./store.js";
import type { TriggerProvisioner } from "./provisioner.js";
import type { CreateWebhookTriggerInput } from "./types.js";

function fakeProvisioner(): TriggerProvisioner {
  let n = 0;
  return {
    provision: vi.fn(async () => ({
      webhookId: "wh_public",
      ingressUrl: "https://host/hooks/wh_public",
      secret: `secret-${n++}`,
    })),
    rotate: vi.fn(async () => ({
      secret: `rotated-${n++}`,
    })),
    deprovision: vi.fn(async () => undefined),
  };
}

const AGENT_ID = "00000000-0000-0000-0000-000000000001";

// Minimal AgentManager stub — only the methods createAutomationSpawn
// touches for a new-agent target.
function fakeAgentManager(): { manager: AgentManager; runAgent: ReturnType<typeof vi.fn> } {
  const runAgent = vi.fn(async () => ({ timeline: [], finalText: "done" }));
  const manager = {
    createAgent: vi.fn(async () => ({ id: AGENT_ID })),
    runAgent,
    hasInFlightRun: vi.fn(() => false),
  } as unknown as AgentManager;
  return { manager, runAgent };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const NEW_AGENT_INPUT: CreateWebhookTriggerInput = {
  name: "deploy",
  prompt: "run the deploy",
  target: { type: "new-agent", config: { provider: "claude", cwd: "/repo" } },
};

describe("TriggerService", () => {
  let dir: string;
  let store: FileBackedWebhookTriggerStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "trigger-service-test-"));
    store = new FileBackedWebhookTriggerStore(join(dir, "triggers"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeService(over?: { agentManager?: AgentManager }): TriggerService {
    return new TriggerService({
      store,
      provisioner: fakeProvisioner(),
      logger: createTestLogger(),
      agentManager: over?.agentManager ?? fakeAgentManager().manager,
      agentStorage: {} as AgentStore,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
  }

  test("create provisions the ingress, returns the secret once, persists only a fingerprint", async () => {
    const service = makeService();
    const { trigger, secret, ingressUrl } = await service.create(NEW_AGENT_INPUT);
    expect(secret).toBe("secret-0");
    expect(ingressUrl).toBe("https://host/hooks/wh_public");
    expect(trigger.webhookId).toBe("wh_public");
    expect(trigger.secretFingerprint).toBe(secret.slice(-6));
    // Inspect never re-serves the raw secret.
    const inspected = await service.inspect(trigger.id);
    expect(inspected.secretFingerprint).toBe(secret.slice(-6));
    expect(JSON.stringify(inspected)).not.toContain(secret);
  });

  test("fire spawns a new agent and records a succeeded run", async () => {
    const { manager, runAgent } = fakeAgentManager();
    const service = makeService({ agentManager: manager });
    const { trigger } = await service.create(NEW_AGENT_INPUT);
    const { done } = await service.fire(trigger, { hello: "world" });
    await done;
    expect(runAgent).toHaveBeenCalledTimes(1);
    const runs = await service.logs(trigger.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("succeeded");
    expect(runs[0].agentId).toBe(AGENT_ID);
  });

  test("fire acks on spawn and runs the agent turn in the background", async () => {
    // The agent turn is gated open so it cannot complete while we inspect.
    const gate = deferred<{ timeline: never[]; finalText: string }>();
    const runAgent = vi.fn(() => gate.promise);
    const manager = {
      createAgent: vi.fn(async () => ({ id: AGENT_ID })),
      runAgent,
      hasInFlightRun: vi.fn(() => false),
    } as unknown as AgentManager;
    const service = makeService({ agentManager: manager });
    const { trigger } = await service.create(NEW_AGENT_INPUT);

    // fire resolves before the turn completes: the run is persisted as
    // `running` and already carries its spawned agentId (invariant 2).
    const { done } = await service.fire(trigger, {});
    expect(runAgent).toHaveBeenCalledTimes(1);
    const running = await service.logs(trigger.id);
    expect(running).toHaveLength(1);
    expect(running[0].status).toBe("running");
    expect(running[0].agentId).toBe(AGENT_ID);

    // Releasing the turn lets the detached task finalize the run record.
    gate.resolve({ timeline: [], finalText: "ok" });
    await done;
    const settled = await service.logs(trigger.id);
    expect(settled[0].status).toBe("succeeded");
    expect(settled[0].agentId).toBe(AGENT_ID);
  });

  test("a create failure surfaces synchronously and records a failed run", async () => {
    const runAgent = vi.fn(async () => ({ timeline: [], finalText: "x" }));
    const manager = {
      createAgent: vi.fn(async () => {
        throw new Error("ENOENT: no such directory /repo");
      }),
      runAgent,
      hasInFlightRun: vi.fn(() => false),
    } as unknown as AgentManager;
    const service = makeService({ agentManager: manager });
    const { trigger } = await service.create(NEW_AGENT_INPUT);

    // The spawn could not be CREATED — the caller sees a synchronous reject
    // (→ non-2xx at the route), the turn never starts, and the run is failed.
    await expect(service.fire(trigger, {})).rejects.toThrow(/ENOENT/);
    expect(runAgent).not.toHaveBeenCalled();
    const runs = await service.logs(trigger.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].agentId).toBeNull();
  });

  test("the background turn runs inside the trigger's workspace ALS context", async () => {
    let seen: ReturnType<typeof getCurrentWorkspaceAuth>;
    const runAgent = vi.fn(async () => {
      seen = getCurrentWorkspaceAuth();
      return { timeline: [], finalText: "ok" };
    });
    const manager = {
      createAgent: vi.fn(async () => ({ id: AGENT_ID })),
      runAgent,
      hasInFlightRun: vi.fn(() => false),
    } as unknown as AgentManager;
    const service = makeService({ agentManager: manager });
    // Create inside an ALS so the trigger persists cloudOwner* claims.
    const { trigger } = await workspaceAuthStorage.run(
      { workspaceId: "ws_x", accountId: "acc_x", expiresAt: Number.MAX_SAFE_INTEGER },
      () => service.create(NEW_AGENT_INPUT),
    );
    expect(trigger.cloudOwnerWorkspaceId).toBe("ws_x");

    // Fire OUTSIDE any ALS: the detached turn must restore the context from
    // the trigger's persisted claims, or the per-spawn credential won't bind.
    const { done } = await service.fire(trigger, {});
    await done;
    expect(seen).toMatchObject({ workspaceId: "ws_x", accountId: "acc_x" });
  });

  test("a disabled trigger does not spawn", async () => {
    const { manager, runAgent } = fakeAgentManager();
    const service = makeService({ agentManager: manager });
    const { trigger } = await service.create({ ...NEW_AGENT_INPUT, enabled: false });
    await service.fire(trigger, {});
    expect(runAgent).not.toHaveBeenCalled();
    expect(await service.logs(trigger.id)).toHaveLength(0);
  });

  test("payload template renders the sanitized body into the prompt", async () => {
    const { manager, runAgent } = fakeAgentManager();
    const service = makeService({ agentManager: manager });
    const { trigger } = await service.create({
      ...NEW_AGENT_INPUT,
      payloadTemplate: "Event: {{payload}}",
    });
    const bell = String.fromCharCode(7);
    // Raw string payload exercises the control-char stripping path (a
    // JSON object would escape control bytes to safe \uXXXX text instead).
    const { done } = await service.fire(trigger, `opened${bell}pr`);
    await done;
    const prompt = runAgent.mock.calls[0][1] as string;
    expect(prompt).toContain("Event: openedpr");
    // Control char (BEL) stripped from the untrusted body.
    expect(prompt).not.toContain(bell);
  });

  test("rotateSecret returns a new secret and updates the fingerprint", async () => {
    const service = makeService();
    const { trigger, secret } = await service.create(NEW_AGENT_INPUT);
    const rotated = await service.rotateSecret(trigger.id);
    expect(rotated.secret).not.toBe(secret);
    expect(rotated.trigger.secretFingerprint).toBe(rotated.secret.slice(-6));
  });
});
