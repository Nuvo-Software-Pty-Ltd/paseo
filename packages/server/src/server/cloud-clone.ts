import { spawn } from "node:child_process";
import { GetSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import crypto from "node:crypto";
import type { Logger } from "pino";

// F9 design-out: this module is the SINGLE writer for the cloud
// workspace-clone side-effect. Callers:
//   1. POST /api/internal/clone-repo (auth-service-triggered, HMAC-signed)
//      — see internal-routes.ts.
//   2. Workspace path repair-on-missing in handleOpenProjectRequest
//      (session.ts) — gates on existsSync(/workspace/<id>) === false and
//      re-clones before responding open_project_response.
// Do not add a third caller. If a new side-effect writer is needed, route
// it through cloneWorkspaceRepo here so the secret-fetch + clone primitive
// stays unified.

// Secrets Manager path template for the account's GitHub OAuth token.
// Mirrors `@orchestra/cloud-shared`'s `keys.accountGithubToken()` —
// duplicated by design to keep the AGPL / proprietary open-core boundary
// clean. If the template changes in cloud-shared/keys.ts, update here too.
export function buildGithubTokenSecretId(stage: string, accountId: string): string {
  return `orchestra/${stage}/account/${accountId}/github-token`;
}

export function resolveStage(): string {
  const stage = process.env.ORCHESTRA_STAGE?.trim();
  return stage && stage.length > 0 ? stage : "dev";
}

export interface ParsedGitHubRepo {
  owner: string;
  repo: string;
}

export function parseGitHubRepoUrl(repoUrl: string): ParsedGitHubRepo | null {
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

export function runGitClone(url: string, dest: string): Promise<void> {
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

export interface FetchGithubTokenParams {
  stage: string;
  accountId: string;
  smClient: SecretsManagerClient;
  logger: Logger;
}

export async function fetchGithubTokenForAccount(params: FetchGithubTokenParams): Promise<string> {
  const { stage, accountId, smClient, logger } = params;
  const secretId = buildGithubTokenSecretId(stage, accountId);
  try {
    const result = await smClient.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (!result.SecretString) {
      throw new Error("Secret is empty");
    }
    return result.SecretString;
  } catch (err) {
    logger.error({ err, accountId, secretId }, "Failed to fetch GitHub token from Secrets Manager");
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export interface CloneWorkspaceRepoParams {
  accountId: string;
  workspaceId: string;
  repoUrl: string;
  smClient: SecretsManagerClient;
  logger: Logger;
  stage?: string;
}

export interface CloneWorkspaceRepoResult {
  workspacePath: string;
}

export async function cloneWorkspaceRepo(
  params: CloneWorkspaceRepoParams,
): Promise<CloneWorkspaceRepoResult> {
  const { accountId, workspaceId, repoUrl, smClient, logger } = params;
  const stage = params.stage ?? resolveStage();

  const ghParsed = parseGitHubRepoUrl(repoUrl);
  if (!ghParsed) {
    throw new Error(`Invalid GitHub repository URL: ${repoUrl}`);
  }

  const ghToken = await fetchGithubTokenForAccount({ stage, accountId, smClient, logger });

  const cloneUrl = `https://x-access-token:${ghToken}@github.com/${ghParsed.owner}/${ghParsed.repo}.git`;
  const destPath = `/workspace/${workspaceId}/.git-canonical/`;

  logger.info(
    { workspaceId, owner: ghParsed.owner, repo: ghParsed.repo, destPath },
    "Starting git clone",
  );

  await runGitClone(cloneUrl, destPath);

  const workspacePath = `/workspace/${workspaceId}`;
  logger.info({ workspaceId, workspacePath }, "Clone completed successfully");
  return { workspacePath };
}

// HMAC client for the auth-service-side describe-workspace lookup.
// Mirrors the inverse direction (auth → daemon clone-repo): the daemon
// signs a small JSON body with the shared ORCHESTRA_INTERNAL_HMAC_KEY and
// the auth service returns { accountId, repoUrl } for the given workspace.
// Open-core boundary: this is a thin HTTP client; no DDB / cloud-shared
// imports in the AGPL fork.

export interface FetchWorkspaceRepoUrlParams {
  authServiceBaseUrl: string;
  hmacKey: string;
  workspaceId: string;
  logger: Logger;
  // Test seam: inject a fetch impl instead of using the global. Production
  // callers omit; tests pass a vi.fn().
  fetchImpl?: typeof fetch;
}

export interface DescribeWorkspaceResponse {
  accountId: string;
  repoUrl: string;
}

export async function fetchWorkspaceRepoUrl(
  params: FetchWorkspaceRepoUrlParams,
): Promise<DescribeWorkspaceResponse> {
  const { authServiceBaseUrl, hmacKey, workspaceId, logger } = params;
  const doFetch = params.fetchImpl ?? fetch;
  const bodyString = JSON.stringify({ workspaceId });
  const hmac = crypto.createHmac("sha256", hmacKey).update(bodyString).digest("hex");
  const url = `${authServiceBaseUrl.replace(/\/$/, "")}/api/internal/describe-workspace`;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Orchestra-Internal-HMAC": hmac,
      },
      body: bodyString,
    });
  } catch (err) {
    logger.error({ err, workspaceId, url }, "describe-workspace fetch failed");
    throw err instanceof Error ? err : new Error(String(err));
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    logger.error(
      { workspaceId, status: response.status, body: text },
      "describe-workspace returned non-2xx",
    );
    throw new Error(`describe-workspace returned ${response.status}: ${text}`);
  }

  const json = (await response.json()) as Partial<DescribeWorkspaceResponse>;
  if (typeof json.accountId !== "string" || typeof json.repoUrl !== "string") {
    throw new Error(
      `describe-workspace response missing accountId/repoUrl (got ${JSON.stringify(json)})`,
    );
  }
  return { accountId: json.accountId, repoUrl: json.repoUrl };
}
