import type { SessionUsage } from "../agents/types.js";

/**
 * B3 (ADR 0006) default ceilings for `find`, measured on prompt-side input
 * tokens (uncached input + cache reads + cache writes; see `inputTokensOf`).
 * Audit deliberately has no default ceiling: it keeps the pre-B3 semantics
 * (unlimited unless `--max-tokens` is set), so a future refactor cannot
 * silently cap a multi-day sweep.
 *
 * Tightening either constant requires checking the M1 per-PR token
 * distribution first (roadmap B3 / A2) and recording the result as an
 * ADR 0006 amendment here — not a drive-by edit.
 */
export const DEFAULT_FIND_REVIEWER_INPUT_TOKENS = 1_200_000;
export const DEFAULT_FIND_VERIFIER_INPUT_TOKENS = 800_000;

/** The session kind a charge belongs to; the default ceilings are per-role. */
export type BudgetRole = "reviewer" | "verifier";

export type BudgetCeilingKind = "tokens" | "reviewer-tokens" | "verifier-tokens" | "wall-clock";

export interface BudgetCeilingHit {
  kind: BudgetCeilingKind;
  /** Human-readable stop reason; becomes `stoppedBecause` when it ends the run. */
  reason: string;
}

export interface BudgetOptions {
  maxRounds: number;
  /**
   * Explicit whole-run ceiling over measured total tokens (`--max-tokens`).
   * Checked between sessions; an in-flight model turn may exceed the limit.
   * Undefined means no explicit ceiling. Hard: it also refuses new verifier
   * admissions mid-drain, unlike the role ceilings below.
   */
  maxTokens?: number;
  /**
   * B3 default (`find` only): prompt-side input-token ceiling for reviewer
   * sessions. Reaching it starts no new reviewer round but does not cut a
   * pending verification drain short — that is ADR 0006's grace.
   */
  reviewerTokens?: number;
  /** B3 default (`find` only): prompt-side input-token ceiling for verifier sessions. */
  verifierTokens?: number;
  maxWallClockMs?: number;
}

/**
 * Prompt-side tokens: everything the model had to read. The four SDK buckets
 * are disjoint (session-factory.ts), so `inputTokens` alone is uncached input
 * only — a caching provider would otherwise move tokens out of the ceiling's
 * accounting without changing the prompt volume. Missing buckets (partial
 * injected usage) count as zero rather than poisoning the sum with NaN.
 */
export function inputTokensOf(usage: SessionUsage): number {
  return (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

export class Budget {
  private spentTokens = 0;
  private spentInputTokens = 0;
  private spentReviewerInput = 0;
  private spentVerifierInput = 0;
  private measured?: SessionUsage;
  private missingUsage = false;
  private readonly startedAt = Date.now();

  constructor(private readonly options: BudgetOptions) {}

  get tokenEstimate(): number { return this.spentTokens; }
  /** Prompt-side (input) estimate across every role — B3's accounting. */
  get inputTokenEstimate(): number { return this.spentInputTokens; }
  get reviewerInputTokens(): number { return this.spentReviewerInput; }
  get verifierInputTokens(): number { return this.spentVerifierInput; }
  get elapsedMs(): number { return Date.now() - this.startedAt; }
  get usage(): SessionUsage | undefined { return this.measured ? { ...this.measured } : undefined; }
  get usageComplete(): boolean { return this.measured !== undefined && !this.missingUsage; }

  chargeText(...texts: Array<string | undefined>): void {
    this.missingUsage = true;
    for (const text of texts) {
      if (text) this.addEstimate(Math.ceil(text.length / 4));
    }
  }

  /**
   * Charge one session's usage. `role` attributes the prompt-side spend to a
   * default ceiling; unset means the charge counts only toward the whole-run
   * totals (audit, and estimates that cannot be attributed).
   */
  chargeSession(usage: SessionUsage | undefined, role?: BudgetRole, ...fallback: Array<string | undefined>): void {
    if (!usage) {
      // No measured usage: the fallback texts are prompt-side content, so the
      // estimate is attributed to the role it was spent on.
      this.missingUsage = true;
      for (const text of fallback) {
        if (text) this.addEstimate(Math.ceil(text.length / 4), role);
      }
      return;
    }
    this.spentTokens += usage.totalTokens;
    const input = inputTokensOf(usage);
    this.spentInputTokens += input;
    if (role === "reviewer") this.spentReviewerInput += input;
    else if (role === "verifier") this.spentVerifierInput += input;
    if (!this.measured) {
      this.measured = { ...usage };
      return;
    }
    for (const key of Object.keys(this.measured) as Array<keyof SessionUsage>) {
      this.measured[key] += usage[key];
    }
  }

  /**
   * Any ceiling that stops the next session from starting: the explicit
   * whole-run token ceiling, the wall clock, then the B3 role ceilings.
   */
  ceilingHit(): BudgetCeilingHit | null {
    return this.hardCeilingHit() ?? this.gracefulCeilingHit();
  }

  /**
   * Ceilings that must also stop *verifier admissions mid-drain*: the explicit
   * `--max-tokens` ceiling and the wall clock. The default role ceilings are
   * deliberately excluded — ADR 0006's grace finishes verifying what was
   * already found, however far that overshoots the verifier ceiling.
   */
  hardExhausted(): string | null {
    return this.hardCeilingHit()?.reason ?? null;
  }

  exhausted(): string | null {
    return this.ceilingHit()?.reason ?? null;
  }

  private hardCeilingHit(): BudgetCeilingHit | null {
    if (this.options.maxTokens !== undefined && this.spentTokens >= this.options.maxTokens) {
      return { kind: "tokens", reason: `token budget exhausted (${this.missingUsage ? "~" : ""}${this.spentTokens} tokens)` };
    }
    if (this.options.maxWallClockMs && this.elapsedMs >= this.options.maxWallClockMs) {
      return { kind: "wall-clock", reason: `wall-clock budget exhausted (${Math.round(this.elapsedMs / 1000)}s)` };
    }
    return null;
  }

  private gracefulCeilingHit(): BudgetCeilingHit | null {
    const approximate = this.missingUsage ? "~" : "";
    const { reviewerTokens, verifierTokens } = this.options;
    if (reviewerTokens !== undefined && this.spentReviewerInput >= reviewerTokens) {
      return {
        kind: "reviewer-tokens",
        reason: `reviewer token budget exhausted (${approximate}${this.spentReviewerInput} of ${reviewerTokens} input tokens)`,
      };
    }
    if (verifierTokens !== undefined && this.spentVerifierInput >= verifierTokens) {
      return {
        kind: "verifier-tokens",
        reason: `verifier token budget exhausted (${approximate}${this.spentVerifierInput} of ${verifierTokens} input tokens)`,
      };
    }
    return null;
  }

  private addEstimate(tokens: number, role?: BudgetRole): void {
    this.spentTokens += tokens;
    this.spentInputTokens += tokens;
    if (role === "reviewer") this.spentReviewerInput += tokens;
    else if (role === "verifier") this.spentVerifierInput += tokens;
  }
}
