import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { StoredLoopsSchema, type LoopRecord } from "./loop-types.js";

export interface LoopStore {
  loadAll(): Promise<LoopRecord[]>;
  save(records: LoopRecord[]): Promise<void>;
}

export class FileBackedLoopStore implements LoopStore {
  private readonly storePath: string;
  private readonly logger: Logger;

  constructor(options: { paseoHome: string; logger: Logger }) {
    this.storePath = path.join(options.paseoHome, "loops", "loops.json");
    this.logger = options.logger.child({ component: "loop-store" });
  }

  async loadAll(): Promise<LoopRecord[]> {
    try {
      const raw = await fs.readFile(this.storePath, "utf8");
      return StoredLoopsSchema.parse(JSON.parse(raw));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.error({ err: error, storePath: this.storePath }, "Failed to load loops");
      }
      return [];
    }
  }

  async save(records: LoopRecord[]): Promise<void> {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await fs.writeFile(this.storePath, JSON.stringify(records, null, 2), "utf8");
  }
}
