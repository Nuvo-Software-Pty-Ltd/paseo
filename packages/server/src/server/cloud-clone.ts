import { spawn } from "node:child_process";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import crypto from "node:crypto";
import type { Logger } from "pino";

import { isPaseoCloudMode } from "./paseo-env.js";

// F9 design-out: this module is the SINGLE writer for the cloud
// workspace-clone side-effect. Sanctioned callers:
//   1. POST /api/internal/clone-repo (auth-service-triggered, HMAC-signed)
//      — see internal-routes.ts.
//   2. Workspace path repair-on-missing in handleOpenProjectRequest
//      (session.ts) — gates on existsSync(/workspace/<id>) === false and
//      re-clones before responding open_project_response.
//   3. D-3.5a add_project (session.ts handleAddProjectRequest) — clones a
//      2nd/Nth repo into a per-project subdir under /workspace/<ws>/. It calls
//      this FUNCTION directly (NOT POST /api/internal/clone-repo, which is an
//      inbound auth→daemon route — VERIFY-3.5a finding #5/#6).
// Do not add a further caller. If a new side-effect writer is needed, route
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

// BYO-runtimes L0 — optionally surface the account GitHub token to
// user-reachable env (the agent, terminals, and `worktree.setup` all inherit
// `process.env`), so toolchain managers that hit the GitHub API (mise, asdf)
// aren't throttled by GitHub's 60/hr unauthenticated limit during install.
//
// OFF by default. Enabled only when `ORCHESTRA_EXPOSE_GITHUB_TOKEN="1"`. This
// is the FIRST place the account token leaves the clone URL and becomes
// readable by arbitrary user code in the workspace — a deliberate, opt-in
// security escalation (the token can push to the user's repos). No-op outside
// cloud mode, when the flag is unset, when no account id is known, or when a
// token is already present (an operator-supplied PAT wins). Never throws: a
// fetch failure must not block the daemon boot.
export async function maybeExposeGithubTokenToEnv(deps: {
  logger: Logger;
  smClient?: SecretsManagerClient;
}): Promise<void> {
  if (!isPaseoCloudMode()) return;
  if (process.env.ORCHESTRA_EXPOSE_GITHUB_TOKEN?.trim() !== "1") return;
  const accountId = process.env.PASEO_ACCOUNT_ID?.trim();
  if (!accountId) return;
  // Respect an operator/user-provided token — never overwrite.
  if (process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim()) return;
  try {
    const token = await fetchGithubTokenForAccount({
      stage: resolveStage(),
      accountId,
      smClient: deps.smClient ?? new SecretsManagerClient({}),
      logger: deps.logger,
    });
    process.env.GITHUB_TOKEN = token;
    process.env.GH_TOKEN = token;
    deps.logger.info(
      "ORCHESTRA_EXPOSE_GITHUB_TOKEN=1 — surfaced account GitHub token as " +
        "GITHUB_TOKEN/GH_TOKEN to workspace subprocesses",
    );
  } catch (err) {
    deps.logger.warn(
      { err },
      "ORCHESTRA_EXPOSE_GITHUB_TOKEN=1 set but failed to fetch the account " +
        "GitHub token; continuing without it",
    );
  }
}

export interface CloneWorkspaceRepoParams {
  accountId: string;
  workspaceId: string;
  repoUrl: string;
  smClient: SecretsManagerClient;
  logger: Logger;
  stage?: string;
  // D-3.5a (T-4) — clone destination subdir under /workspace/<ws>/. Defaults
  // to `.git-canonical` (the migrated first project; unchanged → no re-clone).
  // add_project passes a per-project slug for 2nd/Nth repos.
  destSubdir?: string;
}

export interface CloneWorkspaceRepoResult {
  workspacePath: string;
  // The actual clone directory (`/workspace/<ws>/<destSubdir>`) — the new
  // project's rootPath.
  clonePath: string;
}

// D-3.5a (T-4 / OQ-6) — collision-free per-project slug. Two repos with the
// same name in different orgs must not collide: slug = `<org>__<repo>`.
export function deriveProjectCloneSlug(parsed: ParsedGitHubRepo): string {
  const sanitize = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "-");
  return `${sanitize(parsed.owner)}__${sanitize(parsed.repo)}`;
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
  const subdir = params.destSubdir ?? ".git-canonical";
  const clonePath = `/workspace/${workspaceId}/${subdir}`;
  const destPath = `${clonePath}/`;

  logger.info(
    { workspaceId, owner: ghParsed.owner, repo: ghParsed.repo, destPath },
    "Starting git clone",
  );

  await runGitClone(cloneUrl, destPath);

  const workspacePath = `/workspace/${workspaceId}`;
  logger.info({ workspaceId, workspacePath, clonePath }, "Clone completed successfully");
  return { workspacePath, clonePath };
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
  // D-3.5a (T-5) — nullable: an empty workspace (created with no repo) has no
  // primary repoUrl. Callers that only need the accountId (e.g. add_project)
  // tolerate null; the resume path treats null as "nothing to clone".
  repoUrl: string | null;
}

export async function fetchWorkspaceRepoUrl(
  params: FetchWorkspaceRepoUrlParams,
): Promise<DescribeWorkspaceResponse> {
  const { authServiceBaseUrl, hmacKey, workspaceId, logger } = params;
  const doFetch = params.fetchImpl ?? fetch;
  const bodyString = JSON.stringify({ workspaceId });
  const hmac = crypto.createHmac("sha256", hmacKey).update(bodyString).digest("hex");
  const url = `${authServiceBaseUrl.replace(/\/$/, "")}/api/auth-internal/describe-workspace`;

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
  if (typeof json.accountId !== "string") {
    throw new Error(`describe-workspace response missing accountId (got ${JSON.stringify(json)})`);
  }
  // repoUrl may be null/absent for an empty workspace (D-3.5a T-5).
  const repoUrl = typeof json.repoUrl === "string" ? json.repoUrl : null;
  return { accountId: json.accountId, repoUrl };
}
