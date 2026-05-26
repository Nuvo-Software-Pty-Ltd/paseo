import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";

// Anti-drift: the per-tenant MCP base URL must come from the daemon's
// `welcome.mcp` / agent-config payload (D-1.5 row 1 fix —
// paseo-cloud-daemon/LEARNINGS.md 2026-05-22). A literal `/mcp/agents/` URL
// in app src/ would bypass the per-workspace token binding the daemon-side
// fix added. See PLAN-app.md Task 10.

const APP_SRC = path.resolve(__dirname, "..");

// Files / patterns explicitly allowed to mention `/mcp/agents/`. The CI lint
// grows over time but the default is "no MCP URL hard-coded in app src".
const ALLOW_LIST: RegExp[] = [
  // Self-reference — the anti-drift guard itself describes the pattern.
  /no-hardcoded-mcp-url\.test\.ts/,
];

function gitGrepMcpUrl(): string[] {
  let stdout: string;
  try {
    // `grep -rnE` matches a slash-bounded /mcp/agents path. Limiting to .ts /
    // .tsx avoids hitting locked WS-protocol snippets in docs.
    stdout = execSync(`grep -rnE '/mcp/agents/' --include='*.ts' --include='*.tsx' ${APP_SRC}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err: unknown) {
    // grep returns exit 1 when nothing matches — that is the green path here.
    const exit = (err as { status?: number }).status;
    if (exit === 1) return [];
    throw err;
  }
  return stdout.trim().split("\n").filter(Boolean);
}

function isAllowListed(line: string): boolean {
  for (const pattern of ALLOW_LIST) {
    if (pattern.test(line)) return true;
  }
  return false;
}

describe("anti-drift: no hard-coded MCP URLs in app src/", () => {
  it("returns no matches outside the explicit allow-list", () => {
    const matches = gitGrepMcpUrl();
    const unexpected = matches.filter((line) => !isAllowListed(line));
    expect(unexpected).toEqual([]);
  });
});
