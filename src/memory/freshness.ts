import { readFileAtCommit } from "../changes/git.js";
import { sha256, type FreshnessState } from "../core/types.js";

/**
 * File-content hash at a commit. Symbol-level granularity would need a parser;
 * v1 tracks hashes per file, which is the unit git gives us for free.
 */
export async function fileHashAtCommit(
  repoRoot: string,
  commit: string,
  path: string,
): Promise<string | null> {
  const content = await readFileAtCommit(repoRoot, commit, path);
  if (content === null) return null;
  return sha256(content);
}

export async function hashFilesAtCommit(
  repoRoot: string,
  commit: string,
  paths: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    paths.map(async (p) => {
      const hash = await fileHashAtCommit(repoRoot, commit, p);
      if (hash !== null) out.set(p, hash);
    }),
  );
  return out;
}

/**
 * Classify a memory record against the current code state.
 * - fresh: hash matches (or no hash tracked yet)
 * - stale: file changed since the memory was validated
 * - invalid: file no longer exists
 */
export function classifyFreshness(input: {
  storedHash: string | null;
  currentHash: string | null;
  fileExists: boolean;
}): FreshnessState {
  if (!input.fileExists) return "invalid";
  if (!input.storedHash || !input.currentHash) return "fresh";
  return input.storedHash === input.currentHash ? "fresh" : "stale";
}
