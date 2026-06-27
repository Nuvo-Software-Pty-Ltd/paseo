import { promises as fs } from "node:fs";

import type { Logger } from "pino";
import { z } from "zod";

import { writeJsonFileAtomic } from "./atomic-file.js";
import type { PersistedProjectKind, PersistedWorkspaceKind } from "./workspace-registry-model.js";

const PersistedProjectRecordSchema = z.object({
  projectId: z.string(),
  rootPath: z.string(),
  kind: z.enum(["git", "non_git"]),
  displayName: z.string(),
  // User-set override layered over the derived displayName. Reconciliation
  // never touches this. Null means "use the derived name". Added for #987.
  customName: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  // COMPAT(workspace-project-1n): added in v0.1.73, drop optionality when
  // floor >= v0.1.73 (target 2026-12). The 1:N refoundation gives every
  // Project a containment FK to its Workspace and credential-free repo
  // provenance. `.optional()` so old `projects.json` files (and old wire
  // payloads) without these fields still parse; the on-host lazy backfill
  // and cloud migration populate `workspaceId`.
  workspaceId: z.string().optional(),
  // repoUrl is ALWAYS a credential-free canonical URL
  // (`https://github.com/<org>/<repo>`) — see deriveCanonicalRepoUrl.
  // null for local-directory / non-git projects.
  repoUrl: z.string().nullable().optional(),
});

// D-3.5a NOTE — in the settled 1:N model (PLAN-3.5a-daemon § "Resulting
// data model" + DECISION D-1) this record is the demoted **Checkout**: a
// working directory WITHIN a Project. It keeps `cwd`/`projectId`/`kind`
// because every consumer (stale-detection, reconciliation, archive, git
// watch) operates on a concrete checkout directory. The top-level
// **Workspace (container)** — which sheds repo/cwd from its identity — is
// a DISTINCT entity (`WorkspaceContainerRecord`, below): D-1 explicitly
// demotes this record to "checkout", so doubling it as the cwd-less
// container would contradict D-1 and force every checkout consumer to
// tolerate cwd-less rows. Containment is carried by the Project's new
// `workspaceId` FK, not by reshaping this record.
const PersistedWorkspaceRecordSchema = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
  cwd: z.string(),
  kind: z.enum(["local_checkout", "worktree", "directory"]),
  displayName: z.string(),
  // User-set title layered over the derived displayName. In Model B the title is
  // the workspace identity; branch/directory are backing metadata. Reconciliation
  // never touches this. Null means "use the derived displayName".
  title: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  // The worktree's git branch. Decoupled from displayName/title by construction:
  // displayName holds the human name (title), branch holds the git branch. Only
  // worktree workspaces carry a branch; directory/local_checkout leave it null.
  branch: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  // The base branch the worktree was created from (normalized like worktree.json's
  // baseRefName). Only worktree workspaces carry a base branch; checkout-branch
  // worktrees and directory/local_checkout workspaces leave it null.
  baseBranch: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});

// D-3.5a — the top-level **Workspace** in the 1:N containment model: a
// container that holds zero or more Projects. It has NO repo and NO cwd in
// its identity (PLAN-3.5a § "Resulting data model" entity 1). On-host it is
// a generated `ws_<uuid>` (or the default `ws_local`); in cloud it is the
// ambient `PASEO_WORKSPACE_ID` whose source of truth is the proprietary
// `<ws>#metadata` row (not persisted by the daemon). Projects point at it
// via `PersistedProjectRecord.workspaceId`.
const WorkspaceContainerRecordSchema = z.object({
  workspaceId: z.string(),
  displayName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});

export type PersistedProjectRecord = z.infer<typeof PersistedProjectRecordSchema>;
export type PersistedWorkspaceRecord = z.infer<typeof PersistedWorkspaceRecordSchema>;
export type WorkspaceContainerRecord = z.infer<typeof WorkspaceContainerRecordSchema>;

// D-3.5a (DECISION D-2) — on-host the daemon auto-creates exactly one
// default container and attaches all derived projects to it, so existing
// self-host users see no regression (the projects list is unchanged, just
// nested under one container). Multi-container UX on-host is deferred
// (OQ-3). In cloud the container id is the ambient `PASEO_WORKSPACE_ID`.
export const DEFAULT_CONTAINER_WORKSPACE_ID = "ws_local";

export interface ProjectRegistry {
  initialize(): Promise<void>;
  existsOnDisk(): Promise<boolean>;
  list(): Promise<PersistedProjectRecord[]>;
  get(projectId: string): Promise<PersistedProjectRecord | null>;
  upsert(record: PersistedProjectRecord): Promise<void>;
  archive(projectId: string, archivedAt: string): Promise<void>;
  remove(projectId: string): Promise<void>;
}

export interface WorkspaceRegistry {
  initialize(): Promise<void>;
  existsOnDisk(): Promise<boolean>;
  list(): Promise<PersistedWorkspaceRecord[]>;
  get(workspaceId: string): Promise<PersistedWorkspaceRecord | null>;
  upsert(record: PersistedWorkspaceRecord): Promise<void>;
  archive(workspaceId: string, archivedAt: string): Promise<void>;
  unarchive(workspaceId: string, updatedAt: string): Promise<void>;
  remove(workspaceId: string): Promise<void>;
}

// D-3.5a — registry of top-level Workspace containers (1:N parents of
// Projects). Same CRUD surface as the other registries.
export interface WorkspaceContainerRegistry {
  initialize(): Promise<void>;
  existsOnDisk(): Promise<boolean>;
  list(): Promise<WorkspaceContainerRecord[]>;
  get(workspaceId: string): Promise<WorkspaceContainerRecord | null>;
  upsert(record: WorkspaceContainerRecord): Promise<void>;
  archive(workspaceId: string, archivedAt: string): Promise<void>;
  remove(workspaceId: string): Promise<void>;
}

type RegistryRecord = PersistedProjectRecord | PersistedWorkspaceRecord | WorkspaceContainerRecord;

class FileBackedRegistry<TRecord extends RegistryRecord> {
  private readonly filePath: string;
  private readonly logger: Logger;
  private readonly schema: z.ZodType<TRecord, unknown>;
  private readonly getId: (record: TRecord) => string;
  private loaded = false;
  private readonly cache = new Map<string, TRecord>();
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(options: {
    filePath: string;
    logger: Logger;
    schema: z.ZodType<TRecord, unknown>;
    getId: (record: TRecord) => string;
    component: string;
  }) {
    this.filePath = options.filePath;
    this.schema = options.schema;
    this.getId = options.getId;
    this.logger = options.logger.child({
      module: "workspace-registry",
      component: options.component,
    });
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  async existsOnDisk(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<TRecord[]> {
    await this.load();
    return Array.from(this.cache.values());
  }

  async get(id: string): Promise<TRecord | null> {
    await this.load();
    return this.cache.get(id) ?? null;
  }

  async upsert(record: TRecord): Promise<void> {
    await this.load();
    const parsed = this.schema.parse(record);
    this.cache.set(this.getId(parsed), parsed);
    await this.enqueuePersist();
  }

  async archive(id: string, archivedAt: string): Promise<void> {
    await this.load();
    const existing = this.cache.get(id);
    if (!existing) {
      return;
    }
    const next = this.schema.parse({
      ...existing,
      updatedAt: archivedAt,
      archivedAt,
    });
    this.cache.set(id, next);
    await this.enqueuePersist();
  }

  async unarchive(id: string, updatedAt: string): Promise<void> {
    await this.load();
    const existing = this.cache.get(id);
    if (!existing) {
      return;
    }
    const next = this.schema.parse({
      ...existing,
      updatedAt,
      archivedAt: null,
    });
    this.cache.set(id, next);
    await this.enqueuePersist();
  }

  async remove(id: string): Promise<void> {
    await this.load();
    if (!this.cache.delete(id)) {
      return;
    }
    await this.enqueuePersist();
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.cache.clear();
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = z.array(this.schema).parse(JSON.parse(raw));
      for (const record of parsed) {
        this.cache.set(this.getId(record), record);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.error({ err: error, filePath: this.filePath }, "Failed to load registry file");
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const records = Array.from(this.cache.values());
    await writeJsonFileAtomic(this.filePath, records);
  }

  private async enqueuePersist(): Promise<void> {
    const nextPersist = this.persistQueue.then(() => this.persist());
    this.persistQueue = nextPersist.catch(() => {});
    await nextPersist;
  }
}

export class FileBackedProjectRegistry
  extends FileBackedRegistry<PersistedProjectRecord>
  implements ProjectRegistry
{
  constructor(filePath: string, logger: Logger) {
    super({
      filePath,
      logger,
      schema: PersistedProjectRecordSchema,
      getId: (record) => record.projectId,
      component: "projects",
    });
  }
}

export class FileBackedWorkspaceRegistry
  extends FileBackedRegistry<PersistedWorkspaceRecord>
  implements WorkspaceRegistry
{
  constructor(filePath: string, logger: Logger) {
    super({
      filePath,
      logger,
      schema: PersistedWorkspaceRecordSchema,
      getId: (record) => record.workspaceId,
      component: "workspaces",
    });
  }
}

export class FileBackedWorkspaceContainerRegistry
  extends FileBackedRegistry<WorkspaceContainerRecord>
  implements WorkspaceContainerRegistry
{
  constructor(filePath: string, logger: Logger) {
    super({
      filePath,
      logger,
      schema: WorkspaceContainerRecordSchema,
      getId: (record) => record.workspaceId,
      component: "workspace-containers",
    });
  }
}

// D-3.5a — cloud-mode container registry. As with `InMemoryWorkspaceRegistry`
// the containers are a derived cache: in cloud the single ambient container
// is `PASEO_WORKSPACE_ID` whose authoritative record is the proprietary
// `<ws>#metadata` row. The daemon mirrors it in memory so create/list reads
// are read-your-writes within a session; `existsOnDisk()` → false keeps the
// seed running on every container start.
export class InMemoryWorkspaceContainerRegistry implements WorkspaceContainerRegistry {
  private readonly cache = new Map<string, WorkspaceContainerRecord>();

  async initialize(): Promise<void> {}

  async existsOnDisk(): Promise<boolean> {
    return false;
  }

  async list(): Promise<WorkspaceContainerRecord[]> {
    return Array.from(this.cache.values());
  }

  async get(workspaceId: string): Promise<WorkspaceContainerRecord | null> {
    return this.cache.get(workspaceId) ?? null;
  }

  async upsert(record: WorkspaceContainerRecord): Promise<void> {
    const parsed = WorkspaceContainerRecordSchema.parse(record);
    this.cache.set(parsed.workspaceId, parsed);
  }

  async archive(workspaceId: string, archivedAt: string): Promise<void> {
    const existing = this.cache.get(workspaceId);
    if (!existing) return;
    this.cache.set(
      workspaceId,
      WorkspaceContainerRecordSchema.parse({
        ...existing,
        updatedAt: archivedAt,
        archivedAt,
      }),
    );
  }

  async remove(workspaceId: string): Promise<void> {
    this.cache.delete(workspaceId);
  }
}

// D-3.12 follow-up — cloud-mode workspace registry. The workspace
// registry is a derived cache rebuilt from agent storage on every boot
// via `bootstrapWorkspaceRegistries`. In cloud mode (single workspace
// per ECS task, pinned by PASEO_WORKSPACE_ID) there is no need for
// DynamoDB-backed persistence — the in-memory variant provides
// read-your-writes within a session and `existsOnDisk() → false`
// ensures reconstruction runs on every container start.
export class InMemoryWorkspaceRegistry implements WorkspaceRegistry {
  private readonly cache = new Map<string, PersistedWorkspaceRecord>();

  async initialize(): Promise<void> {}

  async existsOnDisk(): Promise<boolean> {
    return false;
  }

  async list(): Promise<PersistedWorkspaceRecord[]> {
    return Array.from(this.cache.values());
  }

  async get(workspaceId: string): Promise<PersistedWorkspaceRecord | null> {
    return this.cache.get(workspaceId) ?? null;
  }

  async upsert(record: PersistedWorkspaceRecord): Promise<void> {
    const parsed = PersistedWorkspaceRecordSchema.parse(record);
    this.cache.set(parsed.workspaceId, parsed);
  }

  async archive(workspaceId: string, archivedAt: string): Promise<void> {
    const existing = this.cache.get(workspaceId);
    if (!existing) return;
    this.cache.set(
      workspaceId,
      PersistedWorkspaceRecordSchema.parse({
        ...existing,
        updatedAt: archivedAt,
        archivedAt,
      }),
    );
  }

  async unarchive(workspaceId: string, updatedAt: string): Promise<void> {
    const existing = this.cache.get(workspaceId);
    if (!existing) return;
    this.cache.set(
      workspaceId,
      PersistedWorkspaceRecordSchema.parse({
        ...existing,
        updatedAt,
        archivedAt: null,
      }),
    );
  }

  async remove(workspaceId: string): Promise<void> {
    this.cache.delete(workspaceId);
  }
}

export function createPersistedProjectRecord(input: {
  projectId: string;
  rootPath: string;
  kind: PersistedProjectKind;
  displayName: string;
  customName?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  // D-3.5a — containment FK + credential-free repo provenance. Optional so
  // existing callers that don't yet thread them keep compiling; the
  // bootstrap/migration and add_project paths populate them.
  workspaceId?: string;
  repoUrl?: string | null;
}): PersistedProjectRecord {
  return PersistedProjectRecordSchema.parse({
    ...input,
    customName: input.customName ?? null,
    archivedAt: input.archivedAt ?? null,
  });
}

export function createWorkspaceContainerRecord(input: {
  workspaceId: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}): WorkspaceContainerRecord {
  return WorkspaceContainerRecordSchema.parse({
    ...input,
    archivedAt: input.archivedAt ?? null,
  });
}

export function resolveProjectDisplayName(record: PersistedProjectRecord): string {
  return record.customName ?? record.displayName;
}

export function createPersistedWorkspaceRecord(input: {
  workspaceId: string;
  projectId: string;
  cwd: string;
  kind: PersistedWorkspaceKind;
  displayName: string;
  title?: string | null;
  branch?: string | null;
  baseBranch?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}): PersistedWorkspaceRecord {
  return PersistedWorkspaceRecordSchema.parse({
    ...input,
    title: input.title ?? null,
    branch: input.branch ?? null,
    baseBranch: input.baseBranch ?? null,
    archivedAt: input.archivedAt ?? null,
  });
}

// The single workspace-name rule: the title always wins; otherwise fall back to
// the freshest available derived display name (a live branch snapshot when the
// caller has one, the persisted displayName otherwise).
export function resolveWorkspaceName(input: {
  title: string | null;
  derivedDisplayName: string;
}): string {
  return input.title ?? input.derivedDisplayName;
}

export function resolveWorkspaceDisplayName(record: PersistedWorkspaceRecord): string {
  return resolveWorkspaceName({ title: record.title, derivedDisplayName: record.displayName });
}
