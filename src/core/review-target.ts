import type { ChangeSet } from "../changes/change-set.js";
import type { RepoSnapshot } from "../changes/snapshot.js";

/**
 * What one review run examines — the seam that keeps the supervisor a single
 * shared executor instead of one loop per review flavor.
 *
 * - change: attribution semantics. The defect must be introduced or unmasked
 *   by base..head; the verifier checks realness AND attribution.
 * - audit: current-state semantics. The defect must exist at the pinned
 *   snapshot; there is no base, no merge-base, and no change attribution.
 *   A root commit is a valid audit target.
 */
export type ReviewTarget =
  | { mode: "change"; changeSet: ChangeSet }
  | { mode: "audit"; snapshot: RepoSnapshot };
