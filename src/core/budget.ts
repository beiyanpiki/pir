export interface BudgetOptions {
  maxRounds: number;
  /** Rough token ceiling; we estimate from produced text, usage APIs differ per provider. */
  maxTokens: number;
  maxWallClockMs?: number;
}

export class Budget {
  private spentTokens = 0;
  private readonly startedAt = Date.now();

  constructor(private readonly options: BudgetOptions) {}

  get tokenEstimate(): number {
    return this.spentTokens;
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /** Account for text produced/consumed in one agent interaction. */
  chargeText(...texts: Array<string | undefined>): void {
    for (const text of texts) {
      if (text) this.spentTokens += Math.ceil(text.length / 4);
    }
  }

  exhausted(): string | null {
    const { maxRounds, maxTokens, maxWallClockMs } = this.options;
    if (this.spentTokens >= maxTokens) return `token budget exhausted (~${this.spentTokens} tokens)`;
    if (maxWallClockMs && this.elapsedMs >= maxWallClockMs) {
      return `wall-clock budget exhausted (${Math.round(this.elapsedMs / 1000)}s)`;
    }
    void maxRounds;
    return null;
  }
}
