import { buildChangeSet, type ChangeSet } from "../changes/change-set.js";
import { getHeadCommit } from "../changes/git.js";
import { buildRepoSnapshot } from "../changes/snapshot.js";
import type { CodeMapProvider } from "../codemap/types.js";
import { deduplicateCandidates } from "../findings/dedup.js";
import { claimSimilarity } from "../findings/identity.js";
import { SEVERITY_ORDER, type MemoryMatch, type UncertaintyReason, type VerifierResult } from "../findings/types.js";
import type { Memory } from "../memory/index.js";
import { buildMemoryPack, matchIssueHistory } from "../memory/retrieval.js";
import { runTranscriptDir, transcriptsEnabled } from "../agents/transcripts.js";
import type { AgentSessionFactory, SessionUsage } from "../agents/types.js";
import { ReviewerRoundError, runReviewerRound, type ReviewerRoundResult } from "../agents/reviewer.js";
import { runVerifier } from "../agents/verifier.js";
import { loadBuiltInPacks, resolveLanguagePacks, type ActivePack } from "../plugins/index.js";
import type { ToolContext } from "../tools/context.js";
import { planAuditUnits, PLANNER_VERSION, type ReviewWorkUnit } from "./audit-planner.js";
import { Budget } from "./budget.js";
import { CoverageLedger, type CoverageSummary } from "./coverage.js";
import { calculateInformationGain, shouldStop } from "./convergence.js";
import { expandFrontier } from "./frontier.js";
import { applyVerdict, computeRunVerdict, createReviewState, reportedCount, type RoundInfo, type RunVerdict } from "./review-state.js";
import type { VerifiedFinding } from "../findings/types.js";
import type { FindingRow } from "../memory/finding-store.js";
import type { CandidateFinding } from "../findings/types.js";
import {
  createRunEventSink,
  writeRunManifest,
  type RunCounts,
  type RunEventSink,
  type RunFindingSummary,
  type RunSessionRef,
} from "../observability/run-events.js";
import path from "node:path";

export interface FindOptions {
  base?: string;
  head?: string;
  maxRounds?: number;
  maxTokens?: number;
  maxWallClockMs?: number;
  model?: string;
  maxVerificationsPerRound?: number;
  /**
   * Confirmed and uncertain reports count; rejected and pending candidates do
   * not. `null` (#57) removes the ceiling entirely — every candidate the
   * evidence supports is reported; rounds/token budgets still bound the run.
   */
  maxFindings?: number | null;
  /** Parallel verifier sessions during each verification drain (1–8, default 1). */
  verifyConcurrency?: number;
  /**
   * Confirmed findings below this 0–1 verifier confidence are bucketed into
   * `lowConfidenceFindings` (0 = off). Bucketing only: they stay reported
   * and still count toward maxFindings.
   */
  minConfidence?: number;
  /** Language-pack activation: auto-detect at head (default), manual list, or off. */
  pluginMode?: "auto" | "manual" | "off";
  /** Pack names for pluginMode "manual". */
  manualPlugins?: string[];
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
  findings: FindingRow[];
  pendingFindings: FindingRow[];
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
  maxFindings: number | null;
  /** Effective threshold (0 when off) alongside `lowConfidenceFindings`. */
  minConfidence: number;
  /** Confirmed findings with confidence < minConfidence (bucketing only — they stay in `findings`). */
  lowConfidenceFindings: FindingRow[];
  runVerdict: RunVerdict;
  /** Language packs whose guidance was injected into reviewer/verifier prompts. */
  plugins: ActivePack[];
  transcriptDir?: string;
}

const DEFAULT_MAX_ROUNDS = 2;
const DEFAULT_MAX_VERIFICATIONS = 8;
const DEFAULT_MAX_FINDINGS = 10;
/** Audit: discovery attempts per work unit before it settles as reviewed/blocked. */
const DEFAULT_MAX_UNIT_ATTEMPTS = 2;
const DEFAULT_VERIFY_CONCURRENCY = 1;
/** Hard ceiling on parallel verifier sessions during one verification drain. */
export const MAX_VERIFY_CONCURRENCY = 8;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function verifyConcurrencyOption(value: number | undefined, name: string): number {
  if (value === undefined) return DEFAULT_VERIFY_CONCURRENCY;
  const concurrency = positiveInteger(value, name);
  if (concurrency > MAX_VERIFY_CONCURRENCY) {
    throw new Error(`${name} must be between 1 and ${MAX_VERIFY_CONCURRENCY}`);
  }
  return concurrency;
}

const DEFAULT_MIN_CONFIDENCE = 0;

function minConfidenceOption(value: number | undefined, name: string): number {
  if (value === undefined) return DEFAULT_MIN_CONFIDENCE;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
  return value;
}

/**
 * The `--min-confidence` reporting split (Q4): confirmed findings below the
 * threshold. Bucketing only — the rows stay in `findings`/`state.verified`
 * reported as today, still count toward maxFindings, and keep driving the
 * exit-code contract; this is a presentation view over the same set.
 * Uncertain findings are never bucketed (they are already flagged), and
 * rows without a recorded confidence stay in the main section.
 */
function lowConfidenceRows(rows: readonly FindingRow[], threshold: number): FindingRow[] {
  if (threshold <= 0) return [];
  return rows.filter((row) => row.status === "confirmed" && row.confidence !== null && row.confidence < threshold);
}

// ---------------------------------------------------------------------------
// Observability helpers: counters and finding summaries shared by the run-end
// events and run.json manifests emitted at every terminal path.
// ---------------------------------------------------------------------------

type ReviewState = ReturnType<typeof createReviewState>;

function runCounts(state: ReviewState): RunCounts {
  return {
    rounds: state.round,
    candidates: state.known.length,
    confirmed: state.verified.filter((f) => f.status === "confirmed").length,
    rejected: state.verified.filter((f) => f.status === "rejected").length,
    uncertain: state.verified.filter((f) => f.status === "uncertain").length,
    pending: state.pending.length,
  };
}

type FindingSummarySource = { displayId?: string | null; title: string; severity: string; status?: string };

function summarizeFindings(rows: readonly FindingSummarySource[]): RunFindingSummary[] {
  return rows.map((row) => ({
    displayId: row.displayId ?? null,
    title: row.title,
    severity: row.severity,
    status: row.status ?? "candidate",
  }));
}

// ---------------------------------------------------------------------------
// Shared verification drain — the single verification orchestration used by
// both the change loop and the audit loop.
// ---------------------------------------------------------------------------

interface VerificationCounters {
  confirmed: number;
  rejected: number;
  uncertain: number;
  suppressed: number;
  verified: number;
  feedbackVerdicts: VerifierResult[];
}

interface DrainDeps {
  factory: AgentSessionFactory;
  ctx: ToolContext;
  memory: Memory;
  model?: string;
  /** Verifier model override seam (Q5 groundwork): defaults to `model`. */
  verifierModel?: string;
  /** Parallel verifier sessions during the drain (1–MAX_VERIFY_CONCURRENCY, default 1). */
  verifyConcurrency?: number;
  verifierGuidance?: string;
  transcriptDir?: string;
  onProgress?: (event: FindEvent) => void;
  round: number;
  /** Audit mode: current-state verification (no change attribution). */
  audit?: boolean;
  /** Observability: live event sink and transcript index for verifier sessions. */
  sink: RunEventSink;
  sessionFiles: RunSessionRef[];
}

/** Everything one candidate's verification produces. No shared state is touched. */
interface VerifyOneOutcome {
  candidate: CandidateFinding;
  verdict: VerifierResult;
  memoryMatches: MemoryMatch[];
  transcriptRef?: RunSessionRef;
}

async function verifyOne(deps: DrainDeps, candidate: CandidateFinding): Promise<VerifyOneOutcome> {
  deps.onProgress?.({ type: "verify", round: deps.round, message: `verifying ${candidate.displayId}: ${candidate.title}` });
  const matches = matchIssueHistory(deps.memory, {
    fingerprint: candidate.identity.fingerprint, featureKey: candidate.identity.featureKey || undefined,
    entityKey: candidate.identity.entityKey || undefined, normalizedClaim: candidate.identity.normalizedClaim,
    category: candidate.category, anchorPaths: [...new Set(candidate.anchors.map((a) => a.path))],
  });
  const memoryMatches: MemoryMatch[] = matches.map((m) => ({
    memoryId: m.id, decision: m.decision, scope: m.scope, source: m.source, claim: m.claim,
    rationale: m.rationale, trigger: m.trigger, stale: m.stale,
  }));
  const transcriptName = `verifier-r${deps.round}-${candidate.displayId ?? candidate.identity.fingerprint.slice(0, 8)}.json`;
  const model = deps.verifierModel ?? deps.model;
  const verdict = await runVerifier({
    factory: deps.factory, ctx: deps.ctx, candidate, priorDecisions: memoryMatches, model,
    ...(deps.audit ? { audit: true } : {}),
    languageGuidance: deps.verifierGuidance,
    transcriptFile: deps.transcriptDir ? path.join(deps.transcriptDir, transcriptName) : undefined,
    onSessionEvent: deps.sink.session({
      sessionKind: "verifier", role: "finding verifier", model, round: deps.round,
      ...(candidate.displayId !== undefined ? { displayId: candidate.displayId } : {}),
    }),
  });
  return {
    candidate,
    verdict,
    memoryMatches,
    ...(deps.transcriptDir
      ? {
          transcriptRef: {
            file: transcriptName, sessionKind: "verifier", round: deps.round,
            ...(candidate.displayId !== undefined ? { displayId: candidate.displayId } : {}),
          },
        }
      : {}),
  };
}

/**
 * Verify the pending queue with up to `verifyConcurrency` parallel verifier
 * sessions. Admissions come off `state.pending` by index and stay in the queue
 * until their verdict lands, so an interrupted drain leaves every unverified
 * candidate recoverable. Results land strictly in admission order — buffered
 * when an earlier candidate is still in flight — which keeps `state.verified`
 * order, feedback order, and (change mode) displayId assignment identical to
 * the serial drain. In-flight candidates reserve a maxFindings slot each, so
 * reported findings never overshoot the cap however verdicts land; a token or
 * wall-clock budget exhaustion stops new dispatches but in-flight results
 * still land.
 */
async function drainVerifications(
  deps: DrainDeps,
  state: ReturnType<typeof createReviewState>,
  budget: Budget,
  limits: { maxVerifications: number; maxFindings: number | null },
  errors: { verificationErrors: number; uncertaintyReasons: Partial<Record<UncertaintyReason, number>> },
): Promise<VerificationCounters> {
  const counters: VerificationCounters = { confirmed: 0, rejected: 0, uncertain: 0, suppressed: 0, verified: 0, feedbackVerdicts: [] };
  const concurrency = Math.min(Math.max(1, deps.verifyConcurrency ?? 1), MAX_VERIFY_CONCURRENCY);

  let admitted = 0;
  let inFlight = 0;
  let failure: { error: unknown } | undefined;

  const land = (outcome: VerifyOneOutcome): void => {
    if (outcome.transcriptRef) deps.sessionFiles.push(outcome.transcriptRef);
    budget.chargeSession(outcome.verdict.usage, deps.verifierGuidance, outcome.verdict.rationale);
    const idx = state.pending.indexOf(outcome.candidate);
    if (idx !== -1) state.pending.splice(idx, 1);
    inFlight -= 1;
    counters.verified += 1;
    if (outcome.verdict.verdict === "uncertain") {
      const reason = outcome.verdict.uncertaintyReason ?? "missing-evidence";
      errors.uncertaintyReasons[reason] = (errors.uncertaintyReasons[reason] ?? 0) + 1;
      if (reason === "provider-error" || reason === "missing-verdict") errors.verificationErrors += 1;
    }
    const verified = applyVerdict(state, outcome.candidate, outcome.verdict, outcome.memoryMatches);
    if (verified.status === "confirmed") counters.confirmed += 1;
    else if (verified.status === "rejected") counters.rejected += 1;
    else if (verified.status === "uncertain") counters.uncertain += 1;
    else counters.suppressed += 1;
    // Historical decisions remain verifier-only, including their rationale.
    if (outcome.memoryMatches.length === 0 && outcome.verdict.codeFeedback) {
      const feedback = `${outcome.candidate.displayId}: ${outcome.verdict.codeFeedback.slice(0, 1000)}`;
      state.investigationFeedback = [...state.investigationFeedback, feedback].slice(-12);
      counters.feedbackVerdicts.push({ ...outcome.verdict, codeFeedback: feedback });
    }
  };

  // Completed verdicts wait here until every earlier-admitted candidate has
  // landed; a failure stops landing entirely, so the failed candidate and any
  // buffered in-flight results stay in the pending queue exactly as the
  // run-failure persistence path expects them.
  const completed = new Map<number, VerifyOneOutcome>();
  let nextToLand = 0;

  const tryLand = (): void => {
    while (completed.has(nextToLand)) {
      const outcome = completed.get(nextToLand)!;
      completed.delete(nextToLand);
      nextToLand += 1;
      land(outcome);
    }
  };

  const admit = (): { candidate: CandidateFinding; seq: number } | "wait" | null => {
    if (failure) return null;
    // The first `inFlight` pending entries are exactly the admitted candidates
    // still awaiting landing (landing removes in admission order), so the
    // first unadmitted candidate sits at index `inFlight`.
    if (state.pending.length <= inFlight) return null;
    if (admitted >= limits.maxVerifications) return null;
    if (limits.maxFindings !== null && reportedCount(state) >= limits.maxFindings) return null;
    if (budget.exhausted()) return null;
    // No oversubscription: every in-flight candidate holds a findings slot.
    if (limits.maxFindings !== null && reportedCount(state) + inFlight >= limits.maxFindings) return "wait";
    const candidate = state.pending[inFlight]!;
    const seq = admitted;
    admitted += 1;
    inFlight += 1;
    return { candidate, seq };
  };

  const worker = async (): Promise<void> => {
    while (true) {
      const slot = admit();
      if (slot === null) return;
      if (slot === "wait") {
        // Reservation-stalled: a landing will free a slot; re-run the checks
        // after a short timer. The timer keeps the event loop alive while the
        // worker polls — a pure-promise wait could let the loop drain under a
        // slow runner and kill the whole process.
        await new Promise<void>((resolve) => { setTimeout(resolve, 1); });
        continue;
      }
      let outcome: VerifyOneOutcome;
      try {
        outcome = await verifyOne(deps, slot.candidate);
      } catch (error) {
        // Stop the drain: nothing further is admitted or landed, and the
        // failed candidate stays pending for the run-failure path to persist.
        failure ??= { error };
        return;
      }
      completed.set(slot.seq, outcome);
      tryLand();
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (failure) throw failure.error;
  return counters;
}

export async function findIssues(deps: FindDeps): Promise<FindOutcome> {
  const options = deps.options ?? {};
  const maxRounds = positiveInteger(options.maxRounds ?? DEFAULT_MAX_ROUNDS, "maxRounds");
  const maxFindings = options.maxFindings === null ? null : positiveInteger(options.maxFindings ?? DEFAULT_MAX_FINDINGS, "maxFindings");
  const maxVerifications = positiveInteger(options.maxVerificationsPerRound ?? DEFAULT_MAX_VERIFICATIONS, "maxVerificationsPerRound");
  const verifyConcurrency = verifyConcurrencyOption(options.verifyConcurrency, "verifyConcurrency");
  const minConfidence = minConfidenceOption(options.minConfidence, "minConfidence");
  const budget = new Budget({
    maxRounds,
    maxTokens: options.maxTokens === undefined ? undefined : positiveInteger(options.maxTokens, "maxTokens"),
    maxWallClockMs: options.maxWallClockMs === undefined ? undefined : positiveInteger(options.maxWallClockMs, "maxWallClockMs"),
  });

  const requestedHead = options.head ?? (await getHeadCommit(deps.repoRoot));
  const changeSet = await buildChangeSet(deps.repoRoot, options.base ?? `${requestedHead}^`, requestedHead);
  const base = changeSet.baseCommit ?? changeSet.base;
  const head = changeSet.headCommit ?? changeSet.head;
  const run = deps.memory.findings.createRun({ base, head });
  const state = createReviewState(base, head, maxRounds);
  const transcriptDir = transcriptsEnabled() ? runTranscriptDir(deps.memory.store.dbPath, run.id) : undefined;
  const startedAtMs = Date.now();
  const sink = createRunEventSink(run.id, deps.memory.identity.projectId);
  const sessionFiles: RunSessionRef[] = [];
  sink.runStarted({ mode: "change", base, head, model: options.model ?? null });
  // Progress fans out to the caller AND the observability sink; round-end
  // carries the round record that was just pushed to state.rounds.
  const onProgress = (event: FindEvent): void => {
    deps.onProgress?.(event);
    sink.progress({
      phase: event.type,
      message: event.message,
      ...(event.round !== undefined ? { round: event.round } : {}),
      ...(event.type === "round-end" ? { roundInfo: state.rounds[state.rounds.length - 1] } : {}),
    });
  };
  if (transcriptDir) onProgress({ type: "info", message: `transcripts: ${transcriptDir}` });

  const memoryPack = buildMemoryPack(deps.memory, {
    changedPaths: changeSet.files.flatMap((f) => f.oldPath ? [f.path, f.oldPath] : [f.path]),
    featureKeys: [], entityKeys: [], headCommit: head,
  });
  const toolCtx: ToolContext = { repoRoot: deps.repoRoot, headCommit: head, changeSet, codeMap: deps.codeMap, memory: deps.memory };
  const languagePacks = await resolveLanguagePacks({
    repoRoot: deps.repoRoot,
    headCommit: head,
    // "off" must not touch the packs directory at all: `--plugins none` has to
    // work on installs where built-in packs are absent (e.g. partial images).
    packs: options.pluginMode === "off" ? [] : loadBuiltInPacks(),
    selection: { mode: options.pluginMode ?? "auto", manual: options.manualPlugins ?? [] },
  });
  if (languagePacks.active.length > 0) {
    onProgress({
      type: "info",
      message: `language packs: ${languagePacks.active.map((p) => `${p.name}@${p.version} (${p.activation})`).join(", ")}`,
    });
  }
  let needsReview = true;
  const errors = { verificationErrors: 0, uncertaintyReasons: {} as Partial<Record<UncertaintyReason, number>> };

  try {
    while (true) {
      if (maxFindings !== null && reportedCount(state) >= maxFindings) {
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
      onProgress({ type: "round-start", round: state.round, message: `review round ${state.round}${state.pending.length ? " (pending verification)" : ""}` });

      let result: ReviewerRoundResult | undefined;
      let freshCount = 0;
      // Drain existing work before paying for another discovery session.
      if (state.pending.length === 0 && needsReview) {
        const reviewerFile = `reviewer-r${state.round}.json`;
        if (transcriptDir) sessionFiles.push({ file: reviewerFile, sessionKind: "reviewer", round: state.round });
        result = await runReviewerRound({
          factory: deps.factory, ctx: toolCtx, memoryPack: memoryPack.text, round: state.round,
          maxRounds, maxFindings, findingsRemaining: maxFindings === null ? null : maxFindings - reportedCount(state),
          verificationCapacity: maxVerifications, focus: state.focus, priorSummary: state.priorSummary,
          investigationFeedback: state.investigationFeedback, model: options.model,
          languageGuidance: languagePacks.reviewerGuidance,
          transcriptFile: transcriptDir ? path.join(transcriptDir, reviewerFile) : undefined,
          onSessionEvent: sink.session({ sessionKind: "reviewer", role: "code reviewer", model: options.model, round: state.round }),
        });
        budget.chargeSession(result.usage, memoryPack.text, languagePacks.reviewerGuidance, result.assistantText, result.summary);
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

      const drained = await drainVerifications(
        { factory: deps.factory, ctx: toolCtx, memory: deps.memory, model: options.model,
          verifierGuidance: languagePacks.verifierGuidance, transcriptDir, onProgress, round: state.round,
          verifyConcurrency, sink, sessionFiles },
        state, budget, { maxVerifications, maxFindings }, errors,
      );

      state.rounds.push({
        round: state.round, candidates: result?.candidates.length ?? 0, fresh: freshCount,
        confirmed: drained.confirmed, rejected: drained.rejected, uncertain: drained.uncertain, suppressed: drained.suppressed,
        pending: state.pending.length,
        reviewerRan: result !== undefined, summary: result?.summary ?? "Verified queued candidates",
      });
      deps.memory.findings.touchRun(run.id);
      if (result) expandFrontier(state, result, drained.feedbackVerdicts);
      else if (drained.feedbackVerdicts.length) {
        state.focus = [...new Set([...drained.feedbackVerdicts.filter((v) => v.verdict === "uncertain").map((v) => v.codeFeedback!), ...state.focus])].slice(0, 16);
      }
      // Information gain counts non-rejected verdicts; drained.verified
      // includes rejections, which are dry by definition.
      calculateInformationGain(state, freshCount, drained.confirmed + drained.uncertain + drained.suppressed);
      onProgress({ type: "round-end", round: state.round, message: `round ${state.round}: ${freshCount} new, ${drained.confirmed} confirmed, ${drained.rejected} rejected, ${drained.uncertain} uncertain, ${state.pending.length} pending` });
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
    const failureMessage = error instanceof Error ? error.message : String(error);
    sink.runEnded({
      status: "failed", stoppedBecause: failureMessage, durationMs: budget.elapsedMs,
      ...(budget.usage ? { usage: budget.usage } : {}),
      counts: runCounts(state), findings: summarizeFindings([...state.verified, ...state.pending]),
    });
    writeRunManifest(transcriptDir, {
      schemaVersion: 1, runId: run.id, projectId: deps.memory.identity.projectId, mode: "change", status: "failed",
      base, head, model: options.model ?? null, startedAt: startedAtMs, finishedAt: Date.now(),
      stoppedBecause: failureMessage, incomplete: true, runVerdict: computeRunVerdict(state),
      maxFindings, maxFindingsMode: maxFindings === null ? "unlimited" : "capped", rounds: state.rounds,
      plugins: languagePacks.active, sessions: sessionFiles,
      ...(budget.usage ? { usage: budget.usage } : {}),
      durationMs: budget.elapsedMs, estimatedTokens: budget.tokenEstimate,
      files: changeSet.files.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions })),
    });
    throw error;
  }

  const incomplete = state.pending.length > 0 || errors.verificationErrors > 0 ||
    (needsReview && state.stoppedBecause !== "reviewer signaled completion");
  const persisted = state.verified.map((f) => deps.memory.findings.insert(f, run.id));
  const pendingFindings = state.pending.map((candidate) => deps.memory.findings.insert({ ...candidate, status: "candidate", memoryMatches: [] }, run.id));
  const runVerdict = computeRunVerdict(state);
  const lowConfidenceFindings = lowConfidenceRows(persisted, minConfidence);
  deps.memory.findings.finishRun(run.id, {
    rounds: state.round, candidates: state.known.length,
    confirmed: state.verified.filter((f) => f.status === "confirmed").length,
    rejected: state.verified.filter((f) => f.status === "rejected").length,
    uncertain: state.verified.filter((f) => f.status === "uncertain").length,
    status: incomplete ? "incomplete" : "completed", notes: `${state.stoppedBecause ?? "completed"}; ${state.pending.length} pending`,
  });
  onProgress({ type: "done", message: `stopped: ${state.stoppedBecause ?? "completed"}; ${state.pending.length} pending` });
  sink.runEnded({
    status: incomplete ? "incomplete" : "completed",
    stoppedBecause: state.stoppedBecause ?? "completed",
    durationMs: budget.elapsedMs,
    ...(budget.usage ? { usage: budget.usage } : {}),
    counts: runCounts(state),
    findings: summarizeFindings([...persisted, ...pendingFindings]),
  });
  writeRunManifest(transcriptDir, {
    schemaVersion: 1, runId: run.id, projectId: deps.memory.identity.projectId, mode: "change",
    status: incomplete ? "incomplete" : "completed",
    base, head, model: options.model ?? null, startedAt: startedAtMs, finishedAt: Date.now(),
    stoppedBecause: state.stoppedBecause ?? "completed", incomplete, runVerdict,
    maxFindings, maxFindingsMode: maxFindings === null ? "unlimited" : "capped", rounds: state.rounds,
    plugins: languagePacks.active, sessions: sessionFiles,
    ...(budget.usage ? { usage: budget.usage } : {}),
    durationMs: budget.elapsedMs, estimatedTokens: budget.tokenEstimate,
    files: changeSet.files.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions })),
  });
  return {
    base, head, changeSet, rounds: state.rounds, findings: persisted, pendingFindings,
    pendingCandidates: state.pending.length, incomplete, verificationErrors: errors.verificationErrors, uncertaintyReasons: errors.uncertaintyReasons,
    stoppedBecause: state.stoppedBecause ?? "completed", estimatedTokens: budget.tokenEstimate,
    usage: budget.usage, usageComplete: budget.usageComplete, durationMs: budget.elapsedMs,
    memoryPackTokens: memoryPack.approxTokens, runId: run.id, maxFindings,
    minConfidence, lowConfidenceFindings, runVerdict,
    plugins: languagePacks.active,
    ...(transcriptDir ? { transcriptDir } : {}),
  };
}

// ---------------------------------------------------------------------------
// Audit: current-state review of one pinned snapshot through the same
// reviewer/verifier machinery and verification drain as change mode.
// ---------------------------------------------------------------------------

/** Thrown when the resolved audit scope contains nothing reviewable. */
export class AuditScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditScopeError";
  }
}

export interface AuditOptions {
  head?: string;
  /** Literal files or directory prefixes selecting the audit scope. */
  includePaths?: string[];
  /** Documented globs subtracted from the selection. */
  skipGlobs?: string[];
  maxTokens?: number;
  maxWallClockMs?: number;
  model?: string;
  /** `null` (#57): no whole-run cap on reported findings. */
  maxFindings?: number | null;
  maxVerificationsPerRound?: number;
  /** Parallel verifier sessions during each verification drain (1–8, default 1). */
  verifyConcurrency?: number;
  /**
   * Confirmed findings below this 0–1 verifier confidence are bucketed into
   * `lowConfidenceFindings` (0 = off). Bucketing only: they stay reported
   * and still count toward maxFindings.
   */
  minConfidence?: number;
  pluginMode?: "auto" | "manual" | "off";
  manualPlugins?: string[];
}

export interface AuditDeps {
  repoRoot: string;
  memory: Memory;
  codeMap: CodeMapProvider;
  factory: AgentSessionFactory;
  options?: AuditOptions;
  onProgress?: (event: FindEvent) => void;
}

export interface AuditUnitView {
  id: string;
  module: string;
  state: string;
  reason?: string;
  files: number;
  attempts: number;
}

/**
 * Reported findings that a deterministic pass suspects describe the same
 * underlying defect (same category + shared anchor path, or same entity with
 * mid-band claim similarity). Suspected only: nothing is merged or
 * suppressed — cross-module paraphrases need adjudication (P1) and
 * independent defects must stay independent.
 */
export interface SuspectedDuplicateGroup {
  representative: string;
  members: string[];
  reason: string;
}

export interface AuditOutcome {
  head: string;
  mode: "audit";
  snapshot: {
    commit: string;
    treeId: string;
    scopeVersion: number;
    plannerVersion: number;
    scope: { includePaths: string[]; skipGlobs: string[] };
  };
  coverage: CoverageSummary;
  units: AuditUnitView[];
  /** Deterministic same-defect suspects among reported findings (advisory). */
  suspectedDuplicates: SuspectedDuplicateGroup[];
  rounds: RoundInfo[];
  findings: FindingRow[];
  pendingFindings: FindingRow[];
  pendingCandidates: number;
  incomplete: boolean;
  incompleteReasons: string[];
  verificationErrors: number;
  uncertaintyReasons: Partial<Record<UncertaintyReason, number>>;
  stoppedBecause: string;
  estimatedTokens: number;
  usage?: SessionUsage;
  usageComplete: boolean;
  durationMs: number;
  runId: string;
  /** Null when the run reported without a findings cap (#57). */
  maxFindings: number | null;
  /** Effective threshold (0 when off) alongside `lowConfidenceFindings`. */
  minConfidence: number;
  /** Confirmed findings with confidence < minConfidence (bucketing only — they stay in `findings`). */
  lowConfidenceFindings: FindingRow[];
  runVerdict: RunVerdict;
  plugins: ActivePack[];
  transcriptDir?: string;
}

export async function auditIssues(deps: AuditDeps): Promise<AuditOutcome> {
  const options = deps.options ?? {};
  const maxFindings = options.maxFindings === null ? null : positiveInteger(options.maxFindings ?? DEFAULT_MAX_FINDINGS, "maxFindings");
  const maxVerifications = positiveInteger(options.maxVerificationsPerRound ?? DEFAULT_MAX_VERIFICATIONS, "maxVerificationsPerRound");
  const verifyConcurrency = verifyConcurrencyOption(options.verifyConcurrency, "verifyConcurrency");
  const minConfidence = minConfidenceOption(options.minConfidence, "minConfidence");
  const maxUnitAttempts = DEFAULT_MAX_UNIT_ATTEMPTS;
  const budget = new Budget({
    maxRounds: Number.MAX_SAFE_INTEGER,
    maxTokens: options.maxTokens === undefined ? undefined : positiveInteger(options.maxTokens, "maxTokens"),
    maxWallClockMs: options.maxWallClockMs === undefined ? undefined : positiveInteger(options.maxWallClockMs, "maxWallClockMs"),
  });

  const head = options.head ?? (await getHeadCommit(deps.repoRoot));
  const snapshot = await buildRepoSnapshot(deps.repoRoot, head, {
    includePaths: options.includePaths ?? [],
    skipGlobs: options.skipGlobs ?? [],
  });
  const plan = await planAuditUnits(snapshot);
  const ledger = new CoverageLedger(snapshot, plan.rangesByFile, plan.units);
  const inScopeFiles = snapshot.entries.filter((entry) => entry.selection === "selected").length;
  if (inScopeFiles === 0) {
    throw new AuditScopeError("audit scope is empty: no committed files selected (check --path/--skip)");
  }
  if (plan.units.length === 0) {
    throw new AuditScopeError(
      `audit scope has ${inScopeFiles} selected file(s) but none are reviewable text (binary/oversized/submodule entries cannot be audited); refine --path/--skip`,
    );
  }
  deps.onProgress?.({ type: "info", message: `snapshot ${snapshot.commit.slice(0, 10)}: ${inScopeFiles} files in scope, ${plan.units.length} units` });

  const run = deps.memory.findings.createRun({ base: null, head, mode: "audit" });
  // Target first, ledger as it happens: mid-run observers (a second serve
  // request, an operator with sqlite) see scope + progress instead of a
  // running row with nothing else (#38).
  deps.memory.audit.beginRun(run.id, {
    commit: snapshot.commit, treeId: snapshot.treeId, scopeVersion: snapshot.scopeVersion,
    plannerVersion: PLANNER_VERSION, scope: snapshot.scope,
  });
  const state = createReviewState("(snapshot)", head, Number.MAX_SAFE_INTEGER);
  const transcriptDir = transcriptsEnabled() ? runTranscriptDir(deps.memory.store.dbPath, run.id) : undefined;
  const startedAtMs = Date.now();
  const sink = createRunEventSink(run.id, deps.memory.identity.projectId);
  const sessionFiles: RunSessionRef[] = [];
  sink.runStarted({ mode: "audit", base: null, head, model: options.model ?? null });
  const onProgress = (event: FindEvent): void => {
    deps.onProgress?.(event);
    sink.progress({
      phase: event.type,
      message: event.message,
      ...(event.round !== undefined ? { round: event.round } : {}),
      ...(event.type === "round-end" ? { roundInfo: state.rounds[state.rounds.length - 1] } : {}),
    });
  };
  if (transcriptDir) onProgress({ type: "info", message: `transcripts: ${transcriptDir}` });

  const toolCtx: ToolContext = { repoRoot: deps.repoRoot, headCommit: snapshot.commit, codeMap: deps.codeMap, memory: deps.memory };
  const languagePacks = await resolveLanguagePacks({
    repoRoot: deps.repoRoot,
    headCommit: snapshot.commit,
    // Same "off bypasses the packs directory" contract as the review flow.
    packs: options.pluginMode === "off" ? [] : loadBuiltInPacks(),
    selection: { mode: options.pluginMode ?? "auto", manual: options.manualPlugins ?? [] },
    mode: "audit",
  });
  // Audit sessions receive only packs with audit-aware guidance variants;
  // change-mode guidance assumes diff attribution and is withheld (empty render).
  if (languagePacks.active.length > 0) {
    onProgress({
      type: "info",
      message: languagePacks.reviewerGuidance || languagePacks.verifierGuidance
        ? `language packs: ${languagePacks.active.map((p) => `${p.name}@${p.version}`).join(", ")} (audit guidance)`
        : `language packs detected (${languagePacks.active.map((p) => p.name).join(", ")}); no audit-aware guidance yet, withheld`,
    });
  }

  const queue: ReviewWorkUnit[] = [...plan.units];
  const attempts = new Map<string, number>();
  const unitSummaries = new Map<string, string>();
  const errors = { verificationErrors: 0, uncertaintyReasons: {} as Partial<Record<UncertaintyReason, number>> };
  let stoppedBecause = "audit discovery complete";
  // Checkpoint persistence: candidates become durable rows as soon as their
  // discovery session ends; verdicts update the same row, never a re-insert.
  // Keyed by displayId because applyVerdict spreads candidates into new objects.
  const rowByCandidate = new Map<string, FindingRow>();
  const persistCandidates = (candidates: CandidateFinding[]): void => {
    for (const candidate of candidates) {
      const row = deps.memory.findings.insert({ ...candidate, status: "candidate", memoryMatches: [] }, run.id);
      candidate.displayId = row.displayId;
      rowByCandidate.set(row.displayId, row);
    }
  };
  const persistVerified = (finding: VerifiedFinding): FindingRow => {
    const row = finding.displayId ? rowByCandidate.get(finding.displayId) : undefined;
    if (row) {
      const updated = deps.memory.findings.updateVerified(row.id, finding);
      if (updated) return updated;
    }
    return deps.memory.findings.insert(finding, run.id);
  };
  // Durable unit progress (#38): every ledger transition is upserted as it
  // happens, so a multi-day audit is observable (and survives a kill) instead
  // of surfacing its ledger once at finishRun.
  const persistUnit = (unitId: string): void => {
    const unit = ledger.unitRecords().find((candidate) => candidate.unitId === unitId);
    if (!unit) return;
    const owned = new Set(unit.ownedPaths);
    deps.memory.audit.upsertProgress(run.id, {
      units: [{
        unitId: unit.unitId, state: unit.state, ...(unit.reason ? { reason: unit.reason } : {}),
        files: unit.ownedPaths.length, attempts: attempts.get(unit.unitId) ?? 0,
      }],
      files: ledger.fileRecords().filter((file) => owned.has(file.path)).map((file) => ({
        path: file.path, blobId: file.blobId, state: file.state,
        ...(file.reason ? { reason: file.reason } : {}),
        rangesTotal: file.rangesTotal, rangesReviewed: file.rangesReviewed,
      })),
    });
  };
  const markUnit = (unitId: string, state: Parameters<CoverageLedger["markUnit"]>[1], reason?: string): void => {
    ledger.markUnit(unitId, state, reason);
    persistUnit(unitId);
  };

  try {
    while (true) {
      if (maxFindings !== null && reportedCount(state) >= maxFindings) {
        stoppedBecause = `max findings reached (${maxFindings})`;
        break;
      }
      const exhausted = budget.exhausted();
      if (exhausted) {
        stoppedBecause = exhausted;
        break;
      }
      if (state.pending.length > 0) {
        state.round += 1;
        onProgress({ type: "round-start", round: state.round, message: `verification drain (round ${state.round})` });
        const verifiedBefore = state.verified.length;
        const drained = await drainVerifications(
          { factory: deps.factory, ctx: toolCtx, memory: deps.memory, model: options.model,
            verifierGuidance: languagePacks.verifierGuidance, transcriptDir, onProgress, round: state.round, audit: true,
            verifyConcurrency, sink, sessionFiles },
          state, budget, { maxVerifications, maxFindings }, errors,
        );
        for (const finding of state.verified.slice(verifiedBefore)) persistVerified(finding);
        state.rounds.push({
          round: state.round, candidates: 0, fresh: 0,
          confirmed: drained.confirmed, rejected: drained.rejected, uncertain: drained.uncertain, suppressed: drained.suppressed,
          pending: state.pending.length, reviewerRan: false, summary: "Verified queued candidates",
        });
        deps.memory.findings.touchRun(run.id);
        onProgress({ type: "round-end", round: state.round, message: `verification drain: ${drained.confirmed} confirmed, ${drained.rejected} rejected, ${drained.uncertain} uncertain, ${state.pending.length} pending` });
        continue;
      }
      if (queue.length === 0) {
        stoppedBecause = ledger.allUnitsTerminal() ? "audit discovery complete" : "no further units schedulable";
        break;
      }

      const unit = queue.shift()!;
      const attempt = (attempts.get(unit.id) ?? 0) + 1;
      attempts.set(unit.id, attempt);
      state.round += 1;
      const ownedPaths = [...new Set(unit.owned.map((range) => range.path))];
      onProgress({ type: "round-start", round: state.round, message: `unit ${unit.id} (${unit.module}) attempt ${attempt}/${maxUnitAttempts}: ${ownedPaths.length} files` });
      const memoryPack = buildMemoryPack(deps.memory, {
        changedPaths: [],
        focusPaths: ownedPaths,
        featureKeys: [], entityKeys: [], headCommit: snapshot.commit,
      });
      let result: ReviewerRoundResult;
      const reviewerFile = `reviewer-${unit.id}-a${attempt}.json`;
      if (transcriptDir) sessionFiles.push({ file: reviewerFile, sessionKind: "reviewer", round: state.round, unitId: unit.id, attempt });
      try {
        result = await runReviewerRound({
          factory: deps.factory, ctx: toolCtx, memoryPack: memoryPack.text, round: state.round,
          maxRounds: Number.MAX_SAFE_INTEGER, maxFindings, findingsRemaining: maxFindings === null ? null : maxFindings - reportedCount(state),
          verificationCapacity: maxVerifications, focus: state.focus,
          priorSummary: unitSummaries.get(unit.id),
          investigationFeedback: state.investigationFeedback, model: options.model,
          languageGuidance: languagePacks.reviewerGuidance,
          transcriptFile: transcriptDir ? path.join(transcriptDir, reviewerFile) : undefined,
          audit: { snapshot, unit, attempt, maxAttempts: maxUnitAttempts, unitsTotal: plan.units.length, unitsRemaining: queue.length },
          onSessionEvent: sink.session({
            sessionKind: "reviewer", role: "code reviewer", model: options.model,
            round: state.round, unitId: unit.id, attempt,
          }),
        });
      } catch (error) {
        if (error instanceof ReviewerRoundError) {
          const recovered = deduplicateCandidates(error.candidates, state.known).fresh;
          state.known.push(...recovered);
          state.pending.push(...recovered);
          persistCandidates(recovered);
          budget.chargeSession(error.usage, error.message);
          markUnit(unit.id, "failed", `reviewer session failed: ${error.message}`);
          state.rounds.push({
            round: state.round, candidates: error.candidates.length, fresh: recovered.length,
            confirmed: 0, rejected: 0, uncertain: 0, suppressed: 0, pending: state.pending.length,
            reviewerRan: true, summary: `reviewer failed on unit ${unit.id}: ${error.message}`,
          });
          onProgress({ type: "round-end", round: state.round, message: `unit ${unit.id} failed: ${error.message}` });
          continue;
        }
        throw error;
      }      budget.chargeSession(result.usage, memoryPack.text, result.assistantText, result.summary);
      const dedup = deduplicateCandidates(result.candidates, state.known);
      state.known.push(...dedup.fresh);
      state.pending.push(...dedup.fresh);
      state.pending.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
      persistCandidates(dedup.fresh);

      // Unit completion: a valid finish requires pinned reads of every owned
      // file; otherwise the claim is rejected and the unit retried or blocked.
      const readPaths = new Set(result.readPaths ?? []);
      const unread = ownedPaths.filter((owned) => !readPaths.has(owned));
      const canRetry = attempt < maxUnitAttempts && !budget.exhausted() && (maxFindings === null || reportedCount(state) < maxFindings);
      if (unread.length > 0 && canRetry) {
        unitSummaries.set(unit.id, [
          unitSummaries.get(unit.id),
          `Previous attempt declared completion WITHOUT pinned reads of: ${unread.join(", ")}. Read those files before finishing.`,
        ].filter(Boolean).join("\n").slice(0, 6000));
        queue.unshift(unit);
        markUnit(unit.id, "in-progress", "completion claim without owned-file reads; retrying");
      } else if (unread.length > 0) {
        markUnit(unit.id, "blocked", `completion claimed without pinned reads of: ${unread.join(", ")}`);
      } else if (result.needsMoreRounds && canRetry) {
        unitSummaries.set(unit.id, [
          result.summary,
          ...(result.coverage ?? []).map((s) => `Covered: ${s}`),
          ...(result.unresolvedQuestions ?? []).map((s) => `Unresolved: ${s}`),
        ].join("\n").slice(0, 6000));
        queue.unshift(unit);
        markUnit(unit.id, "in-progress", "reviewer requested another pass");
      } else {
        markUnit(unit.id, "reviewed");
      }

      state.rounds.push({
        round: state.round, candidates: result.candidates.length, fresh: dedup.fresh.length,
        confirmed: 0, rejected: 0, uncertain: 0, suppressed: 0, pending: state.pending.length,
        reviewerRan: true, summary: `unit ${unit.id} (${unit.module}): ${result.summary}`,
      });
      expandFrontier(state, result, []);
      onProgress({ type: "round-end", round: state.round, message: `unit ${unit.id}: ${dedup.fresh.length} new candidates, ${state.pending.length} pending verification` });
    }
  } catch (error) {
    for (const finding of state.verified) persistVerified(finding);
    const failureMessage = error instanceof Error ? error.message : String(error);
    deps.memory.findings.finishRun(run.id, {
      rounds: state.round, candidates: state.known.length,
      confirmed: state.verified.filter((f) => f.status === "confirmed").length,
      rejected: state.verified.filter((f) => f.status === "rejected").length,
      uncertain: state.verified.filter((f) => f.status === "uncertain").length,
      status: "failed", notes: failureMessage,
    });
    // A failed audit still leaves its authoritative ledger: how far it got is
    // the first question any post-mortem asks (#38).
    deps.memory.audit.persistRunState(run.id, {
      snapshot: { commit: snapshot.commit, treeId: snapshot.treeId, scopeVersion: snapshot.scopeVersion, plannerVersion: PLANNER_VERSION, scope: snapshot.scope },
      coverage: ledger.summary(),
      units: ledger.unitRecords().map((unit) => ({
        unitId: unit.unitId, state: unit.state, ...(unit.reason ? { reason: unit.reason } : {}),
        files: unit.ownedPaths.length, attempts: attempts.get(unit.unitId) ?? 0,
      })),
      files: ledger.fileRecords(),
    });
    sink.runEnded({
      status: "failed", stoppedBecause: failureMessage, durationMs: budget.elapsedMs,
      ...(budget.usage ? { usage: budget.usage } : {}),
      counts: runCounts(state), findings: summarizeFindings([...state.verified, ...state.pending]),
    });
    writeRunManifest(transcriptDir, {
      schemaVersion: 1, runId: run.id, projectId: deps.memory.identity.projectId, mode: "audit", status: "failed",
      base: null, head, model: options.model ?? null, startedAt: startedAtMs, finishedAt: Date.now(),
      stoppedBecause: failureMessage, incomplete: true, runVerdict: computeRunVerdict(state),
      maxFindings, maxFindingsMode: maxFindings === null ? "unlimited" : "capped", rounds: state.rounds,
      plugins: languagePacks.active, sessions: sessionFiles,
      ...(budget.usage ? { usage: budget.usage } : {}),
      durationMs: budget.elapsedMs, estimatedTokens: budget.tokenEstimate,
    });
    throw error;
  }

  const coverage = ledger.summary();
  const persisted = state.verified.map((finding) => persistVerified(finding));
  const incompleteReasons: string[] = [];
  if (state.pending.length > 0) incompleteReasons.push(`${state.pending.length} candidates await verification`);
  if (errors.verificationErrors > 0) incompleteReasons.push(`${errors.verificationErrors} verification errors`);
  if (coverage.filesPartial > 0) incompleteReasons.push(`${coverage.filesPartial} files partially reviewed`);
  if (coverage.filesUnreviewed > 0) incompleteReasons.push(`${coverage.filesUnreviewed} files unreviewed`);
  if (coverage.filesBlocked > 0) incompleteReasons.push(`${coverage.filesBlocked} files blocked`);
  if (coverage.filesFailed > 0) incompleteReasons.push(`${coverage.filesFailed} files failed`);
  const incomplete = incompleteReasons.length > 0;
  deps.memory.findings.finishRun(run.id, {
    rounds: state.round, candidates: state.known.length,
    confirmed: state.verified.filter((f) => f.status === "confirmed").length,
    rejected: state.verified.filter((f) => f.status === "rejected").length,
    uncertain: state.verified.filter((f) => f.status === "uncertain").length,
    status: incomplete ? "incomplete" : "completed",
    notes: `${stoppedBecause}; ${incompleteReasons.join("; ") || "full scope reviewed"}`,
  });
  await deps.memory.audit.persistRunState(run.id, {
    snapshot: { commit: snapshot.commit, treeId: snapshot.treeId, scopeVersion: snapshot.scopeVersion, plannerVersion: PLANNER_VERSION, scope: snapshot.scope },
    coverage,
    units: ledger.unitRecords().map((unit) => ({
      unitId: unit.unitId, state: unit.state, ...(unit.reason ? { reason: unit.reason } : {}),
      files: unit.ownedPaths.length, attempts: attempts.get(unit.unitId) ?? 0,
    })),
    files: ledger.fileRecords(),
  });
  onProgress({ type: "done", message: `stopped: ${stoppedBecause}; coverage ${coverage.filesReviewed}/${coverage.filesInScope} reviewed, ${state.pending.length} pending` });
  const unitViews: AuditUnitView[] = ledger.unitRecords().map((unit) => ({
    id: unit.unitId,
    module: plan.units.find((planned) => planned.id === unit.unitId)?.module ?? "",
    state: unit.state,
    ...(unit.reason ? { reason: unit.reason } : {}),
    files: unit.ownedPaths.length,
    attempts: attempts.get(unit.unitId) ?? 0,
  }));
  const suspectedDuplicates = suspectCrossUnitDuplicates(state.verified);
  const pendingFindings = state.pending
    .map((candidate) => (candidate.displayId ? rowByCandidate.get(candidate.displayId) : undefined))
    .filter((row): row is FindingRow => row !== undefined);
  const runVerdict = computeRunVerdict(state);
  const lowConfidenceFindings = lowConfidenceRows(persisted, minConfidence);
  sink.runEnded({
    status: incomplete ? "incomplete" : "completed",
    stoppedBecause,
    durationMs: budget.elapsedMs,
    ...(budget.usage ? { usage: budget.usage } : {}),
    counts: runCounts(state),
    findings: summarizeFindings([...persisted, ...pendingFindings]),
  });
  writeRunManifest(transcriptDir, {
    schemaVersion: 1, runId: run.id, projectId: deps.memory.identity.projectId, mode: "audit",
    status: incomplete ? "incomplete" : "completed",
    base: null, head: snapshot.commit, model: options.model ?? null,
    startedAt: startedAtMs, finishedAt: Date.now(),
    stoppedBecause, incomplete, runVerdict,
    maxFindings, maxFindingsMode: maxFindings === null ? "unlimited" : "capped", rounds: state.rounds,
    plugins: languagePacks.active, sessions: sessionFiles,
    ...(budget.usage ? { usage: budget.usage } : {}),
    durationMs: budget.elapsedMs, estimatedTokens: budget.tokenEstimate,
    coverage, units: unitViews,
  });
  return {
    head: snapshot.commit,
    mode: "audit",
    snapshot: {
      commit: snapshot.commit, treeId: snapshot.treeId, scopeVersion: snapshot.scopeVersion,
      plannerVersion: PLANNER_VERSION, scope: snapshot.scope,
    },
    coverage,
    units: unitViews,
    suspectedDuplicates,
    rounds: state.rounds,
    findings: persisted,
    pendingFindings,
    pendingCandidates: state.pending.length,
    incomplete,
    incompleteReasons,
    verificationErrors: errors.verificationErrors,
    uncertaintyReasons: errors.uncertaintyReasons,
    stoppedBecause,
    estimatedTokens: budget.tokenEstimate,
    usage: budget.usage,
    usageComplete: budget.usageComplete,
    durationMs: budget.elapsedMs,
    runId: run.id,
    maxFindings,
    minConfidence, lowConfidenceFindings, runVerdict,
    plugins: languagePacks.active,
    ...(transcriptDir ? { transcriptDir } : {}),
  };
}

/**
 * Deterministic duplicate suspects among reported findings: same category
 * plus a shared anchor path, or same entityKey with claim similarity in the
 * 0.5–0.82 band that the exact dedup deliberately does NOT merge. Advisory
 * output only — merging paraphrases across modules needs adjudication and
 * must never suppress an independent defect.
 */
function suspectCrossUnitDuplicates(reported: VerifiedFinding[]): SuspectedDuplicateGroup[] {
  const REPORTED_SET = new Set(["confirmed", "uncertain"]);
  const items = reported.filter((finding) => REPORTED_SET.has(finding.status));
  const groups: SuspectedDuplicateGroup[] = [];
  const assigned = new Set<string>();
  const keyOf = (finding: VerifiedFinding): string => `${finding.identity.fingerprint}:${finding.displayId ?? ""}`;
  for (let i = 0; i < items.length; i++) {
    const anchor = items[i]!;
    if (assigned.has(keyOf(anchor))) continue;
    const members: string[] = [];
    let reason = "";
    for (let j = i + 1; j < items.length; j++) {
      const other = items[j]!;
      if (assigned.has(keyOf(other)) || other.category !== anchor.category) continue;
      const sharedPath = anchor.anchors.some((a) => other.anchors.some((b) => a.path === b.path));
      const sameEntity = !!anchor.entityKey && anchor.entityKey === other.entityKey;
      const similarity = sameEntity
        ? claimSimilarity(anchor.identity.normalizedClaim, other.identity.normalizedClaim)
        : 0;
      if (sharedPath || (sameEntity && similarity >= 0.5)) {
        members.push(other.displayId ?? other.identity.fingerprint.slice(0, 8));
        assigned.add(keyOf(other));
        reason ||= sharedPath
          ? "same category and shared anchor path"
          : `same entity, claim similarity ${similarity.toFixed(2)}`;
      }
    }
    if (members.length > 0) {
      assigned.add(keyOf(anchor));
      groups.push({
        representative: anchor.displayId ?? anchor.identity.fingerprint.slice(0, 8),
        members,
        reason,
      });
    }
  }
  return groups;
}
