import { buildChangeSet, type ChangeSet } from "../changes/change-set.js";
import { getHeadCommit } from "../changes/git.js";
import type { CodeMapProvider } from "../codemap/types.js";
import { deduplicateCandidates } from "../findings/dedup.js";
import { SEVERITY_ORDER, type MemoryMatch, type UncertaintyReason, type VerifierResult } from "../findings/types.js";
import type { Memory } from "../memory/index.js";
import { buildMemoryPack, matchIssueHistory } from "../memory/retrieval.js";
import { runTranscriptDir, transcriptsEnabled } from "../agents/transcripts.js";
import type { AgentSessionFactory, SessionUsage } from "../agents/types.js";
import { ReviewerRoundError, runReviewerRound, type ReviewerRoundResult } from "../agents/reviewer.js";
import { runVerifier } from "../agents/verifier.js";
import type { ToolContext } from "../tools/context.js";
import { Budget } from "./budget.js";
import { calculateInformationGain, shouldStop } from "./convergence.js";
import { expandFrontier } from "./frontier.js";
import { applyVerdict, createReviewState, reportedCount, type RoundInfo } from "./review-state.js";
import path from "node:path";

export interface FindOptions {
  base?: string;
  head?: string;
  maxRounds?: number;
  maxTokens?: number;
  maxWallClockMs?: number;
  model?: string;
  maxVerificationsPerRound?: number;
  /** Confirmed and uncertain reports count; rejected and pending candidates do not. */
  maxFindings?: number;
}

export interface FindEvent {
  type: "round-start" | "round-end" | "verify" | "info" | "done";
  round?: number;
  message: string;
}

export interface FindDeps {
  repoRoot: string;
  memory: Memory;
  codeMap: CodeMapProvider;
  factory: AgentSessionFactory;
  options?: FindOptions;
  onProgress?: (event: FindEvent) => void;
}

export interface FindOutcome {
  base: string;
  head: string;
  changeSet: ChangeSet;
  rounds: RoundInfo[];
  findings: Array<ReturnType<Memory["findings"]["insert"]>>;
  pendingFindings: Array<ReturnType<Memory["findings"]["insert"]>>;
  pendingCandidates: number;
  incomplete: boolean;
  verificationErrors: number;
  uncertaintyReasons: Partial<Record<UncertaintyReason, number>>;
  stoppedBecause: string;
  estimatedTokens: number;
  usage?: SessionUsage;
  usageComplete: boolean;
  durationMs: number;
  memoryPackTokens: number;
  runId: string;
  maxFindings: number;
  transcriptDir?: string;
}

const DEFAULT_MAX_ROUNDS = 2;
const DEFAULT_MAX_TOKENS = 400_000;
const DEFAULT_MAX_VERIFICATIONS = 8;
const DEFAULT_MAX_FINDINGS = 10;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export async function findIssues(deps: FindDeps): Promise<FindOutcome> {
  const options = deps.options ?? {};
  const maxRounds = positiveInteger(options.maxRounds ?? DEFAULT_MAX_ROUNDS, "maxRounds");
  const maxFindings = positiveInteger(options.maxFindings ?? DEFAULT_MAX_FINDINGS, "maxFindings");
  const maxVerifications = positiveInteger(options.maxVerificationsPerRound ?? DEFAULT_MAX_VERIFICATIONS, "maxVerificationsPerRound");
  const budget = new Budget({
    maxRounds,
    maxTokens: positiveInteger(options.maxTokens ?? DEFAULT_MAX_TOKENS, "maxTokens"),
    maxWallClockMs: options.maxWallClockMs === undefined ? undefined : positiveInteger(options.maxWallClockMs, "maxWallClockMs"),
  });

  const requestedHead = options.head ?? (await getHeadCommit(deps.repoRoot));
  const changeSet = await buildChangeSet(deps.repoRoot, options.base ?? `${requestedHead}^`, requestedHead);
  const base = changeSet.baseCommit ?? changeSet.base;
  const head = changeSet.headCommit ?? changeSet.head;
  const run = deps.memory.findings.createRun(base, head);
  const state = createReviewState(base, head, maxRounds);
  const transcriptDir = transcriptsEnabled() ? runTranscriptDir(deps.memory.store.dbPath, run.id) : undefined;
  if (transcriptDir) deps.onProgress?.({ type: "info", message: `transcripts: ${transcriptDir}` });

  const memoryPack = buildMemoryPack(deps.memory, {
    changedPaths: changeSet.files.flatMap((f) => f.oldPath ? [f.path, f.oldPath] : [f.path]),
    featureKeys: [], entityKeys: [], headCommit: head,
  });
  const toolCtx: ToolContext = { repoRoot: deps.repoRoot, headCommit: head, changeSet, codeMap: deps.codeMap, memory: deps.memory };
  let needsReview = true;
  let verificationErrors = 0;
  const uncertaintyReasons: Partial<Record<UncertaintyReason, number>> = {};

  try {
    while (true) {
      if (reportedCount(state) >= maxFindings) {
        state.stoppedBecause = `max findings reached (${maxFindings})`;
        break;
      }
      if (!needsReview && state.pending.length === 0) {
        state.stoppedBecause = "reviewer signaled completion";
        break;
      }
      const stop = shouldStop(state, budget);
      if (stop.stop) { state.stoppedBecause = stop.reason!; break; }
      state.round += 1;
      deps.onProgress?.({ type: "round-start", round: state.round, message: `review round ${state.round}${state.pending.length ? " (pending verification)" : ""}` });

      let result: ReviewerRoundResult | undefined;
      let freshCount = 0;
      // Drain existing work before paying for another discovery session.
      if (state.pending.length === 0 && needsReview) {
        result = await runReviewerRound({
          factory: deps.factory, ctx: toolCtx, memoryPack: memoryPack.text, round: state.round,
          maxRounds, maxFindings, findingsRemaining: maxFindings - reportedCount(state),
          verificationCapacity: maxVerifications, focus: state.focus, priorSummary: state.priorSummary,
          investigationFeedback: state.investigationFeedback, model: options.model,
          transcriptFile: transcriptDir ? path.join(transcriptDir, `reviewer-r${state.round}.json`) : undefined,
        });
        budget.chargeSession(result.usage, memoryPack.text, result.assistantText, result.summary);
        if (!result.submitted) throw new Error("reviewer did not call finish_round");
        const dedup = deduplicateCandidates(result.candidates, state.known);
        freshCount = dedup.fresh.length;
        state.known.push(...dedup.fresh);
        state.pending.push(...dedup.fresh);
        state.pending.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
        needsReview = result.needsMoreRounds;
        state.priorSummary = [
          result.summary,
          ...(result.coverage ?? []).map((s) => `Covered: ${s}`),
          ...(result.unresolvedQuestions ?? []).map((s) => `Unresolved: ${s}`),
          ...(result.blockers ?? []).map((s) => `Blocked: ${s}`),
        ].join("\n").slice(0, 6000);
      }

      let confirmed = 0;
      let rejected = 0;
      let uncertain = 0;
      let suppressed = 0;
      let verifiedCount = 0;
      const feedbackVerdicts: VerifierResult[] = [];
      while (state.pending.length > 0 && verifiedCount < maxVerifications && reportedCount(state) < maxFindings && !budget.exhausted()) {
        const candidate = state.pending[0]!;
        deps.onProgress?.({ type: "verify", round: state.round, message: `verifying ${candidate.displayId}: ${candidate.title}` });
        const matches = matchIssueHistory(deps.memory, {
          fingerprint: candidate.identity.fingerprint, featureKey: candidate.identity.featureKey || undefined,
          entityKey: candidate.identity.entityKey || undefined, normalizedClaim: candidate.identity.normalizedClaim,
          category: candidate.category, anchorPaths: [...new Set(candidate.anchors.map((a) => a.path))],
        });
        const memoryMatches: MemoryMatch[] = matches.map((m) => ({
          memoryId: m.id, decision: m.decision, scope: m.scope, source: m.source, claim: m.claim,
          rationale: m.rationale, trigger: m.trigger, stale: m.stale,
        }));
        const verdict = await runVerifier({
          factory: deps.factory, ctx: toolCtx, candidate, priorDecisions: memoryMatches, model: options.model,
          transcriptFile: transcriptDir ? path.join(transcriptDir, `verifier-r${state.round}-${candidate.displayId ?? candidate.identity.fingerprint.slice(0, 8)}.json`) : undefined,
        });
        budget.chargeSession(verdict.usage, verdict.rationale);
        state.pending.shift();
        verifiedCount += 1;
        if (verdict.verdict === "uncertain") {
          const reason = verdict.uncertaintyReason ?? "missing-evidence";
          uncertaintyReasons[reason] = (uncertaintyReasons[reason] ?? 0) + 1;
          if (reason === "provider-error" || reason === "missing-verdict") verificationErrors += 1;
        }
        const verified = applyVerdict(state, candidate, verdict, memoryMatches);
        if (verified.status === "confirmed") confirmed += 1;
        else if (verified.status === "rejected") rejected += 1;
        else if (verified.status === "uncertain") uncertain += 1;
        else suppressed += 1;
        // Historical decisions remain verifier-only, including their rationale.
        if (memoryMatches.length === 0 && verdict.codeFeedback) {
          const feedback = `${candidate.displayId}: ${verdict.codeFeedback.slice(0, 1000)}`;
          state.investigationFeedback = [...state.investigationFeedback, feedback].slice(-12);
          feedbackVerdicts.push({ ...verdict, codeFeedback: feedback });
        }
      }

      state.rounds.push({
        round: state.round, candidates: result?.candidates.length ?? 0, fresh: freshCount,
        confirmed, rejected, uncertain, suppressed, pending: state.pending.length,
        reviewerRan: result !== undefined, summary: result?.summary ?? "Verified queued candidates",
      });
      if (result) expandFrontier(state, result, feedbackVerdicts);
      else if (feedbackVerdicts.length) {
        state.focus = [...new Set([...feedbackVerdicts.filter((v) => v.verdict === "uncertain").map((v) => v.codeFeedback!), ...state.focus])].slice(0, 16);
      }
      calculateInformationGain(state, freshCount, verifiedCount);
      deps.onProgress?.({ type: "round-end", round: state.round, message: `round ${state.round}: ${freshCount} new, ${confirmed} confirmed, ${rejected} rejected, ${uncertain} uncertain, ${state.pending.length} pending` });
    }
  } catch (error) {
    if (error instanceof ReviewerRoundError) {
      const recovered = deduplicateCandidates(error.candidates, state.known).fresh;
      state.known.push(...recovered);
      state.pending.push(...recovered);
      budget.chargeSession(error.usage, error.message);
    }
    for (const finding of state.verified) deps.memory.findings.insert(finding, run.id);
    for (const candidate of state.pending) deps.memory.findings.insert({ ...candidate, status: "candidate", memoryMatches: [] }, run.id);
    deps.memory.findings.finishRun(run.id, {
      rounds: state.round, candidates: state.known.length, confirmed: state.verified.filter((f) => f.status === "confirmed").length,
      rejected: state.verified.filter((f) => f.status === "rejected").length, uncertain: state.verified.filter((f) => f.status === "uncertain").length,
      status: "failed", notes: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const incomplete = state.pending.length > 0 || verificationErrors > 0 ||
    (needsReview && state.stoppedBecause !== "reviewer signaled completion");
  const persisted = state.verified.map((f) => deps.memory.findings.insert(f, run.id));
  const pendingFindings = state.pending.map((candidate) => deps.memory.findings.insert({ ...candidate, status: "candidate", memoryMatches: [] }, run.id));
  deps.memory.findings.finishRun(run.id, {
    rounds: state.round, candidates: state.known.length,
    confirmed: state.verified.filter((f) => f.status === "confirmed").length,
    rejected: state.verified.filter((f) => f.status === "rejected").length,
    uncertain: state.verified.filter((f) => f.status === "uncertain").length,
    status: incomplete ? "incomplete" : "completed", notes: `${state.stoppedBecause ?? "completed"}; ${state.pending.length} pending`,
  });
  deps.onProgress?.({ type: "done", message: `stopped: ${state.stoppedBecause ?? "completed"}; ${state.pending.length} pending` });
  return {
    base, head, changeSet, rounds: state.rounds, findings: persisted, pendingFindings,
    pendingCandidates: state.pending.length, incomplete, verificationErrors, uncertaintyReasons,
    stoppedBecause: state.stoppedBecause ?? "completed", estimatedTokens: budget.tokenEstimate,
    usage: budget.usage, usageComplete: budget.usageComplete, durationMs: budget.elapsedMs,
    memoryPackTokens: memoryPack.approxTokens, runId: run.id, maxFindings,
    ...(transcriptDir ? { transcriptDir } : {}),
  };
}
