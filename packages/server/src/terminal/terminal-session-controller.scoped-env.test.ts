import pino from "pino";
import { describe, expect, test } from "vitest";

import type { CreateTerminalRequest, SessionOutboundMessage } from "../server/messages.js";
import type { TerminalManager } from "./terminal-manager.js";
import type { TerminalSession } from "./terminal.js";
import { TerminalSessionController } from "./terminal-session-controller.js";

// D-3.5c — proves the terminal injection site (Site B) resolves scoped env
// SERVER-SIDE from the create_terminal_request's cwd and forwards it to the
// TerminalManager, and that an unrelated project's cwd resolves a different
// (isolated) set. The request itself carries no env field — scope is never
// trusted off the wire.

function fakeSession(cwd: string): TerminalSession {
  return {
    id: `term_${cwd}`,
    name: "Terminal 1",
    cwd,
    getTitle: () => null,
    onExit: () => () => {},
  } as unknown as TerminalSession;
}

function buildController(resolveScopedEnv: (cwd: string) => Promise<Record<string, string>>) {
  const created: Array<{ cwd: string; env?: Record<string, string> }> = [];
  const terminalManager = {
    async createTerminal(options: { cwd: string; env?: Record<string, string> }) {
      created.push({ cwd: options.cwd, env: options.env });
      return fakeSession(options.cwd);
    },
    onTerminalsChanged: () => () => {},
  } as unknown as TerminalManager;

  const controller = new TerminalSessionController({
    terminalManager,
    emit: (_msg: SessionOutboundMessage) => {},
    emitBinary: () => {},
    hasBinaryChannel: () => false,
    isPathWithinRoot: () => true,
    sessionLogger: pino({ level: "silent" }),
    resolveScopedEnv,
  });
  return { controller, created };
}

function createTerminalRequest(cwd: string): CreateTerminalRequest {
  return {
    type: "create_terminal_request",
    cwd,
    requestId: `req_${cwd}`,
  } as CreateTerminalRequest;
}

describe("TerminalSessionController scoped env injection (Site B)", () => {
  test("resolves scoped env from cwd and forwards it to the TerminalManager", async () => {
    const envByCwd: Record<string, Record<string, string>> = {
      "/repos/one": { WS_VAR: "w", PROJ_VAR: "p" },
    };
    const { controller, created } = buildController(async (cwd) => envByCwd[cwd] ?? {});

    await controller.dispatch(createTerminalRequest("/repos/one"));

    expect(created).toHaveLength(1);
    expect(created[0]?.env).toEqual({ WS_VAR: "w", PROJ_VAR: "p" });
  });

  test("an unrelated project's terminal does not see the first project's var (isolation)", async () => {
    const envByCwd: Record<string, Record<string, string>> = {
      "/repos/a": { ONLY_A: "a" },
      "/repos/b": { ONLY_B: "b" },
    };
    const { controller, created } = buildController(async (cwd) => envByCwd[cwd] ?? {});

    await controller.dispatch(createTerminalRequest("/repos/a"));
    await controller.dispatch(createTerminalRequest("/repos/b"));

    expect(created[0]?.env).toEqual({ ONLY_A: "a" });
    expect(created[1]?.env).toEqual({ ONLY_B: "b" });
  });

  test("spawns without scoped env when the resolver throws (never blocks the terminal)", async () => {
    const { controller, created } = buildController(async () => {
      throw new Error("boom");
    });
    await controller.dispatch(createTerminalRequest("/repos/one"));
    expect(created).toHaveLength(1);
    expect(created[0]?.env).toBeUndefined();
  });
});
