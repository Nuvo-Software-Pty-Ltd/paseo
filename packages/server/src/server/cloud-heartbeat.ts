import type { Logger } from "pino";
import { cloudHmacFetch } from "./cloud-hmac-fetch.js";

// Workspace heartbeat for the hybrid capacity manager's idle-suspend
// detection. The daemon writes a tiny activity record every 30s; the
// proprietary lifecycle worker scans a sparse DDB GSI on lastHeartbeat
// to decide which workspaces are due for suspend. Activity gates
// (lastHeartbeat-age + activeAgents + connectedClients) live worker-side.
//
// COMPAT(workspace-heartbeat): added in v0.2.X for D-2; the proprietary
// lifecycle worker scans on the GSI populated by this write. Single
// writer for the heartbeat row (auth-service-side, on behalf of the
// daemon via the HMAC POST below).
//
// COMPAT(heartbeat-activeAgents-semantic): the activeAgents counter
// spans agents + running loops + pending schedules (synthesis A6 —
// 2026-05-26). Lifecycle-worker's idle-suspend gate (R7) depends on
// the count, not the discriminator name. Future rename to
// activeWorkUnits is a Day-N breaking change requiring coordinated
// worker update.
//
// Mechanism: HMAC POST to the auth service (not direct DDB). The daemon
// container carries no DDB SDK; auth is the single DDB writer (F9).
// The auth-side route `/api/auth-internal/heartbeat` (owned by
// PLAN-auth-and-shared) accepts the body below, looks up accountId
// server-side from the workspaceId → workspace mapping in DDB, and
// writes `<accountId>#heartbeat / <workspaceId>` with the activity
// payload. The daemon sends workspaceId only.
//
// F3 design-out: the daemon's own workspaceId is read from the
// PASEO_WORKSPACE_ID env var at boot — set by the per-workspace ECS
// task definition (PLAN-cdk-infra). NEVER from an inbound WS RPC. The
// daemon container is per-workspace, so this is a container-level
// identity, not a per-request identity.
//
// 2026-05-22 synthesis (LEARNINGS.md) resolved O-2 to DDB heartbeat
// (over the ALB-metric alternative) because long-running schedules /
// loops with no connected WS clients would falsely flag as idle under
// the ALB-metric path — a data-loss-class bug.

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_INITIAL_JITTER_MAX_MS = 2_000;

export interface HeartbeatSessionRegistry {
  countConnectedClients(): number;
  /**
   * Aggregate "active work units" count surfaced on the heartbeat
   * body as `activeAgents` (field name unchanged per synthesis A6,
   * 2026-05-26). Includes:
   *   - agent processes in `lifecycle:"running"`
   *   - loops in `status:"running"` (LoopService.runningCount())
   *   - schedules whose `nextRunAt` falls within the next heartbeat
   *     window (ScheduleService.pendingCount())
   *
   * The lifecycle worker's R7 idle-suspend gate suspends a workspace
   * when this count is 0 AND connectedClients is 0. A running loop or
   * imminent schedule must keep the workspace alive even with no
   * connected WS clients — otherwise the workspace gets suspended
   * mid-loop (data-loss-class bug; the rejected ALB-metric path from
   * D-2 synthesis O-2 had this same failure mode).
   *
   * The return type is `Promise<number>` because ScheduleService's
   * pendingCount reads the store; LoopService.runningCount is
   * synchronous but composed under one async API for symmetry.
   */
  countActiveAgents(): Promise<number>;
}

export interface HeartbeatWireBody {
  workspaceId: string;
  lastHeartbeat: string; // ISO 8601
  activeAgents: number;
  connectedClients: number;
  daemonImageTag: string;
}

export interface StartHeartbeatLoopParams {
  authServiceBaseUrl: string;
  hmacKey: string;
  workspaceId: string;
  daemonImageTag: string;
  sessionRegistry: HeartbeatSessionRegistry;
  logger: Logger;
  intervalMs?: number;
  // Test seam: inject a fetch impl instead of using the global. Production
  // callers omit; tests pass a vi.fn().
  fetchImpl?: typeof fetch;
  // Initial jitter window (uniform [0, max]). Avoids a thundering-herd of
  // simultaneous heartbeats from a cluster of tasks restarting in the same
  // window. Set to 0 in tests for determinism.
  initialJitterMaxMs?: number;
  // Test seam: replace the jitter selection. Production omits; tests pass
  // a constant function so timing is deterministic.
  jitterPicker?: (maxMs: number) => number;
}

export interface HeartbeatLoopController {
  stop(): void;
}

function defaultJitterPicker(maxMs: number): number {
  return Math.floor(Math.random() * (maxMs + 1));
}

export function startHeartbeatLoop(params: StartHeartbeatLoopParams): HeartbeatLoopController {
  const { authServiceBaseUrl, hmacKey, workspaceId, daemonImageTag, sessionRegistry, logger } =
    params;
  const intervalMs = params.intervalMs ?? DEFAULT_INTERVAL_MS;
  const initialJitterMax = params.initialJitterMaxMs ?? DEFAULT_INITIAL_JITTER_MAX_MS;
  const pickJitter = params.jitterPicker ?? defaultJitterPicker;
  const fetchImpl = params.fetchImpl;

  const url = `${authServiceBaseUrl.replace(/\/$/, "")}/api/auth-internal/heartbeat`;

  let intervalHandle: NodeJS.Timeout | null = null;
  let initialTimeoutHandle: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    let activeAgents: number;
    try {
      activeAgents = await sessionRegistry.countActiveAgents();
    } catch (error) {
      // The scheduler's pendingCount path may throw on a transient DDB
      // read failure (cloud-mode). Skip this tick; the next one will
      // retry on the regular cadence. Critical not to crash the loop —
      // a missed heartbeat is recoverable; a crashed daemon is not.
      logger.warn(
        { err: error, workspaceId },
        "Heartbeat tick skipped — countActiveAgents() threw",
      );
      return;
    }
    const body: HeartbeatWireBody = {
      workspaceId,
      lastHeartbeat: new Date().toISOString(),
      activeAgents,
      connectedClients: sessionRegistry.countConnectedClients(),
      daemonImageTag,
    };
    const bodyString = JSON.stringify(body);
    const result = await cloudHmacFetch({
      url,
      hmacKey,
      body: bodyString,
      logger,
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      logContext: { workspaceId },
      failureLogLabel: "Heartbeat",
    });
    if (result.ok) {
      logger.debug(
        {
          activeAgents: body.activeAgents,
          connectedClients: body.connectedClients,
          workspaceId,
        },
        "Heartbeat delivered",
      );
    }
    // cloudHmacFetch already warned on failure; do not crash the loop —
    // the next tick will retry on the regular cadence.
  };

  const start = (): void => {
    if (stopped) return;
    void tick();
    intervalHandle = setInterval(() => void tick(), intervalMs);
  };

  const initialDelay = pickJitter(initialJitterMax);
  if (initialDelay <= 0) {
    start();
  } else {
    initialTimeoutHandle = setTimeout(() => {
      initialTimeoutHandle = null;
      start();
    }, initialDelay);
  }

  return {
    stop(): void {
      stopped = true;
      if (initialTimeoutHandle !== null) {
        clearTimeout(initialTimeoutHandle);
        initialTimeoutHandle = null;
      }
      if (intervalHandle !== null) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
    },
  };
}
