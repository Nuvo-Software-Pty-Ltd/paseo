import { Router, json } from "express";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { Logger } from "pino";

// Secrets Manager path template for the account's GitHub OAuth token.
// Mirrors `@orchestra/cloud-shared`'s `keys.accountGithubToken()` —
// duplicated by design to keep the AGPL / proprietary open-core boundary
// clean. If the template changes in cloud-shared/keys.ts, update here too.
function buildGithubTokenSecretId(stage: string, accountId: string): string {
  return `orchestra/${stage}/account/${accountId}/github-token`;
}

function resolveStage(): string {
  const stage = process.env.ORCHESTRA_STAGE?.trim();
  return stage && stage.length > 0 ? stage : "dev";
}

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

function parseGitHubRepoUrl(repoUrl: string): { owner: string; repo: string } | null {
  try {
    const url = new URL(repoUrl);
    if (url.hostname !== "github.com") return null;
    const parts = url.pathname
      .replace(/^\//, "")
      .replace(/\.git$/, "")
      .split("/");
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
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

      const ghParsed = parseGitHubRepoUrl(repoUrl);
      if (!ghParsed) {
        logger.error({ repoUrl }, "Invalid GitHub repo URL");
        res.status(400).json({ error: "Invalid GitHub repository URL" });
        return;
      }

      let ghToken: string;
      const ghTokenSecretId = buildGithubTokenSecretId(stage, accountId);
      try {
        const result = await smClient.send(
          new GetSecretValueCommand({ SecretId: ghTokenSecretId }),
        );
        if (!result.SecretString) {
          throw new Error("Secret is empty");
        }
        ghToken = result.SecretString;
      } catch (err) {
        logger.error(
          { err, accountId, secretId: ghTokenSecretId },
          "Failed to fetch GitHub token from Secrets Manager",
        );
        res.status(500).json({ error: "Failed to retrieve GitHub credentials" });
        return;
      }

      const cloneUrl = `https://x-access-token:${ghToken}@github.com/${ghParsed.owner}/${ghParsed.repo}.git`;
      const destPath = `/workspace/${workspaceId}/.git-canonical/`;

      logger.info(
        { workspaceId, owner: ghParsed.owner, repo: ghParsed.repo, destPath },
        "Starting git clone",
      );

      try {
        await runGitClone(cloneUrl, destPath);
      } catch (err) {
        logger.error({ err, workspaceId }, "git clone failed");
        res.status(500).json({
          error: "git clone failed",
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      const workspacePath = `/workspace/${workspaceId}`;
      logger.info({ workspaceId, workspacePath }, "Clone completed successfully");
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

function runGitClone(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["clone", "--depth=1", url, dest], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`git clone exited with code ${code}: ${stderr.trim()}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn git: ${err.message}`));
    });
  });
}
