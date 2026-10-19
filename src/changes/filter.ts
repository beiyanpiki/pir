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
