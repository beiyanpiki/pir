import path from "node:path";
import type { ChangeSet } from "../changes/change-set.js";
import { readFileAtCommit, resolveCommit } from "../changes/git.js";
import type { CodeMapProvider } from "../codemap/types.js";
import type { Memory } from "../memory/index.js";

/** Shared read-only context handed to every review tool. */
export interface ToolContext {
  repoRoot: string;
  headCommit: string;
  changeSet: ChangeSet;
  codeMap: CodeMapProvider;
  memory: Memory | null;
}

export type ReviewRevision = "head" | "base" | "merge-base";

// Legacy/bootstrap contexts may contain ref names. Resolve each once per context,
// never on each read (where a moving branch could silently change the evidence).
const revisions = new WeakMap<ToolContext, Map<ReviewRevision, Promise<string>>>();

export async function resolveReviewRevision(ctx: ToolContext, revision: ReviewRevision = "head"): Promise<string> {
  if (revision !== "head" && revision !== "base" && revision !== "merge-base") {
    throw new Error("revision must be head, base, or merge-base");
  }
  let cached = revisions.get(ctx);
  if (!cached) {
    cached = new Map();
    revisions.set(ctx, cached);
  }
  let commit = cached.get(revision);
  if (!commit) {
    const ref = revision === "head"
      ? ctx.changeSet.headCommit ?? ctx.headCommit
      : revision === "base"
        ? ctx.changeSet.baseCommit ?? ctx.changeSet.base
        : ctx.changeSet.mergeBase;
    commit = /^[a-f0-9]{40}([a-f0-9]{24})?$/i.test(ref)
      ? Promise.resolve(ref)
      : resolveCommit(ctx.repoRoot, ref);
    cached.set(revision, commit);
  }
  return commit;
}

/** Read only the explicitly requested path at the selected immutable snapshot. */
export async function readReviewFile(ctx: ToolContext, relPath: string, revision: ReviewRevision = "head"): Promise<{
  path: string; revision: ReviewRevision; commit: string; content: string | null;
}> {
  const absolute = safeResolve(ctx.repoRoot, relPath);
  if (!absolute) throw new Error("invalid repository-relative path");
  const normalized = path.relative(path.resolve(ctx.repoRoot), absolute).split(path.sep).join("/");
  const commit = await resolveReviewRevision(ctx, revision);
  const content = await readFileAtCommit(ctx.repoRoot, commit, normalized);
  return { path: normalized, revision, commit, content };
}

export function toolError(name: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `ERROR (${name}): ${message}`;
}

/** Resolve a repo-relative path; reject traversal even when it stays in the repo. */
export function safeResolve(repoRoot: string, relPath: string): string | null {
  if (typeof relPath !== "string" || relPath.includes("\0") ||
      path.isAbsolute(relPath) || path.win32.isAbsolute(relPath) ||
      /^[a-z]:/i.test(relPath) || relPath.split(/[\\/]/).includes("..")) return null;
  const normalized = relPath.split("/").filter((part) => part && part !== ".").join("/");
  if (!normalized) return null;
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, normalized);
  const relative = path.relative(root, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return resolved;
}
