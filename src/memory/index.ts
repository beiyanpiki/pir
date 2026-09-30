import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { computeProjectIdentity, ensureStateDir, memoryDbPath, projectStateDir, type ProjectIdentity } from "./identity.js";
import { MIGRATIONS } from "./migrations.js";
import { SqliteStore } from "./sqlite-store.js";
import { ProjectMemoriesRepo } from "./project-memory.js";
import { FeaturesRepo } from "./feature-memory.js";
import { EntitiesRepo } from "./entity-memory.js";
import { IssueMemoriesRepo } from "./issue-memory.js";
import { ResolutionsRepo } from "./resolution-memory.js";
import { FindingStore } from "./finding-store.js";
import { AuditStore } from "./audit-store.js";

/**
 * Centralized state layout for server-side flows: PIR_STATE_ROOT/<projectId>/
 * when PIR_STATE_ROOT is set, otherwise the per-project XDG default.
 */
export function stateRootDbPath(projectId: string): string {
  const root = process.env.PIR_STATE_ROOT;
  if (root) {
    const dir = path.join(root, projectId);
    mkdirSync(dir, { recursive: true });
    return path.join(dir, "memory.sqlite");
  }
  ensureStateDir(projectId);
  return memoryDbPath(projectId);
}

export interface OpenMemoryOptions {
  /** Override the sqlite location (tests). */
  dbPath?: string;
  /**
   * Open as a WAL reader: no migrations, no projects-row insert — nothing
   * that takes the write lock, so the caller may run while the review flow
   * holds single-writer access. The db file must already exist; callers
   * fall back to a creating open on first contact.
   */
  readOnly?: boolean;
}

/**
 * Resolve the sqlite path Memory.open would use for <repoRoot>, without
 * opening the db. Lets callers check for first contact (file missing) and
 * route to a creating open before committing to a read-only one.
 */
async function memoryDbPathFor(repoRoot: string, options: Pick<OpenMemoryOptions, "dbPath"> = {}): Promise<string> {
  const identity = await computeProjectIdentity(repoRoot);
  return resolveMemoryDbPath(repoRoot, identity, options);
}

/**
 * True when Memory.open(<repoRoot>, {readOnly: true}) will serve reads:
 * the db file exists and carries every migration. A missing db (first
 * contact) or a stale one (written by an older pir) must go through a
 * normal creating open instead, which is the caller's queue to arrange.
 */
export async function memoryDbReadyForRead(
  repoRoot: string,
  options: Pick<OpenMemoryOptions, "dbPath"> = {},
): Promise<boolean> {
  let dbPath: string;
  try {
    dbPath = await memoryDbPathFor(repoRoot, options);
  } catch {
    return false; // identity/git problems: let the normal open report them
  }
  if (!existsSync(dbPath)) return false;
  const store = SqliteStore.open(dbPath, { readOnly: true });
  try {
    const row = store.get<{ v: number | null }>("SELECT MAX(version) AS v FROM _migrations");
    const latest = MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0);
    return (row?.v ?? -1) >= latest;
  } catch {
    return false; // no _migrations table (zero-length file, foreign db): not readable
  } finally {
    store.close();
  }
}

function resolveMemoryDbPath(
  repoRoot: string,
  identity: ProjectIdentity,
  options: Pick<OpenMemoryOptions, "dbPath">,
): string {
  // Resolution order: explicit path (tests / worktree flows) >
  // PIR_MEMORY_DB (single db override) > PIR_STATE_IN_PROJECT (Docker exec
  // mode: everything under <repo>/.pir/) > PIR_STATE_ROOT (server mode:
  // centralized <root>/<projectId>/) > per-project XDG state dir.
  return (
    options.dbPath ??
    process.env.PIR_MEMORY_DB ??
    (process.env.PIR_STATE_IN_PROJECT === "1"
      ? (mkdirSync(path.join(repoRoot, ".pir"), { recursive: true }),
        path.join(repoRoot, ".pir", "memory.sqlite"))
      : stateRootDbPath(identity.projectId))
  );
}

/**
 * Facade over the per-project Repository Memory database. Everything the
 * review engine persists flows through here.
 */
export class Memory {
  readonly identity: ProjectIdentity;
  readonly store: SqliteStore;
  readonly projectMemory: ProjectMemoriesRepo;
  readonly features: FeaturesRepo;
  readonly entities: EntitiesRepo;
  readonly issues: IssueMemoriesRepo;
  readonly resolutions: ResolutionsRepo;
  readonly findings: FindingStore;
  /** Run-local audit artifacts (work units, file coverage); never synced. */
  readonly audit: AuditStore;

  private constructor(identity: ProjectIdentity, store: SqliteStore) {
    this.identity = identity;
    this.store = store;
    this.projectMemory = new ProjectMemoriesRepo(store, identity.projectId);
    this.features = new FeaturesRepo(store, identity.projectId);
    this.entities = new EntitiesRepo(store, identity.projectId);
    this.issues = new IssueMemoriesRepo(store, identity.projectId);
    this.resolutions = new ResolutionsRepo(store, identity.projectId);
    this.findings = new FindingStore(store, identity.projectId);
    this.audit = new AuditStore(store, identity.projectId);
  }

  static async open(repoRoot: string, options: OpenMemoryOptions = {}): Promise<Memory> {
    const identity = await computeProjectIdentity(repoRoot);
    const dbPath = resolveMemoryDbPath(repoRoot, identity, options);
    if (options.readOnly && !existsSync(dbPath)) {
      throw new Error(`memory db does not exist yet: ${dbPath} (open it read-write once to create it)`);
    }
    const store = SqliteStore.open(dbPath, { readOnly: options.readOnly });
    if (options.readOnly) return new Memory(identity, store);
    store.run(
      `INSERT INTO projects (id, remote, normalized_remote, root_commit, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      identity.projectId,
      identity.remote,
      identity.normalizedRemote,
      identity.rootCommit,
      Date.now(),
    );
    return new Memory(identity, store);
  }

  getLastIndexedCommit(): string | null {
    const row = this.store.get<{ last_indexed_commit: string | null }>(
      "SELECT last_indexed_commit FROM projects WHERE id = ?",
      this.identity.projectId,
    );
    return row?.last_indexed_commit ?? null;
  }

  setLastIndexedCommit(commit: string): void {
    this.store.run("UPDATE projects SET last_indexed_commit = ? WHERE id = ?", commit, this.identity.projectId);
  }

  stats(): {
    features: number;
    entities: number;
    issueMemories: number;
    resolutions: number;
    findings: number;
    staleEntities: number;
    lastIndexedCommit: string | null;
    dbPath: string;
  } {
    const count = (table: string, where = ""): number => {
      const row = this.store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ? ${where}`, this.identity.projectId);
      return row?.n ?? 0;
    };
    return {
      features: count("features"),
      entities: count("code_entities"),
      issueMemories: count("issue_memories"),
      resolutions: count("finding_resolutions"),
      findings: count("findings"),
      staleEntities: count("code_entities", "AND stale = 1"),
      lastIndexedCommit: this.getLastIndexedCommit(),
      dbPath: this.store.dbPath,
    };
  }

  close(): void {
    this.store.close();
  }
}
