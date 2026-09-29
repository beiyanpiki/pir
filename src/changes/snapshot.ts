import { git, resolveCommit } from "./git.js";

/**
 * Immutable snapshot of one committed revision: the coverage denominator for
 * audits. Enumerated from the git tree itself — never the working filesystem
 * or the structural index, neither of which is pinned to the reviewed commit.
 */

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

/** Why an entry is not machine-reviewable text. */
export type EntryClass =
  | "text"
  | "binary-extension"
  | "symlink"
  | "submodule"
  | "oversized";

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
  scopeVersion: 1;
}

/** Versioned default exclusion policy; shown to users and recorded per entry. */
const DEFAULT_SKIP_PATTERNS: Array<{ glob: string; reason: string }> = [
  { glob: "node_modules/**", reason: "vendored dependencies" },
  { glob: "vendor/**", reason: "vendored dependencies" },
  { glob: "third_party/**", reason: "vendored dependencies" },
  { glob: "dist/**", reason: "build output" },
  { glob: "build/**", reason: "build output" },
  { glob: "out/**", reason: "build output" },
  { glob: "target/**", reason: "build output" },
  { glob: ".pir/**", reason: "pir state" },
  { glob: "package-lock.json", reason: "lockfile" },
  { glob: "pnpm-lock.yaml", reason: "lockfile" },
  { glob: "yarn.lock", reason: "lockfile" },
  { glob: "Cargo.lock", reason: "lockfile" },
  { glob: "poetry.lock", reason: "lockfile" },
  { glob: "go.sum", reason: "lockfile" },
  { glob: "*.min.js", reason: "minified output" },
  { glob: "*.min.css", reason: "minified output" },
  { glob: "*.map", reason: "build output" },
];

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "icns", "svgz", "webp", "avif", "heic", "tiff",
  "mp3", "mp4", "mov", "avi", "mkv", "webm", "wav", "flac", "ogg", "aiff",
  "pdf", "psd", "ai", "eps",
  "zip", "gz", "tgz", "bz2", "xz", "zst", "lz4", "7z", "rar", "tar", "jar", "war", "ear", "apk", "ipa",
  "exe", "dll", "so", "dylib", "a", "o", "obj", "lib", "class", "pyc", "pyo", "wasm", "node",
  "ttf", "otf", "woff", "woff2", "eot",
  "sqlite", "db", "dat", "bin", "iso", "img", "dmg", "parquet", "arrow",
]);

/** Above this, a selected file cannot be meaningfully paged through in a session. */
export const MAX_AUDIT_FILE_BYTES = 1_000_000;

function hasGlobMagic(glob: string): boolean {
  return /[*?[\]]/.test(glob);
}

/**
 * POSIX-flavored glob match against a repo-relative path. A pattern without
 * magic characters matches the literal file or a directory prefix (so
 * `--skip dist` removes everything under dist/); a single-segment glob such
 * as `*.gen.ts` matches the basename at any depth.
 */
export function pathMatchesGlob(path: string, glob: string): boolean {
  const normalizedGlob = glob.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalizedGlob) return false;
  if (!hasGlobMagic(normalizedGlob)) {
    return path === normalizedGlob || path.startsWith(`${normalizedGlob}/`);
  }
  const segments = path.split("/");
  if (!normalizedGlob.includes("/")) {
    return globSegmentsMatch([segments[segments.length - 1]!], normalizedGlob.split("/"));
  }
  return globSegmentsMatch(segments, normalizedGlob.split("/"));
}

function globSegmentsMatch(pathSegments: string[], patternSegments: string[]): boolean {
  // Dynamic programming over (path index, pattern index); "**" consumes any
  // number of path segments.
  let reachable = new Set<number>([0]);
  for (let p = 0; p < patternSegments.length; p++) {
    const pattern = patternSegments[p]!;
    const next = new Set<number>();
    for (const index of reachable) {
      if (pattern === "**") {
        for (let i = index; i <= pathSegments.length; i++) next.add(i);
      } else if (index < pathSegments.length && segmentMatches(pathSegments[index]!, pattern)) {
        next.add(index + 1);
      }
    }
    reachable = next;
    if (reachable.size === 0) return false;
  }
  return reachable.has(pathSegments.length);
}

function segmentMatches(segment: string, pattern: string): boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) return segment === pattern;
  const regex = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, ".")}$`,
  );
  return regex.test(segment);
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

function classifyEntry(entry: TreeEntry): EntryClass {
  if (entry.mode === "160000" || entry.type === "commit") return "submodule";
  if (entry.mode === "120000") return "symlink";
  const dot = entry.path.lastIndexOf(".");
  const extension = dot > 0 && dot < entry.path.length - 1 ? entry.path.slice(dot + 1).toLowerCase() : "";
  if (BINARY_EXTENSIONS.has(extension)) return "binary-extension";
  if ((entry.size ?? 0) > MAX_AUDIT_FILE_BYTES) return "oversized";
  return "text";
}

export function normalizeIncludePath(value: string): string {
  if (typeof value !== "string" || value.includes("\0") || value.includes("\\")) {
    throw new Error(`invalid --path: ${JSON.stringify(value)}`);
  }
  if (value === "." || value === "./") return ".";
  const segments = value.split("/").filter((segment) => segment && segment !== ".");
  if (segments.length === 0 || segments.includes("..") || segments.some((segment) => /[*?[\]]/.test(segment))) {
    throw new Error(`invalid --path (literal file or directory prefix expected): ${JSON.stringify(value)}`);
  }
  return segments.join("/");
}

function includeMatches(path: string, include: string): boolean {
  return include === "." || path === include || path.startsWith(`${include}/`);
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
  return { repoRoot, commit, treeId, entries, scope, scopeVersion: 1 };
}

export function selectedReviewableEntries(snapshot: RepoSnapshot): ScopedEntry[] {
  return snapshot.entries.filter((entry) => entry.selection === "selected" && entry.classification === "text");
}
