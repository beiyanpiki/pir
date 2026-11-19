import { REPORTED_STATUSES } from "../app/output.js";
import type { FindingView } from "../app/find.js";

/**
 * Cross-run suppression for the Gitea PR integration: on re-review, a
 * finding whose fingerprint was already posted on an earlier run of the
 * same PR is not reposted (the developer has seen it; the state file keeps
 * the posted fingerprints). Pure — the caller feeds this run's findings
 * plus `lastPostedFingerprints` from GiteaPrState.
 */

export interface DedupePartition {
  /** Reported findings not seen on any earlier run — post these. */
  toPost: FindingView[];
  /** Reported findings whose fingerprint was already posted — count only, do not repost. */
  unchanged: FindingView[];
}

/**
 * Split this run's findings by fingerprint against the posted set. Only
 * reported statuses (confirmed/uncertain) participate: rejected, expected,
 * and false-positive rows never reach a PR, so they are dropped from BOTH
 * lists rather than reported as "unchanged".
 */
export function partitionNewFindings(findings: FindingView[], postedFingerprints: string[]): DedupePartition {
  const posted = new Set(postedFingerprints);
  const toPost: FindingView[] = [];
  const unchanged: FindingView[] = [];
  for (const finding of findings) {
    if (!REPORTED_STATUSES.has(finding.status)) continue;
    if (posted.has(finding.fingerprint)) unchanged.push(finding);
    else toPost.push(finding);
  }
  return { toPost, unchanged };
}
