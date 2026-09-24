import path from "node:path";
import type { ChangeSet } from "../changes/change-set.js";
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

export function toolError(name: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `ERROR (${name}): ${message}`;
}

/** Resolve a repo-relative path, rejecting escapes outside the repository. */
export function safeResolve(repoRoot: string, relPath: string): string | null {
  if (path.isAbsolute(relPath)) return null;
  const normalized = relPath.split("/").filter((p) => p.length > 0 && p !== ".").join("/");
  if (normalized === "" || normalized.startsWith("..") || normalized.includes("/../")) return null;
  return path.resolve(repoRoot, normalized);
}
