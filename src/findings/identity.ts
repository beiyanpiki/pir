import { sha256 } from "../core/types.js";
import type { CandidateFinding, FindingIdentity } from "./types.js";

/**
 * Normalize free text for fingerprinting: lowercase, strip punctuation and
 * symbol separators, collapse whitespace. Keeps identifiers recognizable
 * ("retry_count" ~ "retry count") without being sensitive to formatting.
 */
export function normalizeClaimText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[_*#]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildIdentity(input: {
  featureKey?: string;
  entityKey?: string;
  category: string;
  claim: string;
  trigger: string;
}): FindingIdentity {
  const featureKey = input.featureKey ?? "";
  const entityKey = input.entityKey ?? "";
  const category = normalizeClaimText(input.category);
  const normalizedClaim = normalizeClaimText(input.claim);
  const normalizedTrigger = normalizeClaimText(input.trigger);
  const fingerprint = sha256([featureKey, entityKey, category, normalizedClaim, normalizedTrigger].join("\u0000"));
  return { fingerprint, featureKey, entityKey, category, normalizedTrigger, normalizedClaim };
}

export function withIdentity(candidate: Omit<CandidateFinding, "identity">): CandidateFinding {
  return { ...candidate, identity: buildIdentity(candidate) };
}

/**
 * Coarse similarity between two identity claims based on token Jaccard.
 * Used for near-duplicate detection when fingerprints differ slightly.
 */
export function claimSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeClaimText(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeClaimText(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}
