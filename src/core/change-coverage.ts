import type { ChangeSet } from "../changes/change-set.js";

/**
 * Change-mode coverage ledger (roadmap C1, stage 1 — observational).
 *
 * The denominator is the reviewed diff: every hunk of every changed file.
 * A hunk counts as covered when the reviewer saw its content through one of
 * two deliberate channels — raw diff lines paged from `get_change`
 * (`recordHunk`) or a head-revision `read_code` window intersecting the
 * hunk's new-side interval (`recordRead`). Overview/hunk-index listings and
 * mechanically collected candidate evidence are deliberately not reads: an
 * account of "did the reviewer read the change" must not be padded by
 * navigation or tooling side effects.
 *
 * Deleted-side hunks have no head-side interval ([+0,0] headers): they count
 * toward the totals and are coverable only by paging their raw lines.
 * Renames are accounted under their new path.
 */

export interface ChangeCoverageCounts {
  hunksTotal: number;
  hunksCovered: number;
  filesTotal: number;
  filesCovered: number;
}

export interface ChangeCoverageFile {
  path: string;
  covered: number;
  total: number;
}

export interface ChangeCoverageSummary extends ChangeCoverageCounts {
  files: ChangeCoverageFile[];
}

/** New-side line interval of one hunk, inclusive; null = no head-side lines. */
interface HunkRegion {
  start: number;
  end: number;
}

interface ReadRange {
  start: number;
  /** Null = open-ended (reads to end of file). */
  end: number | null;
}

/** The per-file detail list in `summary()` is capped; counts never are. */
const MAX_SUMMARY_FILES = 200;

export class ChangeCoverage {
  private readonly regions = new Map<string, Array<HunkRegion | null>>();
  private readonly paged = new Set<string>();
  private readonly reads = new Map<string, ReadRange[]>();

  constructor(changeSet: ChangeSet) {
    for (const file of changeSet.files) {
      // Files without hunks (binary, pure rename) have nothing observable to
      // account for; including them would make full coverage unreachable.
      if (file.hunks.length === 0) continue;
      this.regions.set(
        file.path,
        file.hunks.map((hunk) =>
          hunk.newLineCount > 0 ? { start: hunk.newStart, end: hunk.newStart + hunk.newLineCount - 1 } : null,
        ),
      );
    }
  }

  recordHunk(path: string, hunkIndex: number): void {
    const regions = this.regions.get(path);
    if (!regions || hunkIndex < 0 || hunkIndex >= regions.length) return;
    this.paged.add(`${path}\u0000${hunkIndex}`);
  }

  /** Head-revision `read_code` window; intersections mark hunks covered. */
  recordRead(path: string, range: { startLine: number; endLine: number | null }): void {
    if (!this.regions.has(path)) return;
    const list = this.reads.get(path) ?? [];
    list.push({ start: range.startLine, end: range.endLine });
    this.reads.set(path, list);
  }

  counts(): ChangeCoverageCounts {
    let hunksTotal = 0;
    let hunksCovered = 0;
    let filesTotal = 0;
    let filesCovered = 0;
    for (const [path, regions] of this.regions) {
      let covered = 0;
      for (let index = 0; index < regions.length; index++) {
        hunksTotal += 1;
        if (this.isCovered(path, index)) covered += 1;
      }
      hunksCovered += covered;
      filesTotal += 1;
      if (covered === regions.length) filesCovered += 1;
    }
    return { hunksTotal, hunksCovered, filesTotal, filesCovered };
  }

  summary(): ChangeCoverageSummary {
    const files: ChangeCoverageFile[] = [];
    for (const [path, regions] of this.regions) {
      if (files.length >= MAX_SUMMARY_FILES) break;
      const covered = regions.reduce((sum, _region, index) => sum + (this.isCovered(path, index) ? 1 : 0), 0);
      files.push({ path, covered, total: regions.length });
    }
    return { ...this.counts(), files };
  }

  /**
   * Uncovered hunks in file order, up to `limit` — the focus-list source for
   * the forced coverage round (stage 2).
   */
  unreadHunks(limit: number): Array<{ path: string; hunkIndex: number }> {
    const out: Array<{ path: string; hunkIndex: number }> = [];
    for (const [path, regions] of this.regions) {
      for (let index = 0; index < regions.length; index++) {
        if (this.isCovered(path, index)) continue;
        if (out.length >= limit) return out;
        out.push({ path, hunkIndex: index });
      }
    }
    return out;
  }

  private isCovered(path: string, index: number): boolean {
    if (this.paged.has(`${path}\u0000${index}`)) return true;
    const region = this.regions.get(path)![index];
    if (!region) return false;
    return (this.reads.get(path) ?? []).some((read) =>
      region.start <= (read.end ?? Number.POSITIVE_INFINITY) && region.end >= read.start,
    );
  }
}
