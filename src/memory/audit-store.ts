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

  /** Persist the full ledger for a finished (or stopped) audit run. */
  async persistRunState(runId: string, state: AuditRunState): Promise<void> {
    const now = Date.now();
    this.store.run(
      "UPDATE review_runs SET target = ? WHERE id = ? AND project_id = ?",
      JSON.stringify(state.snapshot),
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
