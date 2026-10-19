import { git, resolveCommit } from "./git.js";
import {
  DEFAULT_SKIP_PATTERNS,
  FILTER_VERSION,
  classifyEntry,
  includeMatches,
  normalizeIncludePath,
  pathMatchesGlob,
  type EntryClass,
} from "./filter.js";

/**
 * Immutable snapshot of one committed revision: the coverage denominator for
 * audits. Enumerated from the git tree itself — never the working filesystem
 * or the structural index, neither of which is pinned to the reviewed commit.
 *
 * The exclusion/classification policy itself lives in `./filter.js` (B1) and is
 * re-exported here for the callers that predate the split.
 */

export {
  BINARY_EXTENSIONS,
  DEFAULT_SKIP_PATTERNS,
  FILTER_VERSION,
  MAX_AUDIT_FILE_BYTES,
  classifyEntry,
  normalizeIncludePath,
  pathMatchesGlob,
} from "./filter.js";
export type { EntryClass, FilterEntry, PathRule } from "./filter.js";

export interface TreeEntry {
  path: string;
  /** Blob object id; the commit id for submodule gitlinks. */
  objectId: string;
  type: "blob" | "commit";
  /** Git file mode: 100644/100755 blob, 120000 symlink, 160000 gitlink. */
  mode: string;
  /** Blob size in bytes; null for gitlinks. */
  size: number | null;
}

export interface ScopeSelection {
  /** selected (in audit scope), narrowed by --path, minus --skip; or policy-excluded */
  selection: "selected" | "not-selected" | "excluded";
  exclusionReason?: string;
  /** Content class; only "text" entries are reviewable. */
  classification: EntryClass;
}

export interface ScopedEntry extends TreeEntry, ScopeSelection {}

export interface AuditScope {
  /**
   * Literal files or directory prefixes (repo-relative, no globs). Empty
   * means the whole committed tree. "." selects the root.
   */
  includePaths: string[];
  /** Documented globs (`*`, `**`, `?`; no-magic values act as dir prefixes). */
  skipGlobs: string[];
}

export interface RepoSnapshot {
  repoRoot: string;
  commit: string;
  treeId: string;
  entries: ScopedEntry[];
  scope: AuditScope;
  /** Bump when selection semantics change; persisted with run records. */
  scopeVersion: typeof FILTER_VERSION;
}

/** Parse `mode SP type SP object SP size TAB path` records from ls-tree -z -l
 *  (the size column is space-padded for alignment). */
function parseLsTree(output: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of output.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [meta, path] = [record.slice(0, tab), record.slice(tab + 1)];
    const parts = meta.trim().split(/[ ]+/);
    if (parts.length !== 4) continue;
    const [mode, type, objectId, sizeText] = parts as [string, string, string, string];
    if (type !== "blob" && type !== "commit") continue;
    if (!/^[0-9a-f]{40,64}$/i.test(objectId) || path.includes("\0")) continue;
    entries.push({
      path,
      objectId,
      type,
      mode,
      size: type === "blob" ? (sizeText === "-" ? null : Number(sizeText)) : null,
    });
  }
  return entries;
}

export async function buildRepoSnapshot(repoRoot: string, ref: string, scope: AuditScope): Promise<RepoSnapshot> {
  const commit = await resolveCommit(repoRoot, ref);
  const treeId = (await git(repoRoot, ["rev-parse", `${commit}^{tree}`])).trim();
  const listed = parseLsTree(await git(repoRoot, ["ls-tree", "-r", "-l", "-z", "--full-tree", commit]));
  // Deterministic order: path ascending.
  listed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const includes = scope.includePaths.map(normalizeIncludePath);
  const entries: ScopedEntry[] = listed.map((entry) => {
    const classification = classifyEntry(entry);
    const selected = includes.length === 0 || includes.some((include) => includeMatches(entry.path, include));
    if (!selected) {
      return { ...entry, selection: "not-selected", classification };
    }
    const skipped = scope.skipGlobs.find((glob) => pathMatchesGlob(entry.path, glob));
    if (skipped !== undefined) {
      return { ...entry, selection: "excluded", exclusionReason: `--skip ${skipped}`, classification };
    }
    const defaultSkip = DEFAULT_SKIP_PATTERNS.find((pattern) => pathMatchesGlob(entry.path, pattern.glob));
    if (defaultSkip) {
      return { ...entry, selection: "excluded", exclusionReason: `default policy: ${defaultSkip.reason}`, classification };
    }
    return { ...entry, selection: "selected", classification };
  });
  return { repoRoot, commit, treeId, entries, scope, scopeVersion: FILTER_VERSION };
}

export function selectedReviewableEntries(snapshot: RepoSnapshot): ScopedEntry[] {
  return snapshot.entries.filter((entry) => entry.selection === "selected" && entry.classification === "text");
}
