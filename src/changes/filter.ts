/**
 * Shared file-filter policy (roadmap B1).
 *
 * Audit and change mode must not drift on what counts as reviewable input, so
 * the policy tables and the classifiers live here and both modes consume them:
 * `buildRepoSnapshot` (audit) applies the classification and the default
 * exclusion globs; the change-mode gate below adds the never-model-visible
 * secret paths and a single-file diff size cap on top.
 *
 * Everything here is pure data plus pure functions. `pir audit --dry-run` and
 * `pir find --preview` print exactly what a real run would select because
 * they call the same functions the run calls.
 */

import type { ChangeSet } from "./change-set.js";
import type { FileDiff } from "./diff.js";

/**
 * Version of the SHARED policy surface (entry classification, binary
 * extensions, default exclusions). Audit persists it as `scopeVersion` on
 * every snapshot, so it answers "which selection semantics produced this
 * run". Change-mode-only gates (secret paths, single-file diff cap) do not
 * change audit output and do not bump this tag.
 */
export const FILTER_VERSION = 1;

export interface PathRule {
  /** POSIX-flavored glob, matched by `pathMatchesGlob`. */
  glob: string;
  /** Human-readable reason, surfaced in previews and exclusion records. */
  reason: string;
}

/**
 * Versioned default exclusion policy; shown to users and recorded per entry.
 * Exported for `pir audit --dry-run` (#56), which reports the rules a real
 * audit would apply — from the same module that applies them.
 */
export const DEFAULT_SKIP_PATTERNS: PathRule[] = [
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

/** Extensions whose content is not machine-reviewable text. */
export const BINARY_EXTENSIONS = new Set([
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

/**
 * Secret paths: never model-visible, and not rescuable by any include/skip
 * option — the one gate whose failure (a credential in a prompt, a transcript
 * and a model provider's logs) cannot be undone. Mirrors OCR's gate 2
 * (`docs/ocr-borrow-and-aacr-benchmark-context.md` §1.3).
 */
export const SECRET_PATH_PATTERNS: PathRule[] = [
  { glob: "**/.ssh/**", reason: "SSH directory" },
  { glob: "id_rsa*", reason: "SSH private key" },
  { glob: "id_dsa*", reason: "SSH private key" },
  { glob: "id_ecdsa*", reason: "SSH private key" },
  { glob: "id_ed25519*", reason: "SSH private key" },
  // `**/` because a no-magic glob matches from the repository root only:
  // these files are secret wherever they live.
  { glob: "**/.netrc", reason: "credential file" },
  { glob: "**/.npmrc", reason: "credential file (registry tokens)" },
  { glob: "**/.pypirc", reason: "credential file (registry tokens)" },
  { glob: "**/.dockercfg", reason: "credential file (registry tokens)" },
  { glob: "**/.env", reason: "dotenv file" },
  { glob: "**/.env.*", reason: "dotenv file" },
];

/** The .env family's checked-in examples carry no secrets and stay reviewable. */
export const SECRET_PATH_EXEMPT_BASENAMES = new Set([".env.example", ".env.sample", ".env.template"]);

/**
 * Single-file diff cap for change mode. Deliberately far below
 * MAX_AUDIT_FILE_BYTES: a diff body is paged inside one reviewer session
 * (`get_change` returns at most 120 raw lines per call) within one or two
 * rounds, while an audit pages a whole file across dedicated work units. At
 * ~4 chars/token this is ~50k tokens — already a large slice of one session.
 */
export const MAX_DIFF_FILE_BYTES = 200_000;

/** Why an entry is not machine-reviewable text. */
export type EntryClass =
  | "text"
  | "binary-extension"
  | "symlink"
  | "submodule"
  | "oversized";

/** Minimal structural shape the classifier needs; `TreeEntry` satisfies it. */
export interface FilterEntry {
  path: string;
  type: "blob" | "commit";
  mode: string;
  size: number | null;
}

/** Lowercased extension without the dot; "" when the path has none. */
export function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot > 0 && dot < path.length - 1 ? path.slice(dot + 1).toLowerCase() : "";
}

export function classifyEntry(entry: FilterEntry): EntryClass {
  if (entry.mode === "160000" || entry.type === "commit") return "submodule";
  if (entry.mode === "120000") return "symlink";
  if (BINARY_EXTENSIONS.has(extensionOf(entry.path))) return "binary-extension";
  if ((entry.size ?? 0) > MAX_AUDIT_FILE_BYTES) return "oversized";
  return "text";
}

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

/** Basename of a repo-relative path. */
export function basenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
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

/** Literal file or directory-prefix match for an include scope. */
export function includeMatches(path: string, include: string): boolean {
  return include === "." || path === include || path.startsWith(`${include}/`);
}

/** Secret-path reason (null-safe: undefined when the path is not secret). */
export function secretPathReason(path: string): string | undefined {
  if (SECRET_PATH_EXEMPT_BASENAMES.has(basenameOf(path))) return undefined;
  const hit = SECRET_PATH_PATTERNS.find((rule) => pathMatchesGlob(path, rule.glob));
  return hit ? `secret path (${hit.reason})` : undefined;
}

export function isBinaryPath(path: string): boolean {
  return BINARY_EXTENSIONS.has(extensionOf(path));
}

/** Bytes of the diff body a reviewer could page: hunk headers plus raw lines. */
export function diffBodyBytes(file: Pick<FileDiff, "hunks">): number {
  let bytes = 0;
  for (const hunk of file.hunks) {
    bytes += Buffer.byteLength(hunk.header, "utf8") + 1;
    for (const line of hunk.lines) bytes += Buffer.byteLength(line, "utf8") + 1;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// change-mode gate
// ---------------------------------------------------------------------------

/** First gate that excludes a changed file; metadata stays visible regardless. */
export type ChangeFileGate =
  | "binary"
  | "secret"
  | "skip-pattern"
  | "oversized-diff"
  | "not-included";

export interface ChangeFileDecision {
  path: string;
  selected: boolean;
  /** The gate that excluded the file; absent when selected. */
  gate?: ChangeFileGate;
  /** Present exactly when `selected` is false. */
  reason?: string;
}

export interface ChangeFilterOptions {
  /**
   * Literal file or directory prefixes (audit `--path` semantics). A non-empty
   * set selects only matching files; a matching file is an explicit ask and
   * bypasses the skip/size gates below. B5 wires user rules in here; `find`
   * itself passes nothing today.
   */
  includePaths?: string[];
  /** Extra exclusion globs applied before the default policy (`--skip` semantics). */
  skipGlobs?: string[];
}

/** What a changed file is judged by: both sides of a rename, and its hunks. */
type FilterableFile = Pick<FileDiff, "path" | "oldPath" | "hunks">;

/**
 * The single pure decision function of the change-mode gate. Evaluation order
 * (roadmap B1/T2): binary -> secret paths -> include scope -> skip patterns ->
 * oversized single-file diff. Include bypasses the last two gates only;
 * binary and secret are non-overridable.
 */
export function selectChangeFile(file: FilterableFile, options: ChangeFilterOptions = {}): ChangeFileDecision {
  const paths = file.oldPath !== undefined && file.oldPath !== file.path ? [file.path, file.oldPath] : [file.path];
  const exclude = (gate: ChangeFileGate, reason: string): ChangeFileDecision => ({ path: file.path, selected: false, gate, reason });
  // Gate 1 — binary: there is no text to review, on either side of a rename.
  if (paths.some((path) => isBinaryPath(path))) {
    return exclude("binary", "binary file (diff bodies are not machine-reviewable text)");
  }
  // Gate 2 — secret paths: a credential that reaches a prompt cannot be
  // recalled, so nothing (include included) overrides this one.
  const secret = paths.map((path) => secretPathReason(path)).find((reason) => reason !== undefined);
  if (secret !== undefined) return exclude("secret", `${secret}; never sent to a model`);
  const includes = (options.includePaths ?? []).map(normalizeIncludePath);
  const included = includes.length === 0 ||
    includes.some((include) => paths.some((path) => includeMatches(path, include)));
  if (includes.length > 0 && !included) return exclude("not-included", "outside the include scope");
  // An explicitly included file is an explicit ask: it bypasses the remaining
  // two gates (skip patterns, diff size), and only those.
  if (includes.length === 0) {
    // Gate 3 — skip patterns (explicit --skip first, then the default policy).
    const skip = (options.skipGlobs ?? []).find((glob) => pathMatchesGlob(file.path, glob));
    if (skip !== undefined) return exclude("skip-pattern", `--skip ${skip}`);
    const policy = DEFAULT_SKIP_PATTERNS.find((rule) => pathMatchesGlob(file.path, rule.glob));
    if (policy !== undefined) return exclude("skip-pattern", `default policy: ${policy.reason}`);
    // Gate 4 — oversized single-file diff.
    const bytes = diffBodyBytes(file);
    if (bytes > MAX_DIFF_FILE_BYTES) {
      return exclude("oversized-diff", `oversized file diff (${bytes} bytes > ${MAX_DIFF_FILE_BYTES})`);
    }
  }
  return { path: file.path, selected: true };
}

/**
 * Apply the change-mode gate to a built change set. Excluded files keep every
 * metadata field (path/status/churn/language) but lose their hunks, so no code
 * path — `get_change`, the coverage ledger, or any future consumer of the
 * change set — can hand their diff body to a model. A change set with nothing
 * excluded is returned unchanged.
 */
export function applyChangeFilter(changeSet: ChangeSet, options: ChangeFilterOptions = {}): ChangeSet {
  let excluded = 0;
  const files = changeSet.files.map((file) => {
    const decision = selectChangeFile(file, options);
    if (decision.selected) return file;
    excluded += 1;
    return { ...file, hunks: [], excluded: true, excludedReason: decision.reason! };
  });
  return excluded === 0 ? changeSet : { ...changeSet, files };
}
