import { Router, json } from "express";
import { constants as fsConstants, createReadStream, openSync, closeSync, statSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { Logger } from "pino";
import { cloneWorkspaceRepo, resolveStage } from "./cloud-clone.js";
import { workspaceAuthStorage } from "./cloud-auth.js";
import type { ScheduleService } from "./schedule/service.js";
import type { ScheduleStore } from "./schedule/store.js";
import type { TriggerService } from "./trigger/service.js";
import type { WebhookTriggerStore } from "./trigger/store.js";

const CloneRepoBody = z.object({
  accountId: z.string().min(1),
  workspaceId: z.string().min(1),
  repoUrl: z.string().url(),
});

// T-15 — lifecycle-worker fires a schedule. Body shape verified
// against
// `orchestra-cloud-private:d-3-plan-lifecycle-worker/packages/lifecycle-worker/src/routes/schedule-fire-callback.ts`
// HEAD `7788692` (round-3 audit). The worker's outbound call at
// line 148 is literally `{ scheduleId }` — workspaceId comes from
// the daemon's own `PASEO_WORKSPACE_ID` binding (paseo PR #5), not
// the wire. The route uses `.strict()` so any drift from the worker
// side (e.g., someone later adds `workspaceId` to the body) produces
// a clear 400 here at the contract surface, rather than the daemon
// silently ignoring the extra field. Closes INTEGRATION-NOTE 4 from
// the resumed-run audit.
const ScheduleFireBody = z
  .object({
    scheduleId: z.string().min(1),
  })
  .strict();

// D-3.5d — POST /api/internal/webhook-fire (HMAC-validated).
//
// The cloud ingress edge verifies the per-trigger signature, resolves the
// public webhookId → internal triggerId via the global
// `webhook-route#<webhookId>` item, and forwards `{ triggerId, payload }`.
// FIX (VERIFY-3.5d #2): the body carries the INTERNAL `triggerId`, NOT the
// public `webhookId` — the daemon does a DIRECT `store.get(triggerId)`
// (rows are keyed `sk="<triggerId>#meta"`), so there is no partition scan
// and no webhookId→trigger ambiguity on the hot fire path. `.strict()` so
// any drift from the cloud side surfaces as a 400 here.
//
// Cloud contract the ingress MUST honor: forward the daemon the internal
// `triggerId` (held alongside accountId/workspaceId in the
// `webhook-route#<webhookId>` item), never the raw webhookId.
const WebhookFireBody = z
  .object({
    triggerId: z.string().min(1),
    payload: z.unknown().optional(),
  })
  .strict();

// T-16 — download-token internal redemption. Auth's
// `GET /api/files/download/:tokenId` 302-redirects to the per-workspace
// daemon's `/api/files/download/internal/:tokenId`. No body — the
// token lives in the URL path.

export interface InternalRoutesOptions {
  hmacKey: string;
  logger: Logger;
  smClient?: SecretsManagerClient;
  /**
   * Cloud-mode-only services. Omitted on-host; injected by the
   * bootstrap caller when isPaseoCloudMode() is true.
   */
  scheduleService?: ScheduleService;
  scheduleStore?: ScheduleStore;
  /**
   * D-3.5d webhook-trigger fire path. Injected in cloud mode alongside the
   * schedule services.
   */
  triggerService?: TriggerService;
  triggerStore?: WebhookTriggerStore;
  /**
   * Bound workspace identity from PASEO_WORKSPACE_ID. Used to assert
   * the schedule-fire body's workspaceId matches what the worker
   * thinks (defense-in-depth alongside the JWT binding).
   */
  expectedWorkspaceId?: string;
  /**
   * For T-16 file downloads — workspace root (defaults to
   * `/workspace/<workspaceId>` per agent-host-topology.md).
   */
  workspaceRoot?: string;
  /**
   * Auth service base URL — daemon HMAC-POSTs the check-download-token
   * route to revalidate before streaming. Sourced from
   * ORCHESTRA_AUTH_INTERNAL_URL.
   */
  authInternalUrl?: string;
  fetchImpl?: typeof fetch;
}

function verifyHmac(body: string, hmacHeader: string | undefined, key: string): boolean {
  if (!hmacHeader) return false;
  const expected = crypto.createHmac("sha256", key).update(body).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(hmacHeader, "hex"));
}

export function createInternalRoutes(options: InternalRoutesOptions): Router {
  const router = Router();
  const { hmacKey, logger } = options;
  const smClient = options.smClient ?? new SecretsManagerClient({});
  const stage = resolveStage();

  router.use(json());

  const handleCloneRepo = async (
    req: import("express").Request,
    res: import("express").Response,
  ): Promise<void> => {
    try {
      const rawBody = JSON.stringify(req.body);
      const hmacHeader = req.headers["x-orchestra-internal-hmac"] as string | undefined;

      if (!verifyHmac(rawBody, hmacHeader, hmacKey)) {
        logger.warn("Rejected internal clone-repo request: HMAC verification failed");
        res.status(401).json({ error: "Unauthorized: invalid HMAC signature" });
        return;
      }

      const parsed = CloneRepoBody.safeParse(req.body);
      if (!parsed.success) {
        logger.warn(
          { issues: parsed.error.issues },
          "Rejected internal clone-repo request: invalid body",
        );
        res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
        return;
      }

      const { accountId, workspaceId, repoUrl } = parsed.data;
      logger.info({ accountId, workspaceId, repoUrl }, "Processing internal clone-repo request");

      let workspacePath: string;
      try {
        const result = await cloneWorkspaceRepo({
          accountId,
          workspaceId,
          repoUrl,
          smClient,
          logger,
          stage,
        });
        workspacePath = result.workspacePath;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/Invalid GitHub repository URL/.test(message)) {
          logger.error({ repoUrl }, "Invalid GitHub repo URL");
          res.status(400).json({ error: "Invalid GitHub repository URL" });
          return;
        }
        if (/Secret is empty|Secret not found|SecretsManager/.test(message)) {
          // Credential-fetch failure: surface as auth/credentials issue, not
          // a generic 500. Matches prior shape so the auth-service caller's
          // error handling stays unchanged.
          res.status(500).json({ error: "Failed to retrieve GitHub credentials" });
          return;
        }
        logger.error({ err, workspaceId }, "git clone failed");
        res.status(500).json({
          error: "git clone failed",
          message,
        });
        return;
      }

      res.status(200).json({ workspacePath });
    } catch (err) {
      logger.error({ err }, "Unhandled error in clone-repo handler");
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  };

  router.post("/api/internal/clone-repo", (req, res) => {
    void handleCloneRepo(req, res);
  });

  // T-15 — POST /api/internal/schedule-fire (HMAC-validated).
  //
  // Lifecycle-worker POSTs `{ scheduleId }` after an EventBridge fire.
  // Daemon: validate HMAC → look up schedule → restore ALS via the
  // schedule's cloudOwnerWorkspaceId/AccountId (T-7) → invoke
  // executeSchedule. The schedule's runs[] is appended by the existing
  // on-host ScheduleService code path; the DynamoStore's putRun writes
  // the new row.
  const handleScheduleFire = async (
    req: import("express").Request,
    res: import("express").Response,
  ): Promise<void> => {
    const { scheduleService, scheduleStore, expectedWorkspaceId } = options;
    if (!scheduleService || !scheduleStore) {
      // Not configured for cloud mode — should never be called.
      res.status(503).json({ error: "schedule-fire route not configured" });
      return;
    }
    try {
      const rawBody = JSON.stringify(req.body);
      const hmacHeader = req.headers["x-orchestra-internal-hmac"] as string | undefined;
      if (!verifyHmac(rawBody, hmacHeader, hmacKey)) {
        logger.warn("Rejected /api/internal/schedule-fire: HMAC verification failed");
        res.status(401).json({ error: "Unauthorized: invalid HMAC signature" });
        return;
      }
      const parsed = ScheduleFireBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
        return;
      }
      const { scheduleId } = parsed.data;
      const schedule = await scheduleStore.get(scheduleId);
      if (!schedule) {
        logger.info({ scheduleId }, "schedule-fire: schedule not found — worker treats as no-op");
        res.status(404).json({ error: "schedule_not_found" });
        return;
      }
      // Idempotent skip for paused / completed schedules — the worker
      // logs and moves on.
      if (schedule.status !== "active") {
        res.status(200).json({ ok: true, skipped: true, reason: `status_${schedule.status}` });
        return;
      }
      // T-7 ALS restoration. If the schedule was created in cloud
      // mode (cloudOwnerWorkspaceId set), wrap the executeSchedule
      // call in workspaceAuthStorage.run so the agent spawn finds
      // its per-spawn ~/.claude credential. Cross-tenant defense:
      // verify the persisted workspaceId matches PASEO_WORKSPACE_ID
      // (defense-in-depth).
      if (
        expectedWorkspaceId &&
        schedule.cloudOwnerWorkspaceId &&
        schedule.cloudOwnerWorkspaceId !== expectedWorkspaceId
      ) {
        logger.warn(
          { scheduleId, expected: expectedWorkspaceId, got: schedule.cloudOwnerWorkspaceId },
          "schedule-fire: cross-workspace schedule rejected (defense-in-depth)",
        );
        res.status(403).json({ error: "workspace_mismatch" });
        return;
      }
      const run = async (): Promise<void> => {
        // ScheduleService.runOnce is the public manual-fire affordance.
        // It calls the same internal runSchedule path the tick loop
        // uses, generating runs[] entries per the on-host code path.
        // The DynamoStore.putRun side-effect writes the per-run row.
        await scheduleService.runOnce(scheduleId);
      };
      if (schedule.cloudOwnerWorkspaceId && schedule.cloudOwnerAccountId) {
        await workspaceAuthStorage.run(
          {
            workspaceId: schedule.cloudOwnerWorkspaceId,
            accountId: schedule.cloudOwnerAccountId,
            expiresAt: Number.MAX_SAFE_INTEGER,
          },
          run,
        );
      } else {
        await run();
      }
      res.status(200).json({ ok: true, scheduleId });
    } catch (err) {
      logger.error({ err }, "Unhandled error in schedule-fire handler");
      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error" });
      }
    }
  };

  // Gate registration on the schedule services being present. bootstrap.ts
  // mounts this router TWICE in cloud mode: an EARLY clone-repo-only mount
  // (no services) and a LATE service-equipped mount. Registering the route
  // unconditionally let the early mount win in Express's matcher and return
  // its 503 "not configured" guard, shadowing the late handler. Gating means
  // only the late, service-equipped mount owns this route. The handler keeps
  // its defensive 503 check as belt-and-suspenders.
  if (options.scheduleService && options.scheduleStore) {
    router.post("/api/internal/schedule-fire", (req, res) => {
      void handleScheduleFire(req, res);
    });
  }

  // D-3.5d — POST /api/internal/webhook-fire (HMAC-validated).
  //
  // Same trust boundary as schedule-fire: the daemon trusts the
  // internal-HMAC caller; the per-trigger signature was verified upstream
  // at the cloud ingress edge. Resolves the trigger by internal triggerId
  // (direct get), re-checks the forwarded workspace against
  // PASEO_WORKSPACE_ID (defense in depth), restores ALS, and fires.
  const handleWebhookFire = async (
    req: import("express").Request,
    res: import("express").Response,
  ): Promise<void> => {
    const { triggerService, triggerStore, expectedWorkspaceId } = options;
    if (!triggerService || !triggerStore) {
      res.status(503).json({ error: "webhook-fire route not configured" });
      return;
    }
    try {
      const rawBody = JSON.stringify(req.body);
      const hmacHeader = req.headers["x-orchestra-internal-hmac"] as string | undefined;
      if (!verifyHmac(rawBody, hmacHeader, hmacKey)) {
        logger.warn("Rejected /api/internal/webhook-fire: HMAC verification failed");
        res.status(401).json({ error: "Unauthorized: invalid HMAC signature" });
        return;
      }
      const parsed = WebhookFireBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
        return;
      }
      const { triggerId, payload } = parsed.data;
      const trigger = await triggerStore.get(triggerId);
      if (!trigger) {
        logger.info({ triggerId }, "webhook-fire: trigger not found — treat as no-op");
        res.status(404).json({ error: "trigger_not_found" });
        return;
      }
      // Cross-tenant defense in depth — a forwarded trigger whose persisted
      // workspace doesn't match this daemon's binding is rejected, never
      // fired (mirrors schedule-fire's expected-workspace check).
      if (
        expectedWorkspaceId &&
        trigger.cloudOwnerWorkspaceId &&
        trigger.cloudOwnerWorkspaceId !== expectedWorkspaceId
      ) {
        logger.warn(
          { triggerId, expected: expectedWorkspaceId, got: trigger.cloudOwnerWorkspaceId },
          "webhook-fire: cross-workspace trigger rejected (defense-in-depth)",
        );
        res.status(403).json({ error: "workspace_mismatch" });
        return;
      }
      // TriggerService.fire restores ALS internally from the trigger's
      // persisted cloudOwner* claims, so no wrapping is needed here.
      await triggerService.fire(trigger, payload ?? {});
      res.status(200).json({ ok: true, triggerId });
    } catch (err) {
      logger.error({ err }, "Unhandled error in webhook-fire handler");
      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error" });
      }
    }
  };

  // Gated for the same early/late double-mount reason as schedule-fire above:
  // only the late, trigger-service-equipped mount registers this route, so the
  // early clone-repo-only mount can't shadow it with a 503. Defensive 503
  // check inside the handler is kept as belt-and-suspenders.
  if (options.triggerService && options.triggerStore) {
    router.post("/api/internal/webhook-fire", (req, res) => {
      void handleWebhookFire(req, res);
    });
  }

  // T-16 — GET /api/files/download/internal/:tokenId.
  //
  // Auth's GET /api/files/download/:tokenId 302-redirects browsers to
  // this route. The daemon:
  //   1. Validates the HMAC over the empty body (so a third party
  //      can't trigger a download by guessing tokenIds — only the
  //      auth-service-issued redirect carries the HMAC header).
  //   2. Revalidates via POST /api/auth-internal/files/check-download-token
  //      to confirm the token is still valid + owned by this workspace.
  //   3. Streams the file with O_NOFOLLOW to prevent symlink-escape.
  //
  // F9: daemon never writes the token row; auth is the single writer.
  // F3: workspaceId comes from PASEO_WORKSPACE_ID, never from the wire.
  // Helpers extracted to keep handleDownloadInternal under the per-
  // function complexity ceiling (oxlint max=20).

  interface DownloadInternalDeps {
    authInternalUrl: string;
    expectedWorkspaceId: string;
    workspaceRoot: string;
    fetchImpl?: typeof fetch;
  }

  interface CheckPayload {
    valid?: boolean;
    workspaceId?: string;
    filePath?: string;
    reason?: string;
  }

  const revalidateCheckToken = async (
    deps: DownloadInternalDeps,
    tokenId: string,
  ): Promise<{ ok: true; payload: CheckPayload } | { ok: false; status: number }> => {
    const checkBody = JSON.stringify({
      tokenId,
      expectedWorkspaceId: deps.expectedWorkspaceId,
    });
    const direct = deps.fetchImpl ?? fetch;
    const directHmac = crypto.createHmac("sha256", hmacKey).update(checkBody).digest("hex");
    const res = await direct(
      `${deps.authInternalUrl.replace(/\/$/, "")}/api/auth-internal/files/check-download-token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Orchestra-Internal-HMAC": directHmac,
        },
        body: checkBody,
      },
    );
    if (!res.ok) return { ok: false, status: res.status };
    const payload = (await res.json()) as CheckPayload;
    return { ok: true, payload };
  };

  const streamFileForDownload = (
    res: import("express").Response,
    workspaceRoot: string,
    relPath: string,
    tokenId: string,
  ): void => {
    const resolved = path.resolve(workspaceRoot, relPath);
    if (!resolved.startsWith(path.resolve(workspaceRoot) + path.sep)) {
      logger.warn(
        { tokenId, filePath: relPath, resolved },
        "download-token resolved outside workspace root — rejecting",
      );
      res.status(400).json({ error: "path_traversal" });
      return;
    }
    const flags =
      fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
    let fd: number;
    try {
      fd = openSync(resolved, flags);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        res.status(404).json({ error: "file_not_found" });
        return;
      }
      logger.error({ err, resolved }, "openSync failed for download");
      res.status(500).json({ error: "read_failed" });
      return;
    }
    try {
      const stats = statSync(resolved);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Length", String(stats.size));
      res.setHeader("Content-Disposition", `attachment; filename="${path.basename(resolved)}"`);
      const stream = createReadStream(resolved, { fd });
      stream.on("error", (streamErr) => {
        logger.error({ err: streamErr, resolved }, "stream error during download");
        if (!res.headersSent) res.status(500).end();
      });
      stream.pipe(res);
    } catch (err) {
      closeSync(fd);
      logger.error({ err, resolved }, "stat failed for download");
      res.status(500).json({ error: "read_failed" });
    }
  };

  const handleDownloadInternal = async (
    req: import("express").Request,
    res: import("express").Response,
  ): Promise<void> => {
    const { authInternalUrl, expectedWorkspaceId, workspaceRoot, fetchImpl } = options;
    const tokenId = String(req.params.tokenId ?? "");
    if (!authInternalUrl || !expectedWorkspaceId || !workspaceRoot) {
      res.status(503).json({ error: "file-download internal route not configured" });
      return;
    }
    if (!tokenId) {
      res.status(400).json({ error: "missing_token" });
      return;
    }
    const hmacHeader = req.headers["x-orchestra-internal-hmac"] as string | undefined;
    if (!verifyHmac("", hmacHeader, hmacKey)) {
      logger.warn({ tokenId }, "Rejected /api/files/download/internal: HMAC verification failed");
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const deps: DownloadInternalDeps = {
      authInternalUrl,
      expectedWorkspaceId,
      workspaceRoot,
      ...(fetchImpl ? { fetchImpl } : {}),
    };
    const check = await revalidateCheckToken(deps, tokenId);
    if (!check.ok) {
      res.status(check.status === 404 ? 410 : 403).json({
        error: check.status === 404 ? "token_gone" : "token_invalid",
      });
      return;
    }
    const payload = check.payload;
    if (!payload.valid || payload.workspaceId !== expectedWorkspaceId || !payload.filePath) {
      res.status(403).json({ error: "token_invalid", reason: payload.reason });
      return;
    }
    streamFileForDownload(res, workspaceRoot, payload.filePath, tokenId);
  };

  // Gated for the same early/late double-mount reason as the fire routes
  // above: this download route needs authInternalUrl + workspaceRoot +
  // expectedWorkspaceId (all injected only at the late mount), so registering
  // it only when those deps are present keeps the early clone-repo-only mount
  // from shadowing it with a 503. The handler keeps its defensive 503 check.
  if (options.authInternalUrl && options.workspaceRoot && options.expectedWorkspaceId) {
    router.get("/api/files/download/internal/:tokenId", (req, res) => {
      void handleDownloadInternal(req, res);
    });
  }

  return router;
}
