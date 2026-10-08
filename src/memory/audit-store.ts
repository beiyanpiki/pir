import type { SqliteStore } from "./sqlite-store.js";
import type { CoverageSummary } from "../core/coverage.js";

/**
 * Run-local persistence for audits: work-unit states and per-file coverage
 * ledgers. These are execution artifacts, not knowledge — they never enter
 * memory sync (see MEMORY_WIRE_SCHEMA_VERSION in sync.ts).
 */

export interface AuditUnitRow {
  runId: string;
  unitId: string;
  state: string;
  attempts: number;
  files: number;
  reason: string | null;
  updatedAt: number;
}

export interface AuditFileCoverageRow {
  runId: string;
  path: string;
  blobId: string;
  state: string;
  reason: string | null;
  rangesTotal: number;
  rangesReviewed: number;
  updatedAt: number;
}

export interface AuditRunTarget {
  commit: string;
  treeId: string;
  scopeVersion: number;
  plannerVersion: number;
  scope: { includePaths: string[]; skipGlobs: string[] };
}

export interface AuditRunState {
  snapshot: AuditRunTarget;
  coverage: CoverageSummary;
  units: Array<{ unitId: string; state: string; reason?: string; files: number; attempts: number }>;
  files: Array<{ path: string; blobId: string; state: string; reason?: string; rangesTotal: number; rangesReviewed: number }>;
}

export class AuditStore {
  constructor(
    private readonly store: SqliteStore,
    private readonly projectId: string,
  ) {}

  /**
   * Record the audit target (snapshot identity + scope) at run start, so
   * mid-run observers see what is being audited before any ledger flush.
   */
  beginRun(runId: string, target: AuditRunTarget): void {
    this.store.transaction(() => {
      this.store.run(
        "UPDATE review_runs SET target = ?, updated_at = ? WHERE id = ? AND project_id = ?",
        JSON.stringify(target),
        Date.now(),
        runId,
        this.projectId,
      );
    });
    this.checkpointWal();
  }

  /**
   * Incremental progress flush (#38): upsert the ledger rows for the work
   * units that just changed (and their owned files) plus a review_runs
   * heartbeat, in one transaction. Cheap by design — a few rows per unit, a
   * unit every ~5-10 minutes — so "how far along is it" is answerable from
   * the DB at any moment instead of only at finishRun.
   */
  upsertProgress(
    runId: string,
    progress: {
      units: Array<{ unitId: string; state: string; reason?: string; files: number; attempts: number }>;
      files: Array<{ path: string; blobId: string; state: string; reason?: string; rangesTotal: number; rangesReviewed: number }>;
    },
  ): void {
    const now = Date.now();
    this.store.transaction(() => {
      for (const unit of progress.units) {
        this.store.run(
          `INSERT INTO audit_work_units (run_id, unit_id, state, attempts, files, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (run_id, unit_id) DO UPDATE SET
             state = excluded.state, attempts = excluded.attempts, files = excluded.files,
             reason = excluded.reason, updated_at = excluded.updated_at`,
          runId,
          unit.unitId,
          unit.state,
          unit.attempts,
          unit.files,
          unit.reason ?? null,
          now,
        );
      }
      for (const file of progress.files) {
        this.store.run(
          `INSERT INTO audit_file_coverage (run_id, path, blob_id, state, reason, ranges_total, ranges_reviewed, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (run_id, path) DO UPDATE SET
             state = excluded.state, reason = excluded.reason, ranges_reviewed = excluded.ranges_reviewed,
             updated_at = excluded.updated_at`,
          runId,
          file.path,
          file.blobId,
          file.state,
          file.reason ?? null,
          file.rangesTotal,
          file.rangesReviewed,
          now,
        );
      }
      this.store.run(
        "UPDATE review_runs SET updated_at = ? WHERE id = ? AND project_id = ?",
        now,
        runId,
        this.projectId,
      );
    });
    this.checkpointWal();
  }

  /**
   * Fold committed WAL frames into the main db file when possible. A writer
   * holding the connection for a multi-day run otherwise leaves memory.sqlite
   * frozen at the last autocheckpoint (~4 MB of WAL), and anyone copying or
   * reading the file without the -wal sidecar sees a stale snapshot (#38).
   * PASSIVE never blocks: readers or a busy writer simply leave frames in the
   * WAL for the next attempt.
   */
  private checkpointWal(): void {
    try {
      this.store.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    } catch {
      // checkpointing is best-effort; committed data stays in the WAL either way
    }
  }

  /** Persist the full ledger for a finished (or stopped) audit run — atomically. */
  persistRunState(runId: string, state: AuditRunState): void {
    const now = Date.now();
    // One transaction: a failure mid-write must not leave the ledger with
    // deleted-but-not-reinserted rows.
    this.store.transaction(() => {
      this.store.run(
        "UPDATE review_runs SET target = ?, updated_at = ? WHERE id = ? AND project_id = ?",
        JSON.stringify(state.snapshot),
        now,
        runId,
        this.projectId,
      );
      this.store.run("DELETE FROM audit_work_units WHERE run_id = ?", runId);
      for (const unit of state.units) {
        this.store.run(
          "INSERT INTO audit_work_units (run_id, unit_id, state, attempts, files, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          runId,
          unit.unitId,
          unit.state,
          unit.attempts,
          unit.files,
          unit.reason ?? null,
          now,
        );
      }
      this.store.run("DELETE FROM audit_file_coverage WHERE run_id = ?", runId);
      for (const file of state.files) {
        this.store.run(
          "INSERT INTO audit_file_coverage (run_id, path, blob_id, state, reason, ranges_total, ranges_reviewed, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          runId,
          file.path,
          file.blobId,
          file.state,
          file.reason ?? null,
          file.rangesTotal,
          file.rangesReviewed,
          now,
        );
      }
    });
  }

  units(runId: string): AuditUnitRow[] {
    return this.store.all<Record<string, unknown>>(
      "SELECT * FROM audit_work_units WHERE run_id = ? ORDER BY unit_id",
      runId,
    ).map((row) => ({
      runId: String(row.run_id),
      unitId: String(row.unit_id),
      state: String(row.state),
      attempts: Number(row.attempts),
      files: Number(row.files),
      reason: (row.reason as string | null) ?? null,
      updatedAt: Number(row.updated_at),
    }));
  }

  fileCoverage(runId: string): AuditFileCoverageRow[] {
    return this.store.all<Record<string, unknown>>(
      "SELECT * FROM audit_file_coverage WHERE run_id = ? ORDER BY path",
      runId,
    ).map((row) => ({
      runId: String(row.run_id),
      path: String(row.path),
      blobId: String(row.blob_id),
      state: String(row.state),
      reason: (row.reason as string | null) ?? null,
      rangesTotal: Number(row.ranges_total),
      rangesReviewed: Number(row.ranges_reviewed),
      updatedAt: Number(row.updated_at),
    }));
  }
}
