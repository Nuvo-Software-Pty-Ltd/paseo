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
 * Spawn (or re-prompt) an agent for an automation fire. `wrappedPrompt`
 * is the already-system-notification-wrapped prompt text. `labels` are
 * attached to a freshly-created agent (e.g. `paseo.schedule-id` /
 * `paseo.trigger-id`). Existing-agent targets respect `hasInFlightRun`
 * exactly like schedules do.
 */
export async function spawnFromAutomation(params: {
  target: ScheduleTarget;
  wrappedPrompt: string;
  labels: Record<string, string>;
  deps: AutomationSpawnDeps;
}): Promise<ScheduleExecutionResult> {
  const { target, wrappedPrompt, labels, deps } = params;
  const { agentManager, agentStorage, logger } = deps;

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
    const result = await agentManager.runAgent(agent.id, wrappedPrompt);
    const timelineText = curateAgentActivity(result.timeline);
    return {
      agentId: agent.id,
      output: buildRunOutput({ output: null, timelineText, finalText: result.finalText }),
    };
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
  const result = await agentManager.runAgent(agent.id, wrappedPrompt);
  const timelineText = curateAgentActivity(result.timeline);
  return {
    agentId: agent.id,
    output: buildRunOutput({ output: null, timelineText, finalText: result.finalText }),
  };
}
