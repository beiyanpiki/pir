import { buildChangeSet, type ChangeSet } from "../changes/change-set.js";
import { getHeadCommit } from "../changes/git.js";
import type { CodeMapProvider } from "../codemap/types.js";
import { deduplicateCandidates } from "../findings/dedup.js";
import type { CandidateFinding, MemoryMatch } from "../findings/types.js";
import type { Memory } from "../memory/index.js";
import { buildMemoryPack, matchIssueHistory } from "../memory/retrieval.js";
import type { AgentSessionFactory } from "../agents/types.js";
import { runReviewerRound } from "../agents/reviewer.js";
import { runVerifier } from "../agents/verifier.js";
import type { ToolContext } from "../tools/context.js";
import { Budget } from "./budget.js";
import { calculateInformationGain, shouldStop } from "./convergence.js";
import { expandFrontier } from "./frontier.js";
import { applyVerdict, createReviewState, type ReviewState, type RoundInfo } from "./review-state.js";

export interface FindOptions {
  base?: string;
  head?: string;
  maxRounds?: number;
  maxTokens?: number;
  model?: string;
  /** Cap on verifier sessions per round — verification is the expensive part. */
  maxVerificationsPerRound?: number;
}

export interface FindEvent {
  type: "round-start" | "round-end" | "verify" | "done";
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
  stoppedBecause: string;
  estimatedTokens: number;
  memoryPackTokens: number;
  runId: string;
}

const DEFAULT_MAX_ROUNDS = 2;
const DEFAULT_MAX_TOKENS = 400_000;
const DEFAULT_MAX_VERIFICATIONS = 8;

/**
 * The outer Finding Loop:
 * explore -> candidate -> verify -> expand frontier -> repeat until converged.
 * Sessions are one-shot; only the structured Finding Store and Repository
 * Memory persist between rounds.
 */
export async function findIssues(deps: FindDeps): Promise<FindOutcome> {
  const options = deps.options ?? {};
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const budget = new Budget({
    maxRounds,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
  });

  const head = options.head ?? (await getHeadCommit(deps.repoRoot));
  const base = options.base ?? `${head}^`;
  const changeSet = await buildChangeSet(deps.repoRoot, base, head);

  const run = deps.memory.findings.createRun(base, head);
  const state: ReviewState = createReviewState(base, head, maxRounds);

  const changedPaths = changeSet.files.map((f) => f.path);
  const memoryPack = deps.memory
    ? buildMemoryPack(deps.memory, { changedPaths, featureKeys: [], entityKeys: [], headCommit: head })
    : { text: "", approxTokens: 0, truncated: false, sections: [] };
  budget.chargeText(memoryPack.text);

  const toolCtx: ToolContext = {
    repoRoot: deps.repoRoot,
    headCommit: head,
    changeSet,
    codeMap: deps.codeMap,
    memory: deps.memory,
  };

  while (true) {
    const stop = shouldStop(state, budget);
    if (state.round > 0 && stop.stop) {
      state.stoppedBecause = stop.reason!;
      break;
    }
    state.round += 1;
    deps.onProgress?.({ type: "round-start", round: state.round, message: `review round ${state.round}` });

    const result = await runReviewerRound({
      factory: deps.factory,
      ctx: toolCtx,
      memoryPack: memoryPack.text,
      round: state.round,
      maxRounds,
      focus: state.focus,
      priorSummary: state.priorSummary,
      model: options.model,
    });
    budget.chargeText(result.assistantText, result.summary);

    const dedup = deduplicateCandidates(result.candidates, state.known);
    state.known.push(...dedup.fresh);

    const toVerify = dedup.fresh.slice(0, options.maxVerificationsPerRound ?? DEFAULT_MAX_VERIFICATIONS);
    let confirmed = 0;
    let rejected = 0;
    let uncertain = 0;

    for (const candidate of toVerify) {
      deps.onProgress?.({ type: "verify", round: state.round, message: `verifying ${candidate.displayId}: ${candidate.title}` });
      const matches = matchIssueHistory(deps.memory, {
        fingerprint: candidate.identity.fingerprint,
        featureKey: candidate.identity.featureKey || undefined,
        entityKey: candidate.identity.entityKey || undefined,
      });
      const memoryMatches: MemoryMatch[] = matches.map((m) => ({
        memoryId: m.id,
        decision: m.decision,
        scope: m.scope,
        source: m.source,
        claim: m.claim,
        rationale: m.rationale,
      }));
      const verdict = await runVerifier({
        factory: deps.factory,
        ctx: toolCtx,
        candidate,
        priorDecisions: memoryMatches,
        model: options.model,
      });
      budget.chargeText(verdict.rationale);
      const verified = applyVerdict(state, candidate, verdict, memoryMatches);
      if (verified.status === "confirmed") confirmed += 1;
      else if (verified.status === "rejected") rejected += 1;
      else uncertain += 1;
    }

    const roundInfo: RoundInfo = {
      round: state.round,
      candidates: result.candidates.length,
      fresh: dedup.fresh.length,
      confirmed,
      rejected,
      uncertain,
      summary: result.summary,
    };
    state.rounds.push(roundInfo);
    state.priorSummary = result.summary;
    expandFrontier(state, result, []);
    calculateInformationGain(state, dedup.fresh.length, confirmed + uncertain);
    deps.onProgress?.({ type: "round-end", round: state.round, message: `round ${state.round}: ${roundInfo.fresh} new, ${confirmed} confirmed, ${rejected} rejected, ${uncertain} uncertain` });

    if (!result.needsMoreRounds) {
      state.stoppedBecause = "reviewer signaled completion";
      break;
    }
    if (dedup.fresh.length === 0) {
      state.stoppedBecause = "no new candidates in round";
      break;
    }
  }

  const persisted = state.verified.map((f) => deps.memory.findings.insert(f, run.id));
  deps.memory.findings.finishRun(run.id, {
    rounds: state.round,
    candidates: state.known.length,
    confirmed: state.verified.filter((f) => f.status === "confirmed").length,
    rejected: state.verified.filter((f) => f.status === "rejected").length,
    uncertain: state.verified.filter((f) => f.status === "uncertain").length,
    status: "completed",
    notes: state.stoppedBecause ?? "completed",
  });
  deps.onProgress?.({ type: "done", message: `stopped: ${state.stoppedBecause ?? "completed"}` });

  return {
    base,
    head,
    changeSet,
    rounds: state.rounds,
    findings: persisted,
    stoppedBecause: state.stoppedBecause ?? "completed",
    estimatedTokens: budget.tokenEstimate,
    memoryPackTokens: memoryPack.approxTokens,
    runId: run.id,
  };
}
