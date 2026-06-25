import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { StoredScheduleSchema, type StoredSchedule } from "@getpaseo/protocol/schedule/types";
import { writeJsonFileAtomic } from "../atomic-file.js";

function generateScheduleId(): string {
  return randomBytes(4).toString("hex");
}

export interface ScheduleStore {
  list(): Promise<StoredSchedule[]>;
  get(id: string): Promise<StoredSchedule | null>;
  create(schedule: Omit<StoredSchedule, "id">): Promise<StoredSchedule>;
  put(schedule: StoredSchedule): Promise<void>;
  delete(id: string): Promise<void>;
}

export class FileBackedScheduleStore implements ScheduleStore {
  constructor(private readonly dir: string) {}

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async list(): Promise<StoredSchedule[]> {
    await this.ensureDir();
    const entries = await readdir(this.dir, { withFileTypes: true });
    const schedules = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const content = await readFile(join(this.dir, entry.name), "utf-8");
          return StoredScheduleSchema.parse(JSON.parse(content));
        }),
    );
    return schedules.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(id: string): Promise<StoredSchedule | null> {
    await this.ensureDir();
    try {
      const content = await readFile(this.filePath(id), "utf-8");
      return StoredScheduleSchema.parse(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async create(schedule: Omit<StoredSchedule, "id">): Promise<StoredSchedule> {
    // Re-parse through the schema so any `.default(null)` fields
    // (T-7 cloudOwner*) populate uniformly — without this, callers
    // that omit the new fields would receive an object that differs
    // from what list() returns after re-parsing from disk.
    const created = StoredScheduleSchema.parse({
      ...schedule,
      id: generateScheduleId(),
    });
    await this.put(created);
    return created;
  }

  async put(schedule: StoredSchedule): Promise<void> {
    await this.ensureDir();
    await writeJsonFileAtomic(this.filePath(schedule.id), schedule);
  }

  async delete(id: string): Promise<void> {
    await this.ensureDir();
    await rm(this.filePath(id), { force: true });
  }
}
