import { computeProjectIdentity, ensureStateDir, memoryDbPath, type ProjectIdentity } from "./identity.js";
import { SqliteStore } from "./sqlite-store.js";
import { ProjectMemoriesRepo } from "./project-memory.js";
import { FeaturesRepo } from "./feature-memory.js";
import { EntitiesRepo } from "./entity-memory.js";
import { IssueMemoriesRepo } from "./issue-memory.js";
import { ResolutionsRepo } from "./resolution-memory.js";
import { FindingStore } from "./finding-store.js";

export interface OpenMemoryOptions {
  /** Override the sqlite location (tests). */
  dbPath?: string;
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

  private constructor(identity: ProjectIdentity, store: SqliteStore) {
    this.identity = identity;
    this.store = store;
    this.projectMemory = new ProjectMemoriesRepo(store, identity.projectId);
    this.features = new FeaturesRepo(store, identity.projectId);
    this.entities = new EntitiesRepo(store, identity.projectId);
    this.issues = new IssueMemoriesRepo(store, identity.projectId);
    this.resolutions = new ResolutionsRepo(store, identity.projectId);
    this.findings = new FindingStore(store, identity.projectId);
  }

  static async open(repoRoot: string, options: OpenMemoryOptions = {}): Promise<Memory> {
    const identity = await computeProjectIdentity(repoRoot);
    const dbPath =
      options.dbPath ??
      process.env.PIR_MEMORY_DB ??
      (ensureStateDir(identity.projectId), memoryDbPath(identity.projectId));
    const store = SqliteStore.open(dbPath);
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
      resolutions: this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM finding_resolutions")?.n ?? 0,
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
