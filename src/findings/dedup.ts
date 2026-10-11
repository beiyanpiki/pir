import { claimSimilarity } from "./identity.js";
import { SEVERITY_ORDER } from "./types.js";
import type { CandidateFinding } from "./types.js";

export interface DedupResult {
  /** New candidates not seen before. */
  fresh: CandidateFinding[];
  /** Candidates that duplicate an already-known one (same fingerprint or near-identical claim). */
  duplicates: Array<{ candidate: CandidateFinding; of: CandidateFinding }>;
}

const NEAR_DUP_THRESHOLD = 0.82;

/**
 * Deduplicate candidates within a round and against everything accumulated in
 * previous rounds. Exact fingerprint match first; then near-duplicate check on
 * (category, entity, claim similarity) so trivially reworded findings collapse.
 */
export function deduplicateCandidates(
  candidates: CandidateFinding[],
  known: CandidateFinding[] = [],
  opts?: { crossAngle?: boolean },
): DedupResult {
  const seen = [...known];
  const fresh: CandidateFinding[] = [];
  const duplicates: DedupResult["duplicates"] = [];

  for (const candidate of candidates) {
    const dup = seen.find((s) => {
      if (s.identity.fingerprint === candidate.identity.fingerprint) return true;
      if (!(!!s.entityKey || !!candidate.entityKey)) return false;
      if ((s.entityKey ?? "") !== (candidate.entityKey ?? "")) return false;
      // Cross-angle fan-out (F1): parallel specialized sessions label the
      // same defect with their own category, so the category gate is dropped
      // between batch candidates; matching against prior-round knowledge
      // stays strict.
      const batchPeer = opts?.crossAngle === true && !known.includes(s);
      if (!batchPeer && s.category !== candidate.category) return false;
      return claimSimilarity(s.identity.normalizedClaim, candidate.identity.normalizedClaim) >= NEAR_DUP_THRESHOLD;
    });
    if (dup) {
      // Cross-angle fan-out: parallel sessions file the same defect with
      // their own severity; the MORE SEVERE occurrence survives, not the
      // first-seen one (a dropped P0 filed by the second angle would
      // silently downgrade the run's output).
      if (opts?.crossAngle === true && SEVERITY_ORDER[candidate.severity] < SEVERITY_ORDER[dup.severity]) {
        duplicates.push({ candidate: dup, of: candidate });
        fresh[fresh.indexOf(dup)] = candidate;
        seen[seen.indexOf(dup)] = candidate;
      } else {
        duplicates.push({ candidate, of: dup });
      }
    } else {
      fresh.push(candidate);
      seen.push(candidate);
    }
  }
  return { fresh, duplicates };
}
