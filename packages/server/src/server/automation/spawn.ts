import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStore } from "../agent/agent-storage.js";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import { curateAgentActivity } from "../agent/activity-curator.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import { resolveCreateAgentTitles } from "../agent/create-agent-title.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { getUnattendedModeId } from "@getpaseo/protocol/provider-manifest";
import type { ScheduleExecutionResult, ScheduleTarget } from "@getpaseo/protocol/schedule/types";

// D-3.5d — shared spawn core for automations (schedules + webhook
// triggers). Extracted verbatim from `ScheduleService.executeSchedule`
// (schedule/service.ts) so both automation kinds reach the agent through
// ONE code path — `agentManager.createAgent` + `runAgent` — rather than a
// forked second spawn implementation. The caller owns prompt wrapping
// (formatSystemNotificationPrompt) and the run-record bookkeeping; this
// helper only performs the spawn and returns the {agentId, output} the
// run record needs.

// The slice of ProviderSnapshotManager the new-agent spawn needs to resolve
// the provider's create-config (unattended mode + feature values) the same way
// the interactive create-agent path does. Optional so existing-agent spawns and
// callers without a snapshot manager (none today) still work.
export type AutomationCreateConfigResolver = Pick<ProviderSnapshotManager, "resolveCreateConfig">;

export interface AutomationSpawnDeps {
  agentManager: AgentManager;
  agentStorage: AgentStore;
  logger: Logger;
  providerSnapshotManager?: AutomationCreateConfigResolver;
  /**
   * Create-or-reuse a Paseo worktree for a "dedicated-worktree" /
   * "fresh-worktree-per-run" routine and register it as a workspace. Returns the
   * worktree's cwd + workspaceId so the new-agent spawn runs there and is
   * attributed to it. `created` is true only when a fresh worktree was made (the
   * fire path persists cwd/workspaceId back onto a dedicated-worktree schedule on
   * first creation). `retention` (per-run only) archives all but the newest
   * `keep` sibling worktrees sharing `siblingBranchPrefix`. Injected in
   * bootstrap; absent ⇒ non-"reuse" modes throw a clear error.
   */
  createDedicatedWorktree?: (input: {
    sourceCwd: string;
    slug: string;
    branchName: string;
    retention?: { siblingBranchPrefix: string; keep: number };
  }) => Promise<{ cwd: string; workspaceId: string; created: boolean }>;
  /**
   * Resolve the workspace the spawn will run in (by workspaceId when known, else
   * by cwd) and, if it is archived, unarchive it + emit a workspace_update
   * upsert. Returns the resolved workspaceId for agent attribution — this is what
   * makes a scheduled agent appear in the active list / history under its
   * workspace (today the spawn passes no workspaceId at all). Returns null when
   * no record matches (caller then runs cwd-only). Injected in bootstrap;
   * absent ⇒ no-op (today's behavior).
   */
  unarchiveWorkspace?: (input: {
    workspaceId?: string;
    cwd: string;
  }) => Promise<{ workspaceId: string } | null>;
}

/** Injected (setter) into the schedule + trigger services from bootstrap. */
export type DedicatedWorktreeCreator = NonNullable<AutomationSpawnDeps["createDedicatedWorktree"]>;
export type WorkspaceUnarchiver = NonNullable<AutomationSpawnDeps["unarchiveWorkspace"]>;

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
  /**
   * Workspace the spawned agent was attributed to — a resolved/auto-unarchived
   * reuse workspace, or a freshly-created/reused dedicated worktree. Undefined
   * when no workspace record resolved (cwd-only spawn). The fire path uses this
   * to write the dedicated worktree's id back onto the schedule.
   */
  resolvedWorkspaceId?: string;
  /** Effective cwd the agent runs in (the worktree path for worktree modes). */
  resolvedCwd?: string;
  /** True when this fire created a fresh worktree (→ caller writes it back). */
  resolvedCreated?: boolean;
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
 * Resolve where a new-agent automation runs and which workspace it attaches to:
 * apply the run-location mode (reuse / dedicated-worktree / fresh-worktree-per-
 * run), then auto-unarchive + resolve the workspaceId for attribution. Extracted
 * from {@link createAutomationSpawn} to keep that function under the lint
 * complexity ceiling. Returns the effective cwd + resolved workspaceId (undefined
 * ⇒ cwd-only spawn) + whether a fresh worktree was created this fire.
 */
async function resolveAutomationSpawnWorkspace(params: {
  target: Extract<ScheduleTarget, { type: "new-agent" }>;
  labels: Record<string, string>;
  deps: AutomationSpawnDeps;
  maxRetainedRuns?: number | null;
}): Promise<{
  effectiveCwd: string;
  resolvedWorkspaceId: string | undefined;
  resolvedCreated: boolean;
}> {
  const { target, labels, deps, maxRetainedRuns } = params;
  const workspaceMode = target.config.workspaceMode ?? "reuse";
  let effectiveCwd = target.config.cwd;
  let resolvedWorkspaceId = target.config.workspaceId ?? undefined;
  let resolvedCreated = false;

  // "dedicated-worktree" creates once then reuses (skip when already pinned);
  // "fresh-worktree-per-run" creates every fire.
  const needsWorktree =
    workspaceMode === "fresh-worktree-per-run" ||
    (workspaceMode === "dedicated-worktree" && !resolvedWorkspaceId);
  if (needsWorktree) {
    if (!deps.createDedicatedWorktree) {
      throw new Error(
        `Routine run-location "${workspaceMode}" requires worktree support, which is unavailable in this daemon`,
      );
    }
    const automationId = labels["paseo.schedule-id"] ?? labels["paseo.trigger-id"] ?? "routine";
    const runId = labels["paseo.schedule-run"] ?? labels["paseo.trigger-run"];
    const slugBase = `routine-${automationId}`;
    const perRun = workspaceMode === "fresh-worktree-per-run";
    const slug = perRun && runId ? `${slugBase}-${runId.slice(0, 8)}` : slugBase;
    const created = await deps.createDedicatedWorktree({
      sourceCwd: target.config.cwd,
      slug,
      branchName: `paseo/${slug}`,
      retention: perRun
        ? { siblingBranchPrefix: `paseo/${slugBase}-`, keep: maxRetainedRuns ?? 10 }
        : undefined,
    });
    effectiveCwd = created.cwd;
    resolvedWorkspaceId = created.workspaceId;
    resolvedCreated = created.created;
  }

  // Auto-unarchive the target (reuse + dedicated) so the routine's agent is
  // reachable even when the workspace was archived while the schedule kept
  // firing. ALSO supplies the workspaceId for attribution in the common
  // (non-archived) reuse case. cwd-only when no record resolves.
  if (deps.unarchiveWorkspace) {
    try {
      const restored = await deps.unarchiveWorkspace({
        workspaceId: resolvedWorkspaceId,
        cwd: effectiveCwd,
      });
      if (restored) {
        resolvedWorkspaceId = restored.workspaceId;
      }
    } catch (error) {
      deps.logger.warn(
        { err: error, cwd: effectiveCwd },
        "Auto-unarchive of automation workspace failed; spawning anyway",
      );
    }
  }

  return { effectiveCwd, resolvedWorkspaceId, resolvedCreated };
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
  /**
   * New-agent run flavor. Schedules (upstream behavior) run the RAW schedule
   * prompt so it renders as a normal user turn, derive the agent title from it,
   * and ARCHIVE the throwaway agent once its single run settles. Webhook
   * triggers (D-3.5d) run the system-notification `wrappedPrompt` and KEEP the
   * agent (it is the user's ongoing conversation). When omitted, defaults to the
   * webhook flavor (wrapped prompt, no archive, no title derivation) — which is
   * the conservative behavior for existing-agent targets and unconfigured
   * callers. Ignored for existing-agent targets.
   */
  newAgent?: {
    /** Prompt actually fed to `runAgent` (raw for schedules). */
    runPrompt: string;
    /** Archive the new agent after the run settles (and on failure). */
    archiveAfterRun: boolean;
  };
  /** Per-run worktree retention cap (workspaceMode "fresh-worktree-per-run"). */
  maxRetainedRuns?: number | null;
}): Promise<AutomationSpawnHandle> {
  const { target, wrappedPrompt, labels, deps, newAgent } = params;
  const { agentManager, agentStorage, logger, providerSnapshotManager } = deps;

  // Existing-agent targets always run the wrapped (system-notification) prompt
  // and are never archived by the automation.
  const runTurnForExisting = (agentId: string): (() => Promise<ScheduleExecutionResult>) => {
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
    return { agentId: agent.id, runTurn: runTurnForExisting(agent.id) };
  }

  const runPrompt = newAgent?.runPrompt ?? wrappedPrompt;
  const archiveAfterRun = newAgent?.archiveAfterRun ?? false;

  // Resolve WHERE this new-agent runs + which workspace it attaches to (run-
  // location mode + auto-unarchive). Extracted to a helper to keep this function
  // under the lint complexity ceiling.
  const { effectiveCwd, resolvedWorkspaceId, resolvedCreated } =
    await resolveAutomationSpawnWorkspace({
      target,
      labels,
      deps,
      maxRetainedRuns: params.maxRetainedRuns,
    });

  // Resolve the provider's create-config (unattended mode + feature values) the
  // same way the interactive create path does, so a scheduled/triggered new
  // agent lands in the provider's unattended mode (e.g. bypassPermissions /
  // build+auto_accept) instead of the bare manifest default. Upstream parity:
  // an explicit modeId on the target is honored verbatim (the resolver is
  // skipped); otherwise the resolver is consulted with requestedMode undefined.
  // Without a snapshot manager, fall back to the manifest unattended mode.
  // Lazily resolve the fallback only when the target pins no explicit modeId, so
  // the (potentially expensive) snapshot-manager call is skipped otherwise. Split
  // out of the inline conditional to satisfy no-nested-ternary without changing
  // evaluation order.
  const resolveFallbackCreateConfig = async () =>
    providerSnapshotManager
      ? await providerSnapshotManager.resolveCreateConfig({
          cwd: effectiveCwd,
          provider: target.config.provider,
          requestedMode: undefined,
          featureValues: target.config.featureValues,
          parent: null,
          unattended: true,
        })
      : {
          modeId: getUnattendedModeId(target.config.provider),
          featureValues: target.config.featureValues,
        };
  const resolvedCreateConfig =
    target.config.modeId !== undefined
      ? { modeId: target.config.modeId, featureValues: target.config.featureValues }
      : await resolveFallbackCreateConfig();

  // Derive the agent title from the raw prompt (first content line) unless the
  // target pins an explicit title. Mirrors resolveCreateAgentTitles in the
  // interactive create path. Only schedules supply newAgent.runPrompt (the raw
  // prompt); webhook triggers leave the title underived.
  const { provisionalTitle } = resolveCreateAgentTitles({
    configTitle: target.config.title,
    initialPrompt: newAgent?.runPrompt,
  });

  const config: AgentSessionConfig = {
    provider: target.config.provider,
    cwd: effectiveCwd,
    modeId: resolvedCreateConfig.modeId,
    model: target.config.model,
    thinkingOptionId: target.config.thinkingOptionId,
    title: target.config.title ?? undefined,
    approvalPolicy: target.config.approvalPolicy,
    sandboxMode: target.config.sandboxMode,
    networkAccess: target.config.networkAccess,
    webSearch: target.config.webSearch,
    featureValues: resolvedCreateConfig.featureValues,
    extra: target.config.extra,
    systemPrompt: target.config.systemPrompt,
    mcpServers: target.config.mcpServers as AgentSessionConfig["mcpServers"],
  };
  const agent = await agentManager.createAgent(config, undefined, {
    labels,
    initialPrompt: newAgent?.runPrompt,
    initialTitle: provisionalTitle,
    workspaceId: resolvedWorkspaceId,
  });

  const runTurn = async (): Promise<ScheduleExecutionResult> => {
    let result;
    try {
      result = await agentManager.runAgent(agent.id, runPrompt);
    } catch (error) {
      if (archiveAfterRun) {
        try {
          await agentManager.archiveAgent(agent.id);
        } catch (archiveError) {
          logger.warn(
            { err: archiveError, agentId: agent.id },
            "Failed to archive automation agent after failed run",
          );
        }
      }
      throw error;
    }
    if (archiveAfterRun) {
      await agentManager.archiveAgent(agent.id);
    }
    const timelineText = curateAgentActivity(result.timeline);
    return {
      agentId: agent.id,
      output: buildRunOutput({ output: null, timelineText, finalText: result.finalText }),
    };
  };

  return {
    agentId: agent.id,
    runTurn,
    resolvedWorkspaceId,
    resolvedCwd: effectiveCwd,
    resolvedCreated,
  };
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
  newAgent?: { runPrompt: string; archiveAfterRun: boolean };
  maxRetainedRuns?: number | null;
}): Promise<ScheduleExecutionResult> {
  const handle = await createAutomationSpawn(params);
  return handle.runTurn();
}
