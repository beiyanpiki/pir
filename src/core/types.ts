import { createHash } from "node:crypto";

/** A location in the repository source tree. Lines are 1-based. */
export interface SourceAnchor {
  path: string;
  startLine: number;
  endLine?: number;
}

/** Provenance and trust level of a memory record. */
export type MemorySource = "user_explicit" | "verified_fix" | "agent_summary" | "derived";

/** Only these sources may be used as evidence to suppress a finding. */
export const SUPPRESSION_SOURCES: readonly MemorySource[] = ["user_explicit", "verified_fix"];

/**
 * The agent-generated portion of a memory record's array fields as of the last
 * bootstrap/refresh. Entries in these arrays that are not listed here were
 * added by the user (`pir remember`, feedback) and must survive re-bootstrap;
 * the listed ones are replaced wholesale by the next agent draft.
 */
export type GeneratedArrays = Partial<
  Record<"responsibilities" | "invariants" | "conventions" | "riskAreas" | "featureKeys", string[]>
>;

export type FreshnessState = "fresh" | "stale" | "invalid";

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Parse a TEXT column that stores a JSON array. */
export function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Parse an `agent_fields` column; anything malformed degrades to "no generated set recorded". */
export function parseGeneratedArrays(value: string | null | undefined): GeneratedArrays {
  const parsed = parseJsonObject<Record<string, unknown>>(value);
  if (!parsed) return {};
  const out: GeneratedArrays = {};
  for (const field of ["responsibilities", "invariants", "conventions", "riskAreas", "featureKeys"] as const) {
    const list = parsed[field];
    if (Array.isArray(list) && list.every((entry) => typeof entry === "string")) out[field] = [...list];
  }
  return out;
}

/** Parse a TEXT column that stores a JSON object. */
export function parseJsonObject<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
