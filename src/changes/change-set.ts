import { getDiffPatch, getMergeBase, getNameStatus } from "./git.js";
import { parseUnifiedDiff, type FileDiff } from "./diff.js";

export interface ChangedFile extends FileDiff {
  /** File extension derived language hint, e.g. "ts". */
  language: string;
}

export interface ChangeSet {
  repoRoot: string;
  base: string;
  head: string;
  mergeBase: string;
  files: ChangedFile[];
  patch: string;
  /** Total added + removed lines across files. */
  churn: number;
}

export async function buildChangeSet(repoRoot: string, base: string, head: string): Promise<ChangeSet> {
  const mergeBase = await getMergeBase(repoRoot, base, head);
  const [patch, nameStatus] = await Promise.all([
    getDiffPatch(repoRoot, base, head),
    getNameStatus(repoRoot, base, head),
  ]);
  const parsed = parseUnifiedDiff(patch);
  const statusByPath = new Map(nameStatus.map((e) => [e.path, e]));

  const files: ChangedFile[] = parsed.files.map((f) => {
    const ns = statusByPath.get(f.path);
    let status = f.status;
    if (ns) {
      if (ns.status === "A") status = "added";
      else if (ns.status === "D") status = "deleted";
      else if (ns.status === "R") status = "renamed";
      else if (ns.status === "M") status = "modified";
    }
    return { ...f, status, language: languageOf(f.path) };
  });

  // name-status may include entries the patch parser missed (e.g. pure renames
  // with no content change still appear in --name-status with -M).
  for (const ns of nameStatus) {
    if (!files.some((f) => f.path === ns.path)) {
      files.push({
        path: ns.path,
        oldPath: ns.oldPath,
        status:
          ns.status === "A"
            ? "added"
            : ns.status === "D"
              ? "deleted"
              : ns.status === "R"
                ? "renamed"
                : "modified",
        hunks: [],
        additions: 0,
        deletions: 0,
        language: languageOf(ns.path),
      });
    }
  }

  const churn = files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  return { repoRoot, base, head, mergeBase, files, patch, churn };
}

function languageOf(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot === path.length - 1) return "";
  return path.slice(dot + 1).toLowerCase();
}
