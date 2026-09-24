export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffHunk {
  /** 1-based start line on the new side. */
  newStart: number;
  newLineCount: number;
  oldStart: number;
  oldLineCount: number;
  header: string;
  lines: string[];
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: FileChangeStatus;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

export interface ParsedDiff {
  files: FileDiff[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parse a unified diff as produced by `git diff --no-color -M -U3`.
 * File identity comes from the `diff --git a/<old> b/<new>` line; mode/rename
 * headers then refine the status. Binary files yield an entry with no hunks.
 */
export function parseUnifiedDiff(patch: string): ParsedDiff {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let hunk: DiffHunk | null = null;

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const { a, b } = parseGitPaths(line);
      current = { path: b ?? a ?? "<unknown>", oldPath: a !== b ? a : undefined, status: "modified", hunks: [], additions: 0, deletions: 0 };
      files.push(current);
      hunk = null;
      continue;
    }
    if (!current) continue;

    if (line.startsWith("new file mode")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.oldPath = stripQuotes(line.slice("rename from ".length));
      current.status = "renamed";
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.path = stripQuotes(line.slice("rename to ".length));
      continue;
    }
    if (line.startsWith("copy from ")) {
      current.oldPath = stripQuotes(line.slice("copy from ".length));
      continue;
    }
    if (line.startsWith("copy to ")) {
      current.path = stripQuotes(line.slice("copy to ".length));
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      continue; // paths already known from the diff --git line
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      hunk = null;
      continue;
    }

    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      hunk = {
        oldStart: Number(hunkMatch[1]),
        oldLineCount: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: Number(hunkMatch[3]),
        newLineCount: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        header: line,
        lines: [],
      };
      current.hunks.push(hunk);
      continue;
    }

    if (hunk) {
      if (line.startsWith("+")) {
        current.additions += 1;
        hunk.lines.push(line);
      } else if (line.startsWith("-")) {
        current.deletions += 1;
        hunk.lines.push(line);
      } else if (line.startsWith(" ") || line.startsWith("\\")) {
        hunk.lines.push(line);
      } else if (line === "") {
        // Trailing blank line of the patch, belongs to no hunk body.
      } else {
        hunk = null;
      }
    }
  }
  return { files };
}

/** Extract the a/ and b/ paths from a `diff --git a/x b/y` header. */
function parseGitPaths(line: string): { a?: string; b?: string } {
  const rest = line.slice("diff --git ".length);
  // Fast path: unquoted, space-free names.
  const simple = /^a\/(\S+) b\/(\S+)$/.exec(rest);
  if (simple) return { a: simple[1], b: simple[2] };
  // Quoted form: diff --git "a/x y" "b/x y"
  const quoted = /^("(?:[^"\\]|\\.)*"|\S+)\s+("(?:[^"\\]|\\.)*"|\S+)$/.exec(rest);
  if (quoted) {
    return { a: unquoteAPrefix(quoted[1]!), b: unquoteAPrefix(quoted[2]!) };
  }
  const first = rest.indexOf(" b/");
  if (first > 0) {
    return { a: stripAPrefix(rest.slice(0, first)), b: stripAPrefix(rest.slice(first + 3)) };
  }
  return {};
}

function unquoteAPrefix(token: string): string | undefined {
  if (token.startsWith('"') && token.endsWith('"')) {
    return stripAPrefix(JSON.parse(token) as string);
  }
  return stripAPrefix(token);
}

function stripAPrefix(path: string): string | undefined {
  if (path.startsWith("a/")) return path.slice(2);
  if (path === "/dev/null") return undefined;
  return path;
}

function stripQuotes(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** All new-side line numbers introduced (added lines) in a file diff. */
export function addedLineNumbers(file: FileDiff): number[] {
  const out: number[] = [];
  for (const hunk of file.hunks) {
    let line = hunk.newStart;
    for (const l of hunk.lines) {
      if (l.startsWith("+")) {
        out.push(line);
        line += 1;
      } else if (l.startsWith("-") || l.startsWith("\\")) {
        // old-side only; the new cursor does not advance
      } else {
        line += 1;
      }
    }
  }
  return out;
}
