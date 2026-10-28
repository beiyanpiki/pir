// Parsing for get_change tool results into renderable files/hunks. Pure (no
// React) so node:test can drive it against real transcript shapes — the tool
// has three response formats (overview, per-file hunk listing, single hunk),
// and each carries navigation lines between the headers and the bodies.

export type DiffLineKind = "context" | "add" | "delete";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** True for the synthetic file synthesized around a bare @@ header. */
  synthetic?: boolean;
}

const FILE_HEADER = /^##\s+"([^"]+)"(?:\s+\[([^\]]+)\])?\s+\(\+(\d+)\/-(\d+)\)/;
const HUNK_HEADER = /^hunkIndex:\s*\d+;\s*(@@.*@@.*)$/;
const DIFF_BOUNDARY = /^(?:get_change:|##\s+"|entries:|continuation:|nextHunk:|truncated:)/;

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = text.split("\n");
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inBody = false;

  const closeHunk = (): void => {
    if (hunk && file && hunk.lines.length > 0) file.hunks.push(hunk);
    hunk = null;
    inBody = false;
  };

  for (const line of lines) {
    const fileMatch = line.match(FILE_HEADER);
    if (fileMatch) {
      closeHunk();
      file = {
        path: fileMatch[1],
        status: fileMatch[2] ?? "modified",
        additions: Number(fileMatch[3]),
        deletions: Number(fileMatch[4]),
        hunks: [],
      };
      files.push(file);
      continue;
    }

    const hunkMatch = line.match(HUNK_HEADER);
    if (hunkMatch) {
      closeHunk();
      const header = hunkMatch[1]!;
      const range = header.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldLine = Number(range?.[1] ?? 1);
      newLine = Number(range?.[2] ?? 1);
      hunk = { header, lines: [] };
      inBody = true;
      continue;
    }

    if (inBody && hunk) {
      if (DIFF_BOUNDARY.test(line)) {
        // The hunk-listing format interleaves a `get_change: {...}`
        // suggestion between the hunk header and its body lines; closing on
        // it dropped every body line of the listing (the raw-JSON-wall bug).
        // Only a boundary past captured body lines actually ends a hunk.
        if (hunk.lines.length === 0) continue;
        closeHunk();
        continue;
      }
      if (/^(?:raw diff lines:|snapshot:|requested base:|hunk bodies omitted)/i.test(line)) continue;

      const marker = line.slice(0, 1);
      const value = line.slice(1);
      if (marker === "+") {
        hunk.lines.push({ kind: "add", text: value, newLine: newLine++ });
      } else if (marker === "-") {
        hunk.lines.push({ kind: "delete", text: value, oldLine: oldLine++ });
      } else if (marker === " " || line === "") {
        hunk.lines.push({ kind: "context", text: value, oldLine: oldLine++, newLine: newLine++ });
      }
      continue;
    }

    // Standalone tool output can contain a hunk without the parsed header.
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
      closeHunk();
      const range = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldLine = Number(range?.[1] ?? 1);
      newLine = Number(range?.[2] ?? 1);
      hunk = { header: line, lines: [] };
      file ??= { path: "change", status: "modified", additions: 0, deletions: 0, hunks: [], synthetic: true };
      if (!files.includes(file)) files.push(file);
      inBody = true;
    }
  }
  closeHunk();
  // Real file headers survive with zero hunks (an overview without inlined
  // bodies still renders as a file list); only the synthetic placeholder is
  // dropped when it captured nothing.
  return files.filter((candidate) => !candidate.synthetic || candidate.hunks.length > 0);
}
