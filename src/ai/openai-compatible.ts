import type { MessagesClient } from './anthropic.js';

/** Statuses where another model may well succeed: not found, rate-limited, overloaded or server errors. */
const RETRYABLE = (status: number) => status === 404 || status === 408 || status === 429 || status >= 500;

/**
 * Adapts any OpenAI-compatible chat-completions API (for example Google's Gemini
 * API at https://generativelanguage.googleapis.com/v1beta/openai) to the small
 * MessagesClient interface the LLM provider uses. Same prompts, same zod
 * validation, same fail-safe behaviour; only the transport differs.
 *
 * Free tiers are often overloaded, so the client tries `args.model` and then each
 * of `fallbackModels` in turn when a model is busy, missing, slow or rate-limited.
 * If every model fails it throws, and the gateway treats that as "ask a human".
 */
export function openAiCompatibleClient(opts: {
  baseUrl: string;
  apiKey: string;
  fallbackModels?: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): MessagesClient {
  const base = opts.baseUrl.replace(/\/$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  type Body = { choices?: { message?: { content?: string | null } }[]; error?: { message?: string } };

  return {
    messages: {
      async create(args) {
        const models = [args.model, ...(opts.fallbackModels ?? []).filter((m) => m !== args.model)];
        const failures: string[] = [];
        for (const model of models) {
          let res: Response;
          try {
            res = await doFetch(`${base}/chat/completions`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model,
                // Some models spend tokens on hidden reasoning before answering, so a tight
                // cap can cut the JSON off. A generous floor avoids that; replies stay small.
                max_tokens: Math.max(args.max_tokens, 4096),
                messages: [{ role: 'system', content: args.system }, ...args.messages],
              }),
              signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
            });
          } catch (e) {
            // Timeouts and network errors: try the next model.
            failures.push(`${model}: ${e instanceof Error ? e.name : 'network error'}`);
            continue;
          }
          const raw = (await res.json().catch(() => ({}))) as Body | Body[];
          // Some providers (Gemini among them) wrap error bodies in a one-element array.
          const json: Body = Array.isArray(raw) ? (raw[0] ?? {}) : raw;
          if (!res.ok) {
            const reason = `${model}: HTTP ${res.status} ${json.error?.message?.slice(0, 120) ?? ''}`.trim();
            if (RETRYABLE(res.status)) {
              failures.push(reason);
              continue;
            }
            // 400/401/403 and friends: a bad request or bad key will not improve on another model.
            throw new Error(`AI API error ${reason}`);
          }
          const text = json.choices?.[0]?.message?.content ?? '';
          if (!text) {
            failures.push(`${model}: empty reply`);
            continue;
          }
          return { content: [{ type: 'text', text }] };
        }
        throw new Error(`AI API unavailable; every model failed (${failures.join('; ')})`);
      },
    },
  };
}
