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

/** Which rule matched: the identity fingerprint, or a near-identical claim. */
export type DuplicateMatch = "fingerprint" | "claim";

/**
 * The overlap rule itself, read-only and pure, shared by the dedup pass and the
 * `record_candidate` duplicate hint (ADR 0004 Part III) so the two can never drift:
 * an exact fingerprint wins first; otherwise the candidates must share the same
 * entityKey, pass the category gate, and have claims at or above
 * `NEAR_DUP_THRESHOLD` similarity.
 *
 * `dropCategoryGate` is the cross-angle relaxation angle fan-out applies to candidates of
 * the same batch (parallel specialized sessions label one defect with their own
 * category). Prior-round knowledge is never relaxed, and the hint never uses it.
 */
export function duplicateMatch(
  candidate: CandidateFinding,
  existing: CandidateFinding,
  opts?: { dropCategoryGate?: boolean },
): DuplicateMatch | undefined {
  if (existing.identity.fingerprint === candidate.identity.fingerprint) return "fingerprint";
  if (!existing.entityKey && !candidate.entityKey) return undefined;
  if ((existing.entityKey ?? "") !== (candidate.entityKey ?? "")) return undefined;
  if (!opts?.dropCategoryGate && existing.category !== candidate.category) return undefined;
  return claimSimilarity(existing.identity.normalizedClaim, candidate.identity.normalizedClaim) >= NEAR_DUP_THRESHOLD ? "claim" : undefined;
}

/**
 * Deduplicate candidates within a round and against everything accumulated in
 * previous rounds. Exact fingerprint match first; then near-duplicate check on
 * (category, entity, claim similarity) so trivially reworded findings collapse.
 *
 * Cross-angle fan-out relaxes two rules between candidates of the same
 * batch: the category gate is dropped (parallel specialized sessions label the
 * same defect with their own category), and a more severe occurrence displaces
 * an already-accepted duplicate (a dropped P0 filed by a later angle must not
 * silently downgrade the run's output). Matching against prior-round knowledge
 * stays strict and never swaps — a `known` entry is the account of an earlier
 * round, not a batch peer (dogfood F-141).
 *
 * `seen` is append-only (dogfood F-143): a swap keeps the original anchor and
 * adds the survivor as a second anchor for the same defect group, so a later
 * paraphrase that only matches the original wording still collapses instead of
 * being re-reported. Every batch anchor carries a defect-group index; `of`
 * points at the group's CURRENT representative, so the supervisor's id map
 * stays one-hop even when a swap displaced an earlier survivor (dogfood
 * F-139 — a chain that still remains, e.g. a representative displaced after
 * the fact, resolves transitively on the supervisor side).
 */
export function deduplicateCandidates(
  candidates: CandidateFinding[],
  known: CandidateFinding[] = [],
  opts?: { crossAngle?: boolean },
): DedupResult {
  const crossAngle = opts?.crossAngle === true;
  const seen = [...known];
  const fresh: CandidateFinding[] = [];
  const duplicates: DedupResult["duplicates"] = [];
  // Defect-group index per batch anchor; known entries need none — they can
  // never swap, so `of` = the known entry itself is final for them.
  const groupOf = new Map<CandidateFinding, number>();

  for (const candidate of candidates) {
    let dup: CandidateFinding | undefined;
    let dupBatchPeer = false;
    for (const s of seen) {
      const batchPeer = crossAngle && !known.includes(s);
      if (!duplicateMatch(candidate, s, { dropCategoryGate: batchPeer })) continue;
      dup = s;
      dupBatchPeer = batchPeer;
      break;
    }
    if (!dup) {
      groupOf.set(candidate, fresh.length);
      fresh.push(candidate);
      seen.push(candidate);
      continue;
    }
    const repIndex = dupBatchPeer ? groupOf.get(dup)! : -1;
    const rep = repIndex >= 0 ? fresh[repIndex]! : dup;
    if (repIndex >= 0 && SEVERITY_ORDER[candidate.severity] < SEVERITY_ORDER[rep.severity]) {
      // The more severe occurrence survives (dogfood F-135): it takes the
      // group's slot in fresh (position preserved), joins seen as a second
      // anchor, and the displaced representative is recorded as dropped so
      // transcript id maps can follow it (dogfood F-143).
      duplicates.push({ candidate: rep, of: candidate });
      fresh[repIndex] = candidate;
      seen.push(candidate);
      groupOf.set(candidate, repIndex);
    } else {
      duplicates.push({ candidate, of: rep });
    }
  }
  return { fresh, duplicates };
}
