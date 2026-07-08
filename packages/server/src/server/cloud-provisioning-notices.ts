import type { Logger } from "pino";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isPaseoCloudMode } from "./paseo-env.js";
import { getGithubTokenProvider } from "./cloud-github-token.js";

// Cloud workspaces run on ephemeral tmpfs, so credentials, the BYO-runtimes
// toolchain, and MCP runtimes are re-provisioned on every recycle. When a piece
// of that provisioning is missing, the daemon degrades SILENTLY today (empty env
// overlays, best-effort dir creation) and the agent comes back "healthy but
// bare". This module turns those silent-degradation states into a single
// user-visible transcript notice so the workspace SAYS what's wrong instead of
// mysteriously lacking git/tools. Emitted best-effort at spawn — it must never
// block or fail a turn.

export const GITHUB_REAUTH_NOTICE =
  "⚠️ Orchestra can't provide a GitHub token in this workspace right now — your " +
  "GitHub sign-in needs to be renewed. Re-authenticate with GitHub in Orchestra " +
  "to restore `git` and `gh` access.";

export const TOOLCHAIN_MISSING_NOTICE =
  "⚠️ Your workspace toolchain isn't installed in this session. Workspace storage " +
  "is ephemeral and was reset on the last restart — re-run your setup to reinstall " +
  "runtimes (e.g. Node/uv), or ask about per-repo custom images for a durable toolchain.";

export interface ProvisioningNoticeDeps {
  // The resolved spawn env (sdkEnv) — used to suppress the GitHub notice when a
  // token is present anyway (e.g. a user-set scoped GITHUB_TOKEN).
  env: NodeJS.ProcessEnv;
  logger: Logger;
  // Test seams. Production resolves both from the live cloud singletons/fs.
  getToken?: () => Promise<{ token: string | null; needsReauth: boolean }>;
  toolchainBinPopulated?: (prefix: string) => Promise<boolean>;
}

// Decide which degraded-provisioning notices to surface for this spawn. Returns
// [] outside cloud mode or when everything the deployment configured is present.
// Never throws — each check is independently guarded so one failure can't hide
// the others or break the spawn.
export async function resolveCloudProvisioningNotices(
  deps: ProvisioningNoticeDeps,
): Promise<string[]> {
  if (!isPaseoCloudMode()) return [];
  const notices: string[] = [];

  // 2a — GitHub token needs re-auth. Only relevant when token exposure is
  // configured on for this deployment. `needsReauth` is the auth service's
  // "the refresh chain is broken, the user must re-run OAuth" latch; a plain
  // transient outage (token null but !needsReauth) is NOT surfaced — it
  // self-heals. Suppressed if a token is present in the env regardless (a
  // user-set scoped GITHUB_TOKEN wins and needs no notice).
  if (process.env.ORCHESTRA_EXPOSE_GITHUB_TOKEN?.trim() === "1" && !deps.env.GITHUB_TOKEN) {
    try {
      const { needsReauth } = await resolveGetToken(deps)();
      if (needsReauth) notices.push(GITHUB_REAUTH_NOTICE);
    } catch (err) {
      deps.logger.warn({ err }, "provisioning-notices: github token check failed");
    }
  }

  // 2b — BYO-runtimes toolchain wiped by a recycle. Only checked when the
  // deployment set PASEO_TOOLCHAIN_PREFIX (cloud); its bin dir being empty means
  // the ephemeral toolchain surface was reset and nothing reinstalled it.
  const prefix = process.env.PASEO_TOOLCHAIN_PREFIX?.trim();
  if (prefix) {
    try {
      const check = deps.toolchainBinPopulated ?? defaultToolchainBinPopulated;
      if (!(await check(prefix))) notices.push(TOOLCHAIN_MISSING_NOTICE);
    } catch (err) {
      deps.logger.warn({ err }, "provisioning-notices: toolchain check failed");
    }
  }

  return notices;
}

function resolveGetToken(
  deps: ProvisioningNoticeDeps,
): () => Promise<{ token: string | null; needsReauth: boolean }> {
  if (deps.getToken) return deps.getToken;
  return async () => {
    const provider = getGithubTokenProvider(deps.logger);
    return provider ? provider.getToken() : { token: null, needsReauth: false };
  };
}

// A toolchain is "populated" when its `<prefix>/bin` directory has at least one
// entry. A missing/unreadable dir counts as not populated (the recycle wiped it).
async function defaultToolchainBinPopulated(prefix: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(path.join(prefix, "bin"));
    return entries.length > 0;
  } catch {
    return false;
  }
}
