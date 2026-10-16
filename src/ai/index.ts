import { AnthropicProvider } from './anthropic.js';
import { HeuristicProvider } from './heuristic.js';
import type { AIProvider } from './provider.js';

export function createAIProvider(opts: { apiKey?: string; model: string }): AIProvider {
  return opts.apiKey ? new AnthropicProvider({ apiKey: opts.apiKey, model: opts.model }) : new HeuristicProvider();
}

export type { AIProvider } from './provider.js';
export { HeuristicProvider } from './heuristic.js';
export { AnthropicProvider } from './anthropic.js';
