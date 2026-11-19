import { getDiffPatch, getMergeBase } from "../changes/git.js";
import { parseUnifiedDiff, type FileDiff } from "../changes/diff.js";
import { executePirCommand } from "../cli/executor.js";
import { fetchPullRef, materializeRegistered, reviewDbPath } from "../app/repos.js";
import type { FindingView } from "../app/find.js";
import { mapFindingsToInlineComments, type GiteaInlineComment } from "./anchors.js";
import { partitionNewFindings } from "./dedupe.js";
import { PIR_REVIEW_MARKER, PIR_STATUS_MARKER } from "./policy.js";
import { renderInlineFindingBody, renderReviewBody, renderStatusBody, type GiteaStatusFindingSummary } from "./render.js";
import { resolveTriggerPolicy, type GiteaIntegrationConfig, type GiteaTriggerPolicy } from "./config.js";
import { GiteaApiError, type GiteaClient, type GiteaCommitStatusState } from "./client.js";
import type { GiteaPullRequestView } from "./webhook.js";
import { giteaStateKey, loadGiteaState, saveGiteaState, type GiteaPrState } from "./state.js";

/**
 * The Gitea PR review orchestration: one accepted webhook → status comment +
 * pending commit status → registered-repo fetch of the PR head → find +
 * summarize in a throwaway worktree → inline review + final status. The
 * runner is injectable so tests drive the whole flow without models; every
 * posting decision funnels through the pure render/policy/dedupe helpers.
 */

/** Commit status context line on the PR head SHA. */
export const GITEA_STATUS_CONTEXT = "pir/review";

/** Parsed JSON envelopes as `pir find --json` / `pir summarize --json` print them. */
export interface GiteaRunnerResult {
  findEnvelope: unknown;
  /** null when summarize failed or was skipped — the review degrades to no walkthrough. */
  summarizeEnvelope: unknown | null;
}

/** The review execution inside the worktree; injectable for model-free tests. */
export type GiteaReviewRunner = (
  worktree: string,
  args: { base: string; head: string; policy: GiteaTriggerPolicy; dbPath: string; onLog: (message: string) => void },
) => Promise<GiteaRunnerResult>;

export interface OrchestrateOptions {
  config: GiteaIntegrationConfig;
  configDir: string;
  client: GiteaClient;
  /** Registered clone backing this PR. Absent = the repo is not registered; the run fails with register guidance on the PR. */
  repoDir?: string;
  /** projectId of the registered clone (keys the memory db and repo dir). */
  projectId?: string;
  view: GiteaPullRequestView;
  /** Serve job id, for log lines only. */
  jobId: string;
  /** Progress sink (serve: job log + server log). */
  onLog?: (message: string) => void;
  runner?: GiteaReviewRunner;
  /** True when a newer webhook for the same PR already owns it; default: never superseded. */
  isSuperseded?: () => boolean;
  runUrl?: string;
  version: string;
}

export type GiteaOrchestrationOutcome =
  | { outcome: "reviewed"; detail: string }
  | { outcome: "superseded"; detail: string }
  | { outcome: "failed"; detail: string };

const nowISO = (): string => new Date().toISOString();

/** Cap and flatten an error message for a PR comment: one line, bounded, no HTML comments. */
function sanitizeErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const flat = raw.replace(/<!--[\s\S]*?-->/g, "").replace(/<!--/g, "").replace(/\s+/g, " ").trim();
  return flat.slice(0, 300);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `owner/name` → {owner, repo}; throws on a shape the Gitea API could not be addressed with. */
function splitFullName(fullName: string): { owner: string; repo: string } {
  const slash = fullName.indexOf("/");
  if (slash <= 0 || slash === fullName.length - 1) {
    throw new Error(`malformed repository full name: ${fullName}`);
  }
  return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
}

function envelopeData(envelope: unknown): Record<string, unknown> | null {
  if (typeof envelope !== "object" || envelope === null) return null;
  const data = (envelope as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
}

function extractFindings(envelope: unknown): FindingView[] {
  const data = envelopeData(envelope);
  const findings = data?.findings;
  return Array.isArray(findings) ? (findings as FindingView[]) : [];
}

function extractPlugins(envelope: unknown): string[] {
  const data = envelopeData(envelope);
  const plugins = data?.plugins;
  return Array.isArray(plugins) ? plugins.filter((p): p is string => typeof p === "string") : [];
}

/** `path:line` of the first anchor, path-only without a line, em-dash when anchorless. */
function anchorLocation(finding: FindingView): string {
  const anchor = finding.anchors?.[0];
  if (!anchor) return "—";
  return typeof anchor.startLine === "number" ? `${anchor.path}:${anchor.startLine}` : anchor.path;
}

function findingSummaryRow(finding: FindingView): GiteaStatusFindingSummary {
  return {
    displayId: String(finding.displayId ?? ""),
    severity: String(finding.severity ?? ""),
    category: String(finding.category ?? ""),
    anchor: anchorLocation(finding),
    claim: String(finding.claim ?? ""),
  };
}

/** Walkthrough from a summarize envelope; null when absent or malformed (degraded run). */
function extractWalkthrough(envelope: unknown | null): { summary: string; riskAreas: string[] } | null {
  if (envelope === null) return null;
  const data = envelopeData(envelope);
  const summary = data?.summary;
  if (typeof summary !== "string" || !summary.trim()) return null;
  const riskAreas = Array.isArray(data?.riskAreas)
    ? (data!.riskAreas as unknown[]).filter((a): a is string => typeof a === "string")
    : [];
  return { summary, riskAreas };
}

function extractStats(envelope: unknown | null): { files: number; insertions: number; deletions: number } | null {
  if (envelope === null) return null;
  const data = envelopeData(envelope);
  const stats = data?.stats;
  if (
    typeof stats !== "object" ||
    stats === null ||
    typeof (stats as Record<string, unknown>).files !== "number" ||
    typeof (stats as Record<string, unknown>).insertions !== "number" ||
    typeof (stats as Record<string, unknown>).deletions !== "number"
  ) {
    return null;
  }
  const s = stats as { files: number; insertions: number; deletions: number };
  return { files: s.files, insertions: s.insertions, deletions: s.deletions };
}

/** Diff-derived fallback when no summarize envelope exists: the same counts `pir summarize` reports. */
function statsFromFiles(files: FileDiff[]): { files: number; insertions: number; deletions: number } {
  return {
    files: files.length,
    insertions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

function severityCounts(findings: FindingView[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  }
  return counts;
}

function commitStatusInput(
  state: GiteaCommitStatusState,
  description: string,
  runUrl?: string,
): { state: GiteaCommitStatusState; context: string; description: string; target_url?: string } {
  return { state, context: GITEA_STATUS_CONTEXT, description, ...(runUrl ? { target_url: runUrl } : {}) };
}

/**
 * Default runner: two in-process executor calls against the materialized
 * worktree, with the project's central db. `find` must succeed (exit 0;
 * `--fail-on` defaults to none, so findings never raise the code — exit 3
 * means an incomplete run and 2 a usage error, both real failures). A
 * `summarize` failure only degrades the review: walkthrough turns null and
 * the run continues.
 */
export const defaultGiteaReviewRunner: GiteaReviewRunner = async (worktree, args) => {
  const modelArgs = args.policy.model ? ["--model", args.policy.model] : [];
  const execOptions = { cwdGuard: worktree, dbPath: args.dbPath, onLog: args.onLog };

  const find = await executePirCommand(
    ["--cwd", worktree, "find", "--base", args.base, "--head", args.head, "--json", "--max-findings", String(args.policy.maxFindings), ...modelArgs],
    execOptions,
  );
  if (find.code !== 0) {
    let detail = "";
    try {
      const parsed = envelopeData(JSON.parse(find.output));
      if (typeof parsed?.stoppedBecause === "string" && parsed.stoppedBecause) detail = `: ${parsed.stoppedBecause}`;
    } catch {
      // not JSON — the exit code is the whole story
    }
    throw new Error(`find exited with code ${find.code}${detail}`);
  }
  const findEnvelope = JSON.parse(find.output);

  let summarizeEnvelope: unknown | null = null;
  try {
    const summarize = await executePirCommand(
      ["--cwd", worktree, "summarize", "--base", args.base, "--head", args.head, "--json", ...modelArgs],
      execOptions,
    );
    if (summarize.code !== 0) {
      args.onLog(`summarize exited with code ${summarize.code} — continuing without a walkthrough`);
    } else {
      summarizeEnvelope = JSON.parse(summarize.output);
    }
  } catch (err) {
    args.onLog(`summarize failed (${sanitizeErrorText(err)}) — continuing without a walkthrough`);
  }
  return { findEnvelope, summarizeEnvelope };
};

/**
 * Run one PR review end to end. Every step after the started status is
 * failure-reported on the PR (status comment + error commit status) — a
 * webhook must never leave the PR silent. Returns the outcome for the job
 * record; never throws.
 */
export async function orchestrateGiteaReview(options: OrchestrateOptions): Promise<GiteaOrchestrationOutcome> {
  const { config, configDir, client, view } = options;
  const log = options.onLog ?? ((): void => {});
  const lang = config.commentLanguage;
  const runUrl = options.runUrl;

  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = splitFullName(view.repoFullName));
  } catch (err) {
    return { outcome: "failed", detail: errorMessage(err) };
  }
  const marker = PIR_STATUS_MARKER(owner, repo, view.number);
  const stateKey = giteaStateKey(view.repoFullName, view.number);
  const statusBase = { lang, marker, repoFullName: view.repoFullName, number: view.number, headSha: view.headSha, baseRef: view.baseRef };

  let statusCommentId: number | null = null;
  try {
    // 1. Started status: upsert the per-PR status comment, then the pending
    // commit status, then persist the comment id so even a crashed run's
    // successor edits this comment instead of posting a second one.
    const state = loadGiteaState(configDir);
    const previous: GiteaPrState | null = state.prs[stateKey] ?? null;
    const startedBody = renderStatusBody({ ...statusBase, phase: "started", runUrl });
    const existing = (await client.listIssueComments(owner, repo, view.number)).find((comment) =>
      (comment.body ?? "").includes(marker),
    );
    if (existing) {
      await client.editIssueComment(owner, repo, existing.id, startedBody);
      statusCommentId = existing.id;
    } else {
      statusCommentId = (await client.createIssueComment(owner, repo, view.number, startedBody)).id;
    }
    await client.createCommitStatus(owner, repo, view.headSha, commitStatusInput("pending", "pir review in progress", runUrl));
    saveGiteaState(configDir, {
      prs: {
        ...state.prs,
        [stateKey]: {
          lastHeadSha: previous?.lastHeadSha ?? "",
          reviewId: previous?.reviewId ?? null,
          statusCommentId,
          lastPostedFingerprints: previous?.lastPostedFingerprints ?? [],
          updatedAt: nowISO(),
        },
      },
    });
    log(`status comment up (#${statusCommentId}), commit status pending on ${view.headSha.slice(0, 10)}`);

    // 2. Superseded: a newer webhook for this PR already owns it — post
    // nothing further; that newer run reports the final state.
    if (options.isSuperseded?.()) {
      log(`superseded by a newer head — job ${options.jobId} stands down`);
      return { outcome: "superseded", detail: `superseded by a newer head on ${view.repoFullName}#${view.number}` };
    }

    // 3. Materialize: the PR head via the stable pull ref (fetched first —
    // its refspec only brings the pull ref), then materializeRegistered's
    // `fetch --all` refreshes the base branches the diff needs.
    if (!options.repoDir || !options.projectId) {
      throw new Error(
        `repository ${view.cloneUrl} is not registered with this pir server — the operator must register it (\`pir repos add ${view.cloneUrl}\`) before PRs can be reviewed`,
      );
    }
    const policy = resolveTriggerPolicy(config, view.repoFullName);
    const runner = options.runner ?? defaultGiteaReviewRunner;
    const dbPath = reviewDbPath(options.projectId);
    const fetchedHead = await fetchPullRef(options.repoDir, view.number);
    const materialized = await materializeRegistered(options.repoDir, options.projectId, { branch: fetchedHead, noFetch: false });
    log(`worktree materialized at ${materialized.headCommit.slice(0, 10)}`);

    let runResult: GiteaRunnerResult;
    let files: FileDiff[];
    let toPost: FindingView[];
    let unchanged: FindingView[];
    let demoted: FindingView[];
    let mappedInline: GiteaInlineComment[];
    try {
      if (materialized.headCommit !== view.headSha) {
        throw new Error(
          `stale webhook payload: refs/pull/${view.number}/head is ${materialized.headCommit.slice(0, 10)} but the payload claims head ${view.headSha.slice(0, 10)} — a newer push will arrive`,
        );
      }

      // 4. Run find + summarize in the worktree.
      runResult = await runner(materialized.worktree, { base: view.baseSha, head: view.headSha, policy, dbPath, onLog: log });

      // 5. Map: the diff exactly as find computes it (merge-base → patch →
      // parse), in the same worktree, then dedupe + inline anchoring.
      const mergeBase = await getMergeBase(materialized.worktree, view.baseSha, view.headSha);
      files = parseUnifiedDiff(await getDiffPatch(materialized.worktree, mergeBase, view.headSha)).files;
      const partition = partitionNewFindings(extractFindings(runResult.findEnvelope), previous?.lastPostedFingerprints ?? []);
      toPost = partition.toPost;
      unchanged = partition.unchanged;
      ({ inline: mappedInline, demoted } = mapFindingsToInlineComments(toPost, files));
    } finally {
      await materialized.cleanup();
    }

    // 6. Publish: delete-and-repost keeps exactly one pir review per run.
    if (previous?.reviewId != null) {
      try {
        await client.deleteReview(owner, repo, view.number, previous.reviewId);
      } catch (err) {
        if (err instanceof GiteaApiError && err.status === 404) {
          // already gone — nothing to clean up
        } else {
          log(`could not delete previous review ${previous.reviewId}: ${sanitizeErrorText(err)}`);
        }
      }
    }
    const walkthrough = extractWalkthrough(runResult.summarizeEnvelope);
    const stats = extractStats(runResult.summarizeEnvelope) ?? statsFromFiles(files);
    const plugins = extractPlugins(runResult.findEnvelope);
    const review = await client.createReview(owner, repo, view.number, {
      body: renderReviewBody({
        lang,
        marker: PIR_REVIEW_MARKER,
        repoFullName: view.repoFullName,
        number: view.number,
        title: view.title,
        baseRef: view.baseRef,
        baseSha: view.baseSha,
        headRef: view.headRef,
        headSha: view.headSha,
        stats,
        plugins,
        walkthrough,
        findings: { inline: mappedInline, demoted, unchangedCount: unchanged.length },
        runUrl,
        version: options.version,
      }),
      event: "COMMENT",
      comments: mappedInline.map((comment) => ({
        body: renderInlineFindingBody({ finding: comment.finding, lang, location: `${comment.path}:${comment.new_position}`, runUrl }),
        path: comment.path,
        new_position: comment.new_position,
      })),
    });
    log(`review ${review.id} posted: ${mappedInline.length} inline, ${demoted.length} demoted, ${unchanged.length} unchanged`);

    // 7. Final status: done comment (findings table when anything is relevant,
    // clean variant only when nothing was posted AND nothing was unchanged),
    // final commit status, durable state.
    const relevant = [...toPost, ...unchanged];
    await client.editIssueComment(
      owner,
      repo,
      statusCommentId,
      renderStatusBody({
        ...statusBase,
        phase: "done",
        findingsSummary: relevant.map(findingSummaryRow),
        severityCounts: severityCounts(relevant),
        runUrl,
      }),
    );
    await client.createCommitStatus(
      owner,
      repo,
      view.headSha,
      commitStatusInput(
        relevant.length > 0 ? config.statusOnFindings : "success",
        relevant.length > 0 ? `${relevant.length} finding(s)` : "no verified findings",
        runUrl,
      ),
    );
    saveGiteaState(configDir, {
      prs: {
        ...state.prs,
        [stateKey]: {
          lastHeadSha: view.headSha,
          reviewId: review.id,
          statusCommentId,
          lastPostedFingerprints: [...unchanged.map((f) => f.fingerprint), ...toPost.map((f) => f.fingerprint)],
          updatedAt: nowISO(),
        },
      },
    });
    return {
      outcome: "reviewed",
      detail: `${toPost.length} new finding(s), ${unchanged.length} unchanged, ${demoted.length} demoted (review ${review.id})`,
    };
  } catch (err) {
    // 8. Failure path: best-effort reporting on the PR, then the job fails
    // with the sanitized detail. Never rethrow — the caller settles the job
    // from the outcome.
    const detail = sanitizeErrorText(err);
    log(`run failed: ${detail}`);
    try {
      if (statusCommentId !== null) {
        await client.editIssueComment(
          owner,
          repo,
          statusCommentId,
          renderStatusBody({ ...statusBase, phase: "failed", error: detail, runUrl }),
        );
      }
      await client.createCommitStatus(owner, repo, view.headSha, commitStatusInput("error", "pir review failed", runUrl));
    } catch (reportErr) {
      log(`failure reporting failed too: ${sanitizeErrorText(reportErr)}`);
    }
    return { outcome: "failed", detail };
  }
}
