import { Router, json } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { Logger } from "pino";
import { cloneWorkspaceRepo, resolveStage } from "./cloud-clone.js";

const CloneRepoBody = z.object({
  accountId: z.string().min(1),
  workspaceId: z.string().min(1),
  repoUrl: z.string().url(),
});

export interface InternalRoutesOptions {
  hmacKey: string;
  logger: Logger;
  smClient?: SecretsManagerClient;
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

  return router;
}
