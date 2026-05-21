import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import type { Logger } from "pino";

const moduleRequire = createRequire(import.meta.url);
const execFileP = promisify(execFile);

// Daemon-version beacon. At boot, the daemon posts the versions it
// observes (Claude Code CLI on PATH + claude-agent-sdk in node_modules +
// the deployed image tag) to the auth service so operators can answer
// "what versions is this daemon running" without SSHing into the task.
//
// F3 design-out: the body is workspace-agnostic — no workspaceId on the
// wire. It reports daemon-instance state, not tenant data.
//
// Open-core boundary: the request body Zod schema lives auth-side in
// @orchestra/cloud-shared (DaemonVersionsBody, userString({maxLength: 64})).
// We do NOT import it here; the body shape below is duplicated by design.
// If auth-side fields change, mirror them here.

const UNKNOWN_VERSION = "unknown";
const MAX_VERSION_LEN = 64;

export interface DaemonVersionBeaconBody {
  cliVersion: string;
  sdkVersion: string;
  daemonImageTag: string;
}

export interface DaemonVersionBeaconResult {
  ok: boolean;
  status?: number;
}

export interface SendDaemonVersionBeaconParams {
  authServiceBaseUrl: string;
  hmacKey: string;
  daemonImageTag: string;
  logger: Logger;
  // Test seams.
  fetchImpl?: typeof fetch;
  resolveCliVersion?: () => Promise<string | null>;
  resolveSdkVersion?: () => string;
}

function clampVersion(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.length > MAX_VERSION_LEN ? trimmed.slice(0, MAX_VERSION_LEN) : trimmed;
}

export function readSdkVersion(): string {
  // The SDK's exports field blocks `require("…/package.json")`, so we
  // resolve the SDK's main entrypoint and read the sibling package.json
  // from disk instead.
  try {
    const mainPath = moduleRequire.resolve("@anthropic-ai/claude-agent-sdk");
    const pkgPath = path.join(path.dirname(mainPath), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // fall through — surface as "unknown" rather than failing the beacon.
  }
  return UNKNOWN_VERSION;
}

export async function readClaudeCliVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileP("claude", ["--version"], { timeout: 5_000 });
    const out = stdout.trim();
    if (!out) return null;
    const m = /(\d+\.\d+\.\d+)/.exec(out);
    return m ? m[1] : out.slice(0, MAX_VERSION_LEN);
  } catch {
    return null;
  }
}

export function resolveDaemonImageTag(): string {
  const value = process.env.PASEO_DAEMON_IMAGE_TAG?.trim();
  return value && value.length > 0 ? value : UNKNOWN_VERSION;
}

export async function sendDaemonVersionBeacon(
  params: SendDaemonVersionBeaconParams,
): Promise<DaemonVersionBeaconResult> {
  const { authServiceBaseUrl, hmacKey, daemonImageTag, logger } = params;
  const doFetch = params.fetchImpl ?? fetch;
  const readCli = params.resolveCliVersion ?? readClaudeCliVersion;
  const readSdk = params.resolveSdkVersion ?? readSdkVersion;

  const cliRaw = await readCli();
  const body: DaemonVersionBeaconBody = {
    cliVersion: clampVersion(cliRaw ?? UNKNOWN_VERSION, UNKNOWN_VERSION),
    sdkVersion: clampVersion(readSdk(), UNKNOWN_VERSION),
    daemonImageTag: clampVersion(daemonImageTag, UNKNOWN_VERSION),
  };

  const bodyString = JSON.stringify(body);
  const hmac = createHmac("sha256", hmacKey).update(bodyString).digest("hex");
  const url = `${authServiceBaseUrl.replace(/\/$/, "")}/api/internal/daemon-versions`;

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
    logger.warn({ err, url }, "daemon-version beacon network failure");
    return { ok: false };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    logger.warn(
      { status: response.status, responseBody: text },
      "daemon-version beacon returned non-2xx",
    );
    return { ok: false, status: response.status };
  }

  logger.info({ ...body }, "Daemon-version beacon delivered");
  return { ok: true, status: response.status };
}

// Fire-and-forget entry point invoked from bootstrap (after JWKS pre-warm).
// Gating on cloud-mode and on the presence of the auth service endpoint +
// HMAC key happens at the call site so the on-host bcrypt-Bearer daemon
// never reports versions to a non-existent receiver. Failure to deliver
// MUST NOT block daemon boot — log and move on.
export function fireDaemonVersionBeacon(opts: { logger: Logger }): void {
  const { logger } = opts;
  const authServiceBaseUrl = process.env.ORCHESTRA_AUTH_INTERNAL_URL;
  const hmacKey = process.env.ORCHESTRA_INTERNAL_HMAC_KEY;
  if (!authServiceBaseUrl || authServiceBaseUrl.trim().length === 0) {
    logger.warn("daemon-version beacon skipped: ORCHESTRA_AUTH_INTERNAL_URL not set");
    return;
  }
  if (!hmacKey || hmacKey.trim().length === 0) {
    logger.warn("daemon-version beacon skipped: ORCHESTRA_INTERNAL_HMAC_KEY not set");
    return;
  }
  void sendDaemonVersionBeacon({
    authServiceBaseUrl,
    hmacKey,
    daemonImageTag: resolveDaemonImageTag(),
    logger,
  }).catch((err) => {
    logger.warn({ err }, "daemon-version beacon failed unexpectedly");
  });
}
