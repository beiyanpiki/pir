import type { GiteaTriggerPolicy } from "./config.js";

/**
 * Trigger policy evaluation — pure, no I/O. The endpoint that lands later
 * feeds the parsed webhook view plus the resolved per-repo policy in and gets
 * a machine-code decision out, so every skip rule is table-testable here.
 */

/** HTML marker identifying pir's own review comment, used to find/replace it on re-review. */
export const PIR_REVIEW_MARKER = "<!-- pir:review v1 -->";

/** HTML marker identifying pir's status comment for one PR, so later runs edit instead of duplicating. */
export function PIR_STATUS_MARKER(owner: string, repo: string, number: number): string {
  return `<!-- pir:status ${owner}/${repo}#${number} v1 -->`;
}

/**
 * Case-insensitive prefix match ignoring leading whitespace: a title like
 * "  wip: fix thing" counts as work-in-progress under the WIP: prefix.
 */
export function isWipTitle(title: string, prefixes: string[]): boolean {
  const normalized = title.trimStart().toLowerCase();
  return prefixes.some((prefix) => {
    const marker = prefix.trim().toLowerCase();
    return marker !== "" && normalized.startsWith(marker);
  });
}

/** Everything evaluateTrigger needs from one webhook, already normalized by the payload parser. */
export interface GiteaTriggerInput {
  event: string;
  action: string;
  title: string;
  /** Gitea draft PRs are work-in-progress by definition. */
  draft?: boolean;
  baseRef: string;
  labels: string[];
  senderLogin: string;
  /** The bot's own account, to break the webhook feedback loop; absent = no check. */
  botLogin?: string;
}

/**
 * Decision with a machine-readable reason: `"<code>: <human phrase>"` — the
 * code is everything before the first colon. Codes: accepted,
 * unwatched-event, unwatched-action, wip, base-branch, skip-label,
 * bot-sender.
 */
export interface GiteaTriggerDecision {
  accepted: boolean;
  reason: string;
}

/** pull_request actions that (can) start a review. */
const WATCHED_PR_ACTIONS = new Set(["opened", "reopened", "edited"]);

function no(code: string, phrase: string): GiteaTriggerDecision {
  return { accepted: false, reason: `${code}: ${phrase}` };
}

/**
 * Should this webhook start a review run? Watched: `pull_request` with action
 * opened/reopened/edited — edited only once the WIP marker came OFF the title
 * (that edit is the "ready for review" signal) — and `pull_request_sync`
 * (pushes to an open PR; action is always `synchronized`, the event itself is
 * authoritative). Skip rules apply in a fixed order so reasons are stable.
 */
export function evaluateTrigger(input: GiteaTriggerInput, policy: GiteaTriggerPolicy): GiteaTriggerDecision {
  if (input.event !== "pull_request" && input.event !== "pull_request_sync") {
    return no("unwatched-event", `event ${input.event} is not a pull request trigger`);
  }
  if (input.event === "pull_request") {
    if (!WATCHED_PR_ACTIONS.has(input.action)) {
      return no("unwatched-action", `pull_request action ${input.action} does not start a review`);
    }
    // An edited PR that still carries a WIP marker is not a review request;
    // the edit that REMOVES the marker is.
    if (input.action === "edited" && isWipTitle(input.title, policy.wipPrefixes)) {
      return no("unwatched-action", "edited while the title still matches a WIP prefix");
    }
  }
  if (input.draft === true || isWipTitle(input.title, policy.wipPrefixes)) {
    return no("wip", "title matches a WIP prefix or the PR is a draft");
  }
  // An empty allowlist means every base branch is watched.
  if (policy.baseBranches.length > 0 && !policy.baseBranches.includes(input.baseRef)) {
    return no("base-branch", `base ${input.baseRef} is not in the watched baseBranches`);
  }
  if (input.labels.some((label) => policy.skipLabels.includes(label))) {
    return no("skip-label", `PR carries a skipLabels label (${input.labels.join(", ")})`);
  }
  if (input.botLogin !== undefined && input.senderLogin === input.botLogin) {
    return no("bot-sender", "webhook was triggered by the bot's own account");
  }
  return { accepted: true, reason: "accepted: watched pull request trigger, no skip rule matched" };
}
