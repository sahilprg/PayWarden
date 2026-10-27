import type { AIProvider } from './provider.js';

/** A shared count of live AI calls per rolling hour. */
export class AIBudget {
  private calls: number[] = [];
  constructor(
    private readonly perHour: number,
    private readonly clock: () => number = Date.now,
  ) {}
  take(): boolean {
    const now = this.clock();
    this.calls = this.calls.filter((t) => now - t < 3_600_000);
    if (this.calls.length >= this.perHour) return false;
    this.calls.push(now);
    return true;
  }
}

/**
 * Uses the live model until this instance's allowance or the shared hourly budget runs out,
 * then answers with the offline provider. Used for public playgrounds so visitors cannot run
 * up the owner's AI bill; the real gateway is never budgeted this way.
 */
export class BudgetedAIProvider implements AIProvider {
  readonly name: string;
  private used = 0;

  constructor(
    private readonly live: AIProvider,
    private readonly offline: AIProvider,
    private readonly shared: AIBudget,
    private readonly perInstance: number,
  ) {
    this.name = live.name;
  }

  private pick(): AIProvider {
    if (this.used >= this.perInstance || !this.shared.take()) return this.offline;
    this.used += 1;
    return this.live;
  }

  compileMandate(...a: Parameters<AIProvider['compileMandate']>) {
    return this.pick().compileMandate(...a);
  }
  judgeIntent(...a: Parameters<AIProvider['judgeIntent']>) {
    return this.pick().judgeIntent(...a);
  }
  scanUntrusted(...a: Parameters<AIProvider['scanUntrusted']>) {
    return this.pick().scanUntrusted(...a);
  }
  proposeRemedy(...a: Parameters<AIProvider['proposeRemedy']>) {
    return this.pick().proposeRemedy(...a);
  }
}
