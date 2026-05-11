import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  GetSecretValueCommand,
  type GetSecretValueCommandOutput,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import type pino from "pino";
import { getCurrentWorkspaceAuth } from "./cloud-auth.js";

const CLAUDE_HOME_ROOT = "/tmp/orchestra-claude-home";

// Resolves the Secrets Manager id for a workspace's Anthropic credential.
// Mirrors `@orchestra/cloud-shared`'s `keys.workspaceAnthropicCredential()`
// path layout, duplicated by design to keep the open-core boundary clean.
function buildAnthropicCredentialSecretId(stage: string, workspaceId: string): string {
  return `orchestra/${stage}/workspace/${workspaceId}/anthropic-credential`;
}

function resolveStage(): string {
  const stage = process.env.ORCHESTRA_STAGE?.trim();
  return stage && stage.length > 0 ? stage : "dev";
}

let cachedClient: SecretsManagerClient | null = null;
function getSecretsManagerClient(): SecretsManagerClient {
  if (!cachedClient) {
    cachedClient = new SecretsManagerClient({});
  }
  return cachedClient;
}

// Minimal surface the credential fetch actually uses. Tests inject a fake;
// production wires in the real SecretsManagerClient.
export interface SecretsManagerLike {
  getSecretValue(secretId: string): Promise<GetSecretValueCommandOutput>;
}

function adaptSecretsManagerClient(client: SecretsManagerClient): SecretsManagerLike {
  return {
    async getSecretValue(secretId: string) {
      return client.send(new GetSecretValueCommand({ SecretId: secretId }));
    },
  };
}

export interface FetchAnthropicCredentialOptions {
  workspaceId: string;
  logger: pino.Logger;
  client?: SecretsManagerLike;
}

export async function fetchAnthropicCredential(
  options: FetchAnthropicCredentialOptions,
): Promise<string> {
  const stage = resolveStage();
  const secretId = buildAnthropicCredentialSecretId(stage, options.workspaceId);
  const client = options.client ?? adaptSecretsManagerClient(getSecretsManagerClient());
  let result: GetSecretValueCommandOutput;
  try {
    result = await client.getSecretValue(secretId);
  } catch (error) {
    options.logger.error(
      { err: error, workspaceId: options.workspaceId, secretId },
      "Failed to fetch Anthropic credential from Secrets Manager",
    );
    throw new Error(
      `Failed to fetch Anthropic credential for workspace ${options.workspaceId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  const secret = result.SecretString;
  if (!secret || secret.length === 0) {
    options.logger.error(
      { workspaceId: options.workspaceId, secretId },
      "Anthropic credential secret is empty",
    );
    throw new Error(
      `Anthropic credential for workspace ${options.workspaceId} is empty or missing`,
    );
  }
  return secret;
}

export interface MaterializedClaudeHome {
  spawnId: string;
  homeDir: string;
  configDir: string;
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}

// Writes a fresh per-spawn `~/.claude` directory containing the workspace's
// Anthropic credential. The Claude CLI reads `ANTHROPIC_API_KEY` from its
// environment and may also consult `<configDir>/config.json` — we set both
// to maximize compatibility across CLI revisions.
//
// Each spawn gets its own dir so:
//   1. Telemetry written by the CLI does not pollute across spawns.
//   2. Cleanup on session close is trivially `rm -rf <homeDir>`.
//   3. Concurrent spawns within the same workspace cannot accidentally share
//      a half-written config.
export async function materializeClaudeHome(params: {
  credential: string;
  logger: pino.Logger;
}): Promise<MaterializedClaudeHome> {
  const spawnId = randomBytes(8).toString("hex");
  const homeDir = path.join(CLAUDE_HOME_ROOT, spawnId);
  const configDir = path.join(homeDir, ".claude");
  await fs.mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.json");
  // Restrictive perms — the credential lives on disk only for the spawn
  // lifetime, but tightening visibility within the container is cheap.
  await fs.writeFile(configPath, JSON.stringify({ primaryApiKey: params.credential }), {
    encoding: "utf8",
    mode: 0o600,
  });

  const env: Record<string, string> = {
    HOME: homeDir,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_API_KEY: params.credential,
  };

  const cleanup = async (): Promise<void> => {
    try {
      await fs.rm(homeDir, { recursive: true, force: true });
    } catch (error) {
      params.logger.warn(
        { err: error, homeDir },
        "Failed to clean up Claude per-spawn home directory",
      );
    }
  };

  params.logger.info({ spawnId, homeDir }, "Materialized per-spawn Claude home for cloud mode");
  return { spawnId, homeDir, configDir, env, cleanup };
}

// Convenience wrapper: read the current workspace auth from
// AsyncLocalStorage, fetch the credential, and materialize the home dir.
// Throws (fail-loud) if no workspace context is in scope — cloud-mode spawns
// must originate from an authenticated WS message dispatch.
export async function provisionCloudClaudeHome(params: {
  logger: pino.Logger;
}): Promise<MaterializedClaudeHome> {
  const workspaceAuth = getCurrentWorkspaceAuth();
  if (!workspaceAuth) {
    throw new Error(
      "Cloud-mode Claude spawn requires a workspace auth context, but none is in scope. " +
        "This call did not originate from an authenticated WebSocket message dispatch — " +
        "scheduled/loop/background runs are not yet supported in cloud mode.",
    );
  }
  const credential = await fetchAnthropicCredential({
    workspaceId: workspaceAuth.workspaceId,
    logger: params.logger,
  });
  return materializeClaudeHome({ credential, logger: params.logger });
}
