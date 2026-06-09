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

// Credential resolution order (D-3.5b — per-user credential persistence):
//   1. ACCOUNT path  `orchestra/<stage>/account/<accountId>/anthropic-credential`
//      — the credential is per-account (Decision #2), set once on a settings
//      page and inherited by every workspace the account owns. This is the
//      durable, set-once-never-re-entered-on-resume path.
//   2. WORKSPACE path `orchestra/<stage>/workspace/<workspaceId>/anthropic-credential`
//      — the pre-3.5b per-workspace credential, retained only as a READ
//      fallback for workspaces created before migration. Tagged
//      COMPAT(per-user-credential); remove once the cloud-side migration has
//      copied every per-workspace secret to its account and the app has
//      stopped writing the per-workspace path (target 2026-12). The retirement
//      trigger is observable: zero `cloud_credential_fallback` log lines over
//      the agreed window (VERIFY-3.5b O-4).
//
// Identity (`accountId`/`workspaceId`) is always sourced from
// `getCurrentWorkspaceAuth()` (the validated JWT propagated via
// AsyncLocalStorage) — never from a caller parameter (F3 design-out). The IAM
// ceiling (account-scoped Secrets Manager grant, owned by the cloud stream) is
// the real cross-account boundary; this module is the defense-in-depth reader.

// Resolves the Secrets Manager id for a workspace's Anthropic credential.
// Mirrors `@orchestra/cloud-shared`'s `keys.workspaceAnthropicCredential()`
// path layout, duplicated by design to keep the open-core boundary clean.
// COMPAT(per-user-credential): per-workspace secret path retained for the
// migration window only; remove with the workspace fallback (target 2026-12).
function buildAnthropicCredentialSecretId(stage: string, workspaceId: string): string {
  return `orchestra/${stage}/workspace/${workspaceId}/anthropic-credential`;
}

// Resolves the Secrets Manager id for an ACCOUNT's Anthropic credential.
// Mirrors `@orchestra/cloud-shared`'s `keys.accountAnthropicCredential()`
// (duplicated by design, same open-core boundary as the per-workspace mirror).
// COMPAT(per-user-credential): account secret path mirrors
// @orchestra/cloud-shared/keys.accountAnthropicCredential as of v0.1.73; the
// per-workspace path beside it is retained for migration only (target 2026-12).
function buildAccountAnthropicCredentialSecretId(stage: string, accountId: string): string {
  return `orchestra/${stage}/account/${accountId}/anthropic-credential`;
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

export interface FetchAnthropicCredentialForAccountOptions {
  accountId: string;
  logger: pino.Logger;
  client?: SecretsManagerLike;
}

// Reads the ACCOUNT-scoped Anthropic credential. Unlike the per-workspace
// fetch (which fails loud — a workspace with no resolvable credential is a hard
// error), this returns `null` when the account credential is simply not
// resolvable, so the spawn site can fall back to the per-workspace path during
// the migration window. The not-resolvable cases are:
//   - ResourceNotFoundException — steady-state "account has no credential yet"
//     (first-run before the user sets one, or a not-yet-migrated workspace).
//   - AccessDeniedException — the migration window before the account-scoped
//     IAM grant lands (cloud stream T-5); existing workspaces must keep working.
//   - empty SecretString — defensive.
// Every not-resolvable branch logs at WARN so the fallback is observable in the
// daemon log (no quiet degrade) — the operator/migration audit greps for these.
export async function fetchAnthropicCredentialForAccount(
  options: FetchAnthropicCredentialForAccountOptions,
): Promise<string | null> {
  const stage = resolveStage();
  const secretId = buildAccountAnthropicCredentialSecretId(stage, options.accountId);
  const client = options.client ?? adaptSecretsManagerClient(getSecretsManagerClient());
  let result: GetSecretValueCommandOutput;
  try {
    result = await client.getSecretValue(secretId);
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "";
    options.logger.warn(
      { err: error, accountId: options.accountId, secretId, errorName },
      "Account Anthropic credential not resolvable; falling back to per-workspace path",
    );
    return null;
  }
  const secret = result.SecretString;
  if (!secret || secret.length === 0) {
    options.logger.warn(
      { accountId: options.accountId, secretId },
      "Account Anthropic credential secret is empty; falling back to per-workspace path",
    );
    return null;
  }
  return secret;
}

// Day-N seam: the credential bytes are a bare string today (so the
// `startsWith("sk-ant-oat")` parse in materializeClaudeHome is unchanged), but
// the locked decision requires the store to EXTEND into Day-N model controls
// (Bedrock vs Anthropic, data sovereignty) rather than be replaced. This
// resolver is the single branch point: today it hard-returns "anthropic".
//
// M2 (VERIFY-3.5b, binding): the daemon MUST NOT read the account-keyed
// `<accountId>#provider-config` DynamoDB row to make this decision — the
// per-workspace daemon role's DynamoDB IAM is LeadingKeys-scoped to its own
// workspace partitions, so an account-keyed GetItem would be IAM-denied. The
// provider-config row is read/written by the cloud/auth layer only; the daemon
// hard-defaults. When Day-N Bedrock work begins, the provider selection must
// arrive via a path the daemon role is actually granted (e.g. a claim on the
// workspace JWT, or a new account-scoped grant the cloud stream adds) — not by
// reaching into the account-keyed row from here.
export type AccountProviderSelection = "anthropic";

export function resolveAccountProviderSelection(_params: {
  accountId: string;
  logger: pino.Logger;
}): AccountProviderSelection {
  return "anthropic";
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
  const isOAuth = params.credential.startsWith("sk-ant-oat");
  await fs.mkdir(configDir, { recursive: true });

  // Restrictive perms — the credential lives on disk only for the spawn
  // lifetime, but tightening visibility within the container is cheap.
  let env: Record<string, string>;
  if (isOAuth) {
    await fs.writeFile(
      path.join(configDir, ".credentials.json"),
      JSON.stringify({ oauthToken: params.credential }),
      { encoding: "utf8", mode: 0o600 },
    );
    env = {
      HOME: homeDir,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_OAUTH_TOKEN: params.credential,
    };
  } else {
    await fs.writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ primaryApiKey: params.credential }),
      { encoding: "utf8", mode: 0o600 },
    );
    env = {
      HOME: homeDir,
      CLAUDE_CONFIG_DIR: configDir,
      ANTHROPIC_API_KEY: params.credential,
    };
  }

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

  params.logger.info(
    { spawnId, homeDir, credentialKind: isOAuth ? "oauth" : "api_key" },
    "Materialized per-spawn Claude home for cloud mode",
  );
  return { spawnId, homeDir, configDir, env, cleanup };
}

// Convenience wrapper: read the current workspace auth from
// AsyncLocalStorage, resolve the credential (account-first, per-workspace
// fallback), and materialize the home dir. Throws (fail-loud) if no workspace
// context is in scope — cloud-mode spawns must originate from an authenticated
// WS message dispatch.
//
// F3: takes NO caller-supplied workspaceId/accountId — identity comes only from
// `getCurrentWorkspaceAuth()`. The optional `client` is a test seam (matching
// `fetchAnthropicCredential`'s); production omits it.
export async function provisionCloudClaudeHome(params: {
  logger: pino.Logger;
  client?: SecretsManagerLike;
}): Promise<MaterializedClaudeHome> {
  const workspaceAuth = getCurrentWorkspaceAuth();
  if (!workspaceAuth) {
    throw new Error(
      "Cloud-mode Claude spawn requires a workspace auth context, but none is in scope. " +
        "This call did not originate from an authenticated WebSocket message dispatch — " +
        "scheduled/loop/background runs are not yet supported in cloud mode.",
    );
  }
  const { accountId, workspaceId } = workspaceAuth;

  // Day-N seam: resolve the account's provider selection. Anthropic-only today;
  // the branch point for Bedrock/data-sovereignty lives in this resolver. (M2:
  // the daemon does not read the account provider-config DDB row.)
  resolveAccountProviderSelection({ accountId, logger: params.logger });

  // Account-first: the credential is per-account, inherited by every workspace.
  const accountCredential = await fetchAnthropicCredentialForAccount({
    accountId,
    logger: params.logger,
    client: params.client,
  });
  if (accountCredential) {
    return materializeClaudeHome({ credential: accountCredential, logger: params.logger });
  }

  // COMPAT(per-user-credential): per-workspace fallback for workspaces created
  // before migration. Logged (not silent) so the migration audit can confirm
  // the fallback has gone quiet before this branch is deleted (target 2026-12).
  params.logger.info(
    { accountId, workspaceId, reason: "account-credential-absent" },
    "cloud_credential_fallback",
  );
  let workspaceCredential: string;
  try {
    workspaceCredential = await fetchAnthropicCredential({
      workspaceId,
      logger: params.logger,
      client: params.client,
    });
  } catch (error) {
    // Neither path resolved — fail loud naming BOTH so an operator sees the
    // account path was tried first and the workspace fallback also failed.
    throw new Error(
      `Cloud-mode Claude spawn could not resolve an Anthropic credential: no account ` +
        `credential for account ${accountId}, and the per-workspace fallback for ` +
        `workspace ${workspaceId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      { cause: error },
    );
  }
  return materializeClaudeHome({ credential: workspaceCredential, logger: params.logger });
}
