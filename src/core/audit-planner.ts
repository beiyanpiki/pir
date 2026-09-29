import type { RepoSnapshot } from "../changes/snapshot.js";
import { readFileAtCommit } from "../changes/git.js";
import { selectedReviewableEntries } from "../changes/snapshot.js";

/**
 * Deterministic partition of a snapshot's selected text entries into bounded
 * work units. Units are the audit scheduling granularity — not a second
 * review engine: each unit feeds one reviewer session inside the shared
 * supervisor loop, with global budgets and dedup across units.
 */

export interface OwnedRange {
  path: string;
  /** 1-based inclusive; endLine null means "to end of file". */
  startLine: number;
  endLine: number | null;
}

export interface ReviewWorkUnit {
  id: string;
  module: string;
  /** Disjoint owned ranges; the union over all units is the reviewable scope. */
  owned: OwnedRange[];
  /** Context files carry no coverage obligation in P0 (reserved seam). */
  contextFiles: string[];
  lineEstimate: number;
}

export const PLANNER_VERSION = 2;
// Dogfooding on pir's own src/core showed a 9-file unit burning ~480K tokens
// in one reviewer session (paginated reads + investigation loops). Units are
// sized so a session stays inside a realistic context budget.
const MAX_FILES_PER_UNIT = 5;
const MAX_LINES_PER_UNIT = 1200;
/** Single files above this are split into sequential range chunks. */
const SPLIT_FILE_LINES = 800;
const CHUNK_LINES = 500;
/** Size above which an exact line count is worth one bounded blob read. */
const EXACT_COUNT_BYTES = 100_000;
const ESTIMATED_LINE_BYTES = 40;

function moduleOf(path: string): string {
  const segments = path.split("/");
  return segments.length > 2 ? `${segments[0]!}/${segments[1]!}` : segments.length > 1 ? segments[0]! : ".";
}

async function lineCount(repoRoot: string, commit: string, path: string, size: number | null): Promise<number> {
  if (size === null || size === 0) return 0;
  if (size <= EXACT_COUNT_BYTES) return Math.max(1, Math.ceil(size / ESTIMATED_LINE_BYTES));
  const content = await readFileAtCommit(repoRoot, commit, path);
  if (content === null) return 1;
  return content.split("\n").length;
}

export interface AuditPlan {
  units: ReviewWorkUnit[];
  plannerVersion: number;
  /** Owned ranges per file, for coverage bookkeeping. */
  rangesByFile: Map<string, OwnedRange[]>;
}

export async function planAuditUnits(snapshot: RepoSnapshot): Promise<AuditPlan> {
  const reviewable = selectedReviewableEntries(snapshot);
  const byModule = new Map<string, typeof reviewable>();
  for (const entry of reviewable) {
    const module = moduleOf(entry.path);
    const group = byModule.get(module) ?? ([] as typeof reviewable);
    group.push(entry);
    byModule.set(module, group);
  }

  // Range-level plan per module before packing into units.
  interface FileRanges { path: string; ranges: OwnedRange[]; lines: number }
  const rangesByFile = new Map<string, OwnedRange[]>();
  const moduleFiles: Array<{ module: string; files: FileRanges[] }> = [];
  for (const module of [...byModule.keys()].sort()) {
    const files: FileRanges[] = [];
    for (const entry of byModule.get(module)!) {
      const total = Math.max(1, await lineCount(snapshot.repoRoot, snapshot.commit, entry.path, entry.size));
      const ranges: OwnedRange[] =
        total > SPLIT_FILE_LINES
          ? splitIntoChunks(entry.path, total)
          : [{ path: entry.path, startLine: 1, endLine: null }];
      rangesByFile.set(entry.path, ranges);
      files.push({ path: entry.path, ranges, lines: total });
    }
    moduleFiles.push({ module, files });
  }

  const units: ReviewWorkUnit[] = [];
  let seq = 0;
  const pushUnit = (module: string, owned: OwnedRange[], lineEstimate: number): void => {
    if (owned.length === 0) return;
    seq += 1;
    units.push({
      id: `U-${String(seq).padStart(3, "0")}`,
      module,
      owned,
      contextFiles: [],
      lineEstimate,
    });
  };
  for (const { module, files } of moduleFiles) {
    let current: OwnedRange[] = [];
    let currentLines = 0;
    for (const file of files) {
      const unassigned = [...file.ranges];
      while (unassigned.length > 0) {
        const roomFiles = MAX_FILES_PER_UNIT - current.length;
        const roomLines = MAX_LINES_PER_UNIT - currentLines;
        if (roomFiles <= 0 || roomLines <= 0) {
          pushUnit(module, current, currentLines);
          current = [];
          currentLines = 0;
          continue;
        }
        const range = unassigned[0]!;
        const rangeLines = linesOf(range, file.lines);
        // A range larger than a whole unit occupies its own unit(s): never
        // split a line range further — one unit per oversized chunk.
        if (rangeLines > MAX_LINES_PER_UNIT) {
          if (current.length > 0) {
            pushUnit(module, current, currentLines);
            current = [];
            currentLines = 0;
          }
          pushUnit(module, [range], rangeLines);
          unassigned.shift();
          continue;
        }
        if (current.length + 1 > MAX_FILES_PER_UNIT || currentLines + rangeLines > MAX_LINES_PER_UNIT) {
          pushUnit(module, current, currentLines);
          current = [];
          currentLines = 0;
        }
        current.push(range);
        currentLines += rangeLines;
        unassigned.shift();
      }
    }
    pushUnit(module, current, currentLines);
  }
  return { units, plannerVersion: PLANNER_VERSION, rangesByFile };
}

function linesOf(range: OwnedRange, fileLines: number): number {
  if (range.endLine === null) return Math.max(1, fileLines - range.startLine + 1);
  return Math.max(1, range.endLine - range.startLine + 1);
}

function splitIntoChunks(path: string, totalLines: number): OwnedRange[] {
  const ranges: OwnedRange[] = [];
  for (let start = 1; start <= totalLines; start += CHUNK_LINES) {
    const end = start + CHUNK_LINES - 1;
    ranges.push({ path, startLine: start, endLine: end < totalLines ? end : null });
  }
  return ranges;
}
