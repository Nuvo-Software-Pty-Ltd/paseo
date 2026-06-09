import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStore } from "../agent/agent-storage.js";
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

// Minimal AgentManager stub — only the two methods spawnFromAutomation
// touches for a new-agent target.
function fakeAgentManager(): { manager: AgentManager; runAgent: ReturnType<typeof vi.fn> } {
  const runAgent = vi.fn(async () => ({ timeline: [], finalText: "done" }));
  const manager = {
    createAgent: vi.fn(async () => ({ id: "00000000-0000-0000-0000-000000000001" })),
    runAgent,
    hasInFlightRun: vi.fn(() => false),
  } as unknown as AgentManager;
  return { manager, runAgent };
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
    await service.fire(trigger, { hello: "world" });
    expect(runAgent).toHaveBeenCalledTimes(1);
    const runs = await service.logs(trigger.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("succeeded");
    expect(runs[0].agentId).toBe("00000000-0000-0000-0000-000000000001");
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
    await service.fire(trigger, `opened${bell}pr`);
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
