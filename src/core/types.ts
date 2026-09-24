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

/** Parse a TEXT column that stores a JSON object. */
export function parseJsonObject<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
