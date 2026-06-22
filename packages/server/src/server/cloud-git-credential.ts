import { mkdir, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";

// Git credential helper plumbing for cloud mode. Clones use CLEAN (token-free)
// remotes; git then invokes this helper to obtain a FRESH token per operation,
// so a `git push` long after boot still authenticates with a refreshed token.
//
// SECURITY: the helper script + the loopback route are gated by a per-boot
// random NONCE, NOT the internal HMAC key. The nonce authorizes only "fetch the
// GitHub token" — already a user-intended exposure (ORCHESTRA_EXPOSE_GITHUB_TOKEN)
// — so a same-uid read of the script leaks nothing beyond the token itself. The
// internal HMAC key (which authorizes describe-workspace, clone-repo, etc.)
// stays in the daemon process and is never written where user code can read it.

export const CREDENTIAL_ROUTE_PATH = "/api/internal/git-credential";
export const CREDENTIAL_NONCE_HEADER = "X-Paseo-Cred-Nonce";

// git invokes the helper as `<helper> <get|store|erase>` and reads `key=value`
// lines from stdout. We only answer `get`; null token → empty output → git
// falls through (and fails visibly when a re-auth is required).
export function gitCredentialResponse(token: string | null): string {
  if (!token) return "";
  return `username=x-access-token\npassword=${token}\n`;
}

export function buildCredentialHelperScript(opts: { nonce: string; port: number }): string {
  return `#!/bin/sh
# Orchestra cloud git credential helper (managed — do not edit).
# git invokes: <helper> <get|store|erase>. Only \`get\` returns a credential.
# The nonce authorizes ONLY GitHub-token retrieval via the daemon loopback route
# (the daemon refreshes the token server-side); it is not the internal HMAC key.
[ "$1" = "get" ] || exit 0
curl -s -H "${CREDENTIAL_NONCE_HEADER}: ${opts.nonce}" "http://127.0.0.1:${opts.port}${CREDENTIAL_ROUTE_PATH}"
`;
}

export function buildDaemonGitConfig(opts: { helperPath: string }): string {
  // The empty `helper =` line resets any inherited credential helper so a stale
  // one can't answer first; ours is scoped to github.com over https only.
  return `# Managed by the Orchestra cloud daemon — do not edit.
[credential "https://github.com"]
\thelper =
\thelper = ${opts.helperPath}
`;
}

const HELPER_FILENAME = "git-credential-helper.sh";
const GITCONFIG_FILENAME = "gitconfig";

// Writes the helper script (0700) + the daemon gitconfig into `dir`. Never
// throws — a materialization failure must not block daemon boot (the env-var
// token channel still works for `gh`/toolchains; only raw-git refresh is lost).
export async function materializeGitCredentialHelper(opts: {
  dir: string;
  nonce: string;
  port: number;
  logger: Logger;
}): Promise<{ helperPath: string; gitConfigPath: string } | null> {
  const helperPath = path.join(opts.dir, HELPER_FILENAME);
  const gitConfigPath = path.join(opts.dir, GITCONFIG_FILENAME);
  try {
    await mkdir(opts.dir, { recursive: true });
    await writeFile(helperPath, buildCredentialHelperScript({ nonce: opts.nonce, port: opts.port }), {
      mode: 0o700,
    });
    await chmod(helperPath, 0o700);
    await writeFile(gitConfigPath, buildDaemonGitConfig({ helperPath }), { mode: 0o600 });
    return { helperPath, gitConfigPath };
  } catch (err) {
    opts.logger.warn({ err, dir: opts.dir }, "Failed to materialize git credential helper");
    return null;
  }
}
