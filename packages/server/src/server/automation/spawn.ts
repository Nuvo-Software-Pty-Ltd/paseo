import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStore } from "../agent/agent-storage.js";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import { curateAgentActivity } from "../agent/activity-curator.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import { getUnattendedModeId } from "../agent/provider-manifest.js";
import type { ScheduleExecutionResult, ScheduleTarget } from "../schedule/types.js";

// D-3.5d — shared spawn core for automations (schedules + webhook
// triggers). Extracted verbatim from `ScheduleService.executeSchedule`
// (schedule/service.ts) so both automation kinds reach the agent through
// ONE code path — `agentManager.createAgent` + `runAgent` — rather than a
// forked second spawn implementation. The caller owns prompt wrapping
// (formatSystemNotificationPrompt) and the run-record bookkeeping; this
// helper only performs the spawn and returns the {agentId, output} the
// run record needs.

export interface AutomationSpawnDeps {
  agentManager: AgentManager;
  agentStorage: AgentStore;
  logger: Logger;
}

/**
 * A spawn whose agent already exists (created, or an existing agent that
 * passed its pre-run checks) but whose first turn has not yet run. The
 * caller can ack on `agentId` and defer `runTurn()` to the background.
 *
 * D-3.5d async-ack split: cloud automations are fired over an HTTP ingress
 * with a finite timeout (auth's `postDaemonInternal` is 10s). The agent
 * turn itself takes ~12s, so awaiting it inline times the caller out even
 * though the spawn succeeded — a 502 the sender then retries, double-
 * spawning. By returning a handle the moment the agent is CREATED, the
 * fire path can persist the run record + agentId, ack, and finish the turn
 * detached. `createAgent`/the existing-agent pre-run validation stay in the
 * foreground so genuine create failures (bad cwd/ENOENT, archived agent,
 * in-flight conflict) still surface synchronously.
 */
export interface AutomationSpawnHandle {
  agentId: string;
  runTurn: () => Promise<ScheduleExecutionResult>;
}

function buildRunOutput(params: {
  output: string | null;
  timelineText: string;
  finalText: string;
}): string | null {
  if (params.output && params.output.trim().length > 0) {
    return params.output;
  }
  if (params.finalText.trim().length > 0) {
    return params.finalText.trim();
  }
  if (params.timelineText.trim().length > 0) {
    return params.timelineText.trim();
  }
  return null;
}

/**
 * Create-phase of an automation spawn. Awaits everything up to and
 * including a successful `createAgent` (new-agent target) / the pre-run
 * validation (existing-agent target), then returns a handle whose
 * `runTurn()` performs the actual agent turn. Synchronous failures —
 * archived agent, `hasInFlightRun` conflict, an unconstructable agent —
 * reject here, in the foreground, so the fire path surfaces them before
 * acking. `wrappedPrompt`/`labels` are as in `spawnFromAutomation`.
 */
export async function createAutomationSpawn(params: {
  target: ScheduleTarget;
  wrappedPrompt: string;
  labels: Record<string, string>;
  deps: AutomationSpawnDeps;
}): Promise<AutomationSpawnHandle> {
  const { target, wrappedPrompt, labels, deps } = params;
  const { agentManager, agentStorage, logger } = deps;

  const runTurnFor = (agentId: string): (() => Promise<ScheduleExecutionResult>) => {
    return async () => {
      const result = await agentManager.runAgent(agentId, wrappedPrompt);
      const timelineText = curateAgentActivity(result.timeline);
      return {
        agentId,
        output: buildRunOutput({ output: null, timelineText, finalText: result.finalText }),
      };
    };
  };

  if (target.type === "agent") {
    const record = await agentStorage.get(target.agentId);
    if (record?.archivedAt) {
      throw new Error(`Agent ${target.agentId} is archived`);
    }
    const agent = await ensureAgentLoaded(target.agentId, {
      agentManager,
      agentStorage,
      logger,
    });
    if (agentManager.hasInFlightRun(agent.id)) {
      throw new Error(`Agent ${agent.id} already has an active run`);
    }
    return { agentId: agent.id, runTurn: runTurnFor(agent.id) };
  }

  const config: AgentSessionConfig = {
    provider: target.config.provider,
    cwd: target.config.cwd,
    modeId: target.config.modeId ?? getUnattendedModeId(target.config.provider),
    model: target.config.model,
    thinkingOptionId: target.config.thinkingOptionId,
    title: target.config.title,
    approvalPolicy: target.config.approvalPolicy,
    sandboxMode: target.config.sandboxMode,
    networkAccess: target.config.networkAccess,
    webSearch: target.config.webSearch,
    extra: target.config.extra,
    systemPrompt: target.config.systemPrompt,
    mcpServers: target.config.mcpServers as AgentSessionConfig["mcpServers"],
  };
  const agent = await agentManager.createAgent(config, undefined, { labels });
  return { agentId: agent.id, runTurn: runTurnFor(agent.id) };
}

/**
 * Spawn (or re-prompt) an agent for an automation fire and run its first
 * turn to completion. `wrappedPrompt` is the already-system-notification-
 * wrapped prompt text. `labels` are attached to a freshly-created agent
 * (e.g. `paseo.schedule-id` / `paseo.trigger-id`). Existing-agent targets
 * respect `hasInFlightRun` exactly like schedules do.
 *
 * This is the synchronous (create + run) convenience used by the in-process
 * schedule tick loop, which has no caller timeout. Timeout-bounded HTTP fire
 * paths use {@link createAutomationSpawn} so they can ack on create and run
 * the turn detached.
 */
export async function spawnFromAutomation(params: {
  target: ScheduleTarget;
  wrappedPrompt: string;
  labels: Record<string, string>;
  deps: AutomationSpawnDeps;
}): Promise<ScheduleExecutionResult> {
  const handle = await createAutomationSpawn(params);
  return handle.runTurn();
}
