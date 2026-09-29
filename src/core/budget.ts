import type { SessionUsage } from "../agents/types.js";

export interface BudgetOptions {
  maxRounds: number;
  /**
   * Checked between sessions; an in-flight model turn may exceed the limit.
   * Undefined means unlimited: different problems need different amounts, so
   * the review runs until rounds/findings/wall-clock stop it.
   */
  maxTokens?: number;
  maxWallClockMs?: number;
}

export class Budget {
  private spentTokens = 0;
  private measured?: SessionUsage;
  private missingUsage = false;
  private readonly startedAt = Date.now();

  constructor(private readonly options: BudgetOptions) {}

  get tokenEstimate(): number { return this.spentTokens; }
  get elapsedMs(): number { return Date.now() - this.startedAt; }
  get usage(): SessionUsage | undefined { return this.measured ? { ...this.measured } : undefined; }
  get usageComplete(): boolean { return this.measured !== undefined && !this.missingUsage; }

  chargeText(...texts: Array<string | undefined>): void {
    this.missingUsage = true;
    for (const text of texts) {
      if (text) this.spentTokens += Math.ceil(text.length / 4);
    }
  }

  chargeSession(usage: SessionUsage | undefined, ...fallback: Array<string | undefined>): void {
    if (!usage) {
      this.chargeText(...fallback);
      return;
    }
    this.spentTokens += usage.totalTokens;
    if (!this.measured) {
      this.measured = { ...usage };
      return;
    }
    for (const key of Object.keys(this.measured) as Array<keyof SessionUsage>) {
      this.measured[key] += usage[key];
    }
  }

  exhausted(): string | null {
    if (this.options.maxTokens !== undefined && this.spentTokens >= this.options.maxTokens) {
      return `token budget exhausted (${this.missingUsage ? "~" : ""}${this.spentTokens} tokens)`;
    }
    if (this.options.maxWallClockMs && this.elapsedMs >= this.options.maxWallClockMs) {
      return `wall-clock budget exhausted (${Math.round(this.elapsedMs / 1000)}s)`;
    }
    return null;
  }
}
