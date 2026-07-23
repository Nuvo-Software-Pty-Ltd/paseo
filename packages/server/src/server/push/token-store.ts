import type pino from "pino";
import { existsSync, readFileSync } from "node:fs";

import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

/**
 * Persistence for the Expo push tokens registered by connected clients.
 *
 * Consumers depend on this interface. On-host the backing is
 * {@link FileBackedPushTokenStore} (a private JSON file under
 * `$PASEO_HOME`); in cloud mode the daemon injects `DynamoPushTokenStore`
 * instead, because `$PASEO_HOME` is tmpfs and is wiped on every ECS task
 * replacement — a file-backed store would silently drop every token on a
 * recycle, so turn-complete pushes stop until the app reconnects. See
 * `dynamo-token-store.ts`.
 */
export interface PushTokenStore {
  addToken(token: string): Promise<void>;
  removeToken(token: string): Promise<void>;
  getAllTokens(): Promise<string[]>;
}

/**
 * File-backed {@link PushTokenStore}. Tokens are persisted to a private
 * JSON file and reloaded in the constructor, so pushes survive a daemon
 * restart **on hosts with durable disk** (self-host / desktop). NOT
 * suitable for the cloud daemon's tmpfs `$PASEO_HOME` — cloud mode uses
 * `DynamoPushTokenStore`.
 */
export class FileBackedPushTokenStore implements PushTokenStore {
  private readonly logger: pino.Logger;
  private tokens: Set<string> = new Set();
  private readonly filePath: string;

  constructor(logger: pino.Logger, filePath: string) {
    this.logger = logger.child({ component: "token-store" });
    this.filePath = filePath;
    this.loadFromDisk();
  }

  async addToken(token: string): Promise<void> {
    const normalized = token.trim();
    if (!normalized) return;
    if (this.tokens.has(normalized)) return;
    this.tokens.add(normalized);
    this.persist();
    this.logger.debug({ total: this.tokens.size }, "Added token");
  }

  async removeToken(token: string): Promise<void> {
    const normalized = token.trim();
    if (!normalized) return;
    const deleted = this.tokens.delete(normalized);
    if (deleted) {
      this.persist();
      this.logger.debug({ total: this.tokens.size }, "Removed token");
    }
  }

  async getAllTokens(): Promise<string[]> {
    return Array.from(this.tokens);
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.filePath)) {
        return;
      }
      ensurePrivateFile(this.filePath);
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as { tokens?: unknown };
      const tokens = Array.isArray(parsed.tokens)
        ? parsed.tokens.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        : [];
      this.tokens = new Set(tokens.map((t) => t.trim()));
      this.logger.info({ total: this.tokens.size }, "Loaded push tokens");
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to load push tokens");
    }
  }

  private persist(): void {
    try {
      const payload = JSON.stringify({ tokens: Array.from(this.tokens) }, null, 2) + "\n";
      writePrivateFileAtomicSync(this.filePath, payload);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to persist push tokens");
    }
  }
}
