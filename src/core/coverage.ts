import type { RepoSnapshot, ScopedEntry } from "../changes/snapshot.js";
import type { OwnedRange, ReviewWorkUnit } from "./audit-planner.js";

/**
 * Coverage accounting for audits. "Reviewed" is a process claim — every owned
 * range of the file finished its allotted discovery sessions with a valid
 * completion — never a promise that every defect was found. The summary keeps
 * the identity equation exact so nothing can vanish between states.
 */

export type CoverageFileState =
  | "notSelected"
  | "excluded"
  | "reviewed"
  | "partial"
  | "unreviewed"
  | "blocked"
  | "failed";

export type UnitState = "pending" | "in-progress" | "reviewed" | "blocked" | "failed";

export interface FileCoverageRecord {
  path: string;
  blobId: string;
  state: CoverageFileState;
  reason?: string;
  /** Ranges owned by completed units vs total owned ranges (informational). */
  rangesTotal: number;
  rangesReviewed: number;
}

export interface CoverageSummary {
  filesTotal: number;
  filesNotSelected: number;
  filesExcluded: number;
  filesInScope: number;
  filesReviewed: number;
  filesPartial: number;
  filesUnreviewed: number;
  filesBlocked: number;
  filesFailed: number;
  batchesTotal: number;
  batchesCompleted: number;
  batchesBlocked: number;
  batchesFailed: number;
}

export class CoverageLedger {
  private readonly files = new Map<string, FileCoverageRecord>();
  private readonly rangesByFile: Map<string, number>;
  private readonly units = new Map<string, { state: UnitState; reason?: string; ownedPaths: string[] }>();
  private readonly rangeOwners: Map<string, string[]> = new Map();

  constructor(snapshot: RepoSnapshot, rangesByFile: Map<string, OwnedRange[]>, units: ReviewWorkUnit[]) {
    this.rangesByFile = new Map([...rangesByFile.entries()].map(([path, ranges]) => [path, ranges.length]));
    for (const unit of units) {
      this.units.set(unit.id, { state: "pending", ownedPaths: [...new Set(unit.owned.map((range) => range.path))] });
      for (const range of unit.owned) {
        const owners = this.rangeOwners.get(range.path) ?? [];
        owners.push(unit.id);
        this.rangeOwners.set(range.path, owners);
      }
    }
    for (const entry of snapshot.entries) {
      if (entry.selection === "not-selected") {
        this.files.set(entry.path, this.record(entry, "notSelected"));
      } else if (entry.selection === "excluded") {
        this.files.set(entry.path, this.record(entry, "excluded", entry.exclusionReason));
      } else if (entry.classification !== "text") {
        // Selected but not machine-reviewable: blocked, never silently dropped.
        this.files.set(entry.path, this.record(entry, "blocked", entry.classification));
      } else {
        this.files.set(entry.path, this.record(entry, "unreviewed"));
      }
    }
  }

  private record(entry: ScopedEntry, state: CoverageFileState, reason?: string): FileCoverageRecord {
    return {
      path: entry.path,
      blobId: entry.objectId,
      state,
      reason,
      rangesTotal: this.rangesByFile.get(entry.path) ?? 0,
      rangesReviewed: 0,
    };
  }

  unitState(unitId: string): UnitState {
    return this.units.get(unitId)?.state ?? "failed";
  }

  markUnit(unitId: string, state: UnitState, reason?: string): void {
    const unit = this.units.get(unitId);
    if (!unit) throw new Error(`unknown unit: ${unitId}`);
    unit.state = state;
    unit.reason = reason;
    this.recomputeOwnedFiles();
  }

  private reviewedUnitIdsFor(path: string): number {
    return (this.rangeOwners.get(path) ?? []).filter((unitId) => {
      const state = this.units.get(unitId)?.state;
      return state === "reviewed";
    }).length;
  }

  private recomputeOwnedFiles(): void {
    for (const [path, record] of this.files) {
      const owners = this.rangeOwners.get(path);
      if (!owners || owners.length === 0) continue; // not-selected / excluded / blocked-by-class
      const failedOwner = owners.some((unitId) => this.units.get(unitId)?.state === "failed");
      const blockedOwner = owners.some((unitId) => this.units.get(unitId)?.state === "blocked");
      const reviewed = this.reviewedUnitIdsFor(path);
      record.rangesReviewed = reviewed;
      if (failedOwner) {
        record.state = "failed";
        record.reason = "owning unit failed";
      } else if (reviewed === owners.length) {
        record.state = "reviewed";
        record.reason = undefined;
      } else if (blockedOwner && reviewed === 0) {
        record.state = "blocked";
        record.reason = "owning unit blocked";
      } else if (reviewed > 0) {
        record.state = "partial";
        record.reason = `${reviewed}/${owners.length} owning units reviewed`;
      } else {
        record.state = "unreviewed";
        record.reason = undefined;
      }
    }
  }

  summary(): CoverageSummary {
    const summary: CoverageSummary = {
      filesTotal: 0, filesNotSelected: 0, filesExcluded: 0, filesInScope: 0,
      filesReviewed: 0, filesPartial: 0, filesUnreviewed: 0, filesBlocked: 0, filesFailed: 0,
      batchesTotal: this.units.size, batchesCompleted: 0, batchesBlocked: 0, batchesFailed: 0,
    };
    for (const record of this.files.values()) {
      summary.filesTotal += 1;
      switch (record.state) {
        case "notSelected": summary.filesNotSelected += 1; break;
        case "excluded": summary.filesExcluded += 1; break;
        case "reviewed": summary.filesReviewed += 1; summary.filesInScope += 1; break;
        case "partial": summary.filesPartial += 1; summary.filesInScope += 1; break;
        case "unreviewed": summary.filesUnreviewed += 1; summary.filesInScope += 1; break;
        case "blocked": summary.filesBlocked += 1; summary.filesInScope += 1; break;
        case "failed": summary.filesFailed += 1; summary.filesInScope += 1; break;
      }
    }
    for (const unit of this.units.values()) {
      if (unit.state === "reviewed") summary.batchesCompleted += 1;
      else if (unit.state === "blocked") summary.batchesBlocked += 1;
      else if (unit.state === "failed") summary.batchesFailed += 1;
    }
    return summary;
  }

  /** True when no unit still awaits scheduling — the loop may end (blocked or failed units still make the run incomplete). */
  allUnitsTerminal(): boolean {
    return [...this.units.values()].every(
      (unit) => unit.state === "reviewed" || unit.state === "blocked" || unit.state === "failed",
    );
  }

  /** True when every in-scope file reached the reviewed state. */
  scopeFullyReviewed(): boolean {
    const summary = this.summary();
    return summary.filesPartial === 0 && summary.filesUnreviewed === 0 && summary.filesBlocked === 0 && summary.filesFailed === 0;
  }

  /** Per-file records for persistence and reporting, in path order. */
  fileRecords(): FileCoverageRecord[] {
    return [...this.files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  unitRecords(): Array<{ unitId: string; state: UnitState; reason?: string; ownedPaths: string[] }> {
    return [...this.units.entries()].map(([unitId, unit]) => ({
      unitId, state: unit.state, reason: unit.reason, ownedPaths: unit.ownedPaths,
    }));
  }
}
