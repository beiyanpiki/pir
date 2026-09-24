import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations.js";

/**
 * Thin wrapper around node:sqlite DatabaseSync: WAL mode, ordered migrations
 * tracked in _migrations, and a transaction helper. No external dependencies.
 */
export class SqliteStore {
  private constructor(
    readonly db: DatabaseSync,
    readonly dbPath: string,
  ) {}

  static open(dbPath: string): SqliteStore {
    const dir = path.dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    const store = new SqliteStore(db, dbPath);
    store.migrate();
    return store;
  }

  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )`);
    const row = this.db.prepare("SELECT MAX(version) AS v FROM _migrations").get() as { v: number | null };
    const current = row?.v ?? 0;
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      this.transaction(() => {
        for (const statement of migration.statements) this.db.exec(statement);
        this.db
          .prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)")
          .run(migration.version, Date.now());
      });
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  get<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: (string | number | null)[]): void {
    this.db.prepare(sql).run(...params);
  }

  recordMemoryVersion(type: string, id: string, payload: unknown, reason: string): void {
    const row = this.get<{ v: number | null }>(
      "SELECT MAX(version) AS v FROM memory_versions WHERE memory_type = ? AND memory_id = ?",
      type,
      id,
    );
    const next = (row?.v ?? 0) + 1;
    this.run(
      "INSERT INTO memory_versions (memory_type, memory_id, version, payload, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      type,
      id,
      next,
      JSON.stringify(payload),
      reason,
      Date.now(),
    );
  }

  close(): void {
    this.db.close();
  }
}
