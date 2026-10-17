import { AnthropicProvider } from './anthropic.js';
import { HeuristicProvider } from './heuristic.js';
import { openAiCompatibleClient } from './openai-compatible.js';
import type { AIProvider } from './provider.js';

export interface AIConfig {
  anthropic: { apiKey?: string; model: string };
  openai: { apiKey?: string; baseUrl: string; model: string };
}

/** Claude if ANTHROPIC_API_KEY is set, else any OpenAI-compatible API (e.g. Gemini's free tier) if AI_API_KEY is set, else the offline fallback. */
export function createAIProvider(cfg: AIConfig): AIProvider {
  if (cfg.anthropic.apiKey) return new AnthropicProvider({ apiKey: cfg.anthropic.apiKey, model: cfg.anthropic.model });
  if (cfg.openai.apiKey) {
    // AI_MODEL may list several models, comma-separated: the first is preferred, the rest are fallbacks.
    const [primary, ...fallbackModels] = cfg.openai.model.split(',').map((m) => m.trim()).filter(Boolean);
    const client = openAiCompatibleClient({ baseUrl: cfg.openai.baseUrl, apiKey: cfg.openai.apiKey, fallbackModels });
    const label = cfg.openai.baseUrl.includes('generativelanguage.googleapis.com') ? 'gemini' : 'openai-compatible';
    const model = primary ?? 'unset';
    const displayName = `${label}:${model}${fallbackModels.length ? ` (fallbacks: ${fallbackModels.join(', ')})` : ''}`;
    return new AnthropicProvider({ apiKey: cfg.openai.apiKey, model, client, label, displayName });
  }
  return new HeuristicProvider();
}

export type { AIProvider } from './provider.js';
export { HeuristicProvider } from './heuristic.js';
export { AnthropicProvider } from './anthropic.js';
export { openAiCompatibleClient } from './openai-compatible.js';
