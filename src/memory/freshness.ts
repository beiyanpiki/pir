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
 * - fresh: both hashes are known and match
 * - stale: file changed, or there is insufficient evidence to validate it
 * - invalid: file no longer exists
 */
export function classifyFreshness(input: {
  storedHash: string | null;
  currentHash: string | null;
  fileExists: boolean;
}): FreshnessState {
  if (!input.fileExists) return "invalid";
  if (!input.storedHash || !input.currentHash) return "stale";
  return input.storedHash === input.currentHash ? "fresh" : "stale";
}

/** No stale flag is not proof of freshness; tie provenance to the reviewed head. */
export function memoryFreshnessAnnotation(input: {
  headCommit: string;
  storedCommit: string | null;
  stale: boolean;
  changed?: boolean;
  seenOnly?: boolean;
}): string {
  const stored = input.storedCommit ? input.storedCommit.slice(0, 12) : "unknown";
  if (input.stale) return `(possibly stale; stored ${stored} — revalidate at reviewed head)`;
  if (input.headCommit && input.storedCommit === input.headCommit) {
    return input.seenOnly
      ? `(seen at reviewed head ${stored}; contracts still require validation)`
      : `(validated at reviewed head ${stored}; verify against code)`;
  }
  if (input.changed) return `(possibly stale: changed path; stored ${stored} — revalidate at reviewed head)`;
  return `(freshness unknown at reviewed head; stored ${stored} — revalidate)`;
}
