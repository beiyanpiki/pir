import { getDiffPatch, getMergeBase, getNameStatus, resolveCommit } from "./git.js";
import { parseUnifiedDiff, type FileDiff, type FileChangeStatus } from "./diff.js";

export interface ChangedFile extends FileDiff {
  /** File extension derived language hint, e.g. "ts". */
  language: string;
  /**
   * Change-mode filter: the file was excluded from diff review. Its
   * metadata (path/status/churn) stays visible to previews, the reviewer and
   * the run record, while `hunks` is emptied so the diff body cannot reach a
   * model.
   */
  excluded?: boolean;
  /** Why the filter excluded it; present exactly when `excluded` is true. */
  excludedReason?: string;
}

export interface ChangeSet {
  repoRoot: string;
  /** Requested ref labels, retained for display and compatibility. */
  base: string;
  head: string;
  /** Immutable commits; optional for legacy/bootstrap contexts. */
  baseCommit?: string;
  headCommit?: string;
  /** Actual old side of the reviewed diff (not necessarily requested base). */
  mergeBase: string;
  files: ChangedFile[];
  patch: string;
  /** Total added + removed lines across files. */
  churn: number;
}

/**
 * The path/status/churn projection the CLI envelope and the run manifest both
 * record. The change-mode filter adds the exclusion record here, once, so the two surfaces cannot
 * drift — and so every pre-filter field keeps its name and value.
 */
export interface ChangedFileSummary {
  path: string;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  /** Always present: true when the change-mode filter withheld the diff body. */
  excluded: boolean;
  /** Only present when `excluded`: the gate's human-readable reason. */
  excludedReason?: string;
}

export function changedFileSummary(file: ChangedFile): ChangedFileSummary {
  return {
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    excluded: Boolean(file.excluded),
    ...(file.excludedReason ? { excludedReason: file.excludedReason } : {}),
  };
}

export async function buildChangeSet(repoRoot: string, base: string, head: string): Promise<ChangeSet> {
  const [baseCommit, headCommit] = await Promise.all([
    resolveCommit(repoRoot, base), resolveCommit(repoRoot, head),
  ]);
  const mergeBase = await getMergeBase(repoRoot, baseCommit, headCommit);
  const [patch, nameStatus] = await Promise.all([
    getDiffPatch(repoRoot, mergeBase, headCommit),
    getNameStatus(repoRoot, mergeBase, headCommit),
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
  return { repoRoot, base, head, baseCommit, headCommit, mergeBase, files, patch, churn };
}

function languageOf(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot === path.length - 1) return "";
  return path.slice(dot + 1).toLowerCase();
}
