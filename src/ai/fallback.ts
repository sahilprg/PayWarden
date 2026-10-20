import type { AIProvider } from './provider.js';

/**
 * Tries the live model first and falls back to a second provider when it fails
 * (free tiers are often busy). Used only in the public playground, where nothing
 * real is at stake and a stalled demo helps no one. The real gateway keeps the
 * stricter behaviour: an AI failure there means "ask a human".
 */
export class FallbackAIProvider implements AIProvider {
  readonly name: string;
  constructor(
    private readonly primary: AIProvider,
    private readonly secondary: AIProvider,
  ) {
    this.name = primary.name === secondary.name ? primary.name : `${primary.name.split(' (')[0]} (falls back to ${secondary.name} when busy)`;
  }

  private async attempt<T>(fn: (p: AIProvider) => Promise<T>): Promise<T> {
    if (this.primary === this.secondary) return fn(this.primary);
    try {
      return await fn(this.primary);
    } catch {
      return fn(this.secondary);
    }
  }

  compileMandate(...a: Parameters<AIProvider['compileMandate']>) {
    return this.attempt((p) => p.compileMandate(...a));
  }
  judgeIntent(...a: Parameters<AIProvider['judgeIntent']>) {
    return this.attempt((p) => p.judgeIntent(...a));
  }
  scanUntrusted(...a: Parameters<AIProvider['scanUntrusted']>) {
    return this.attempt((p) => p.scanUntrusted(...a));
  }
  proposeRemedy(...a: Parameters<AIProvider['proposeRemedy']>) {
    return this.attempt((p) => p.proposeRemedy(...a));
  }
}
