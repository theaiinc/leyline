/**
 * Prices providers publish in their model lists. llmapi.ai and OpenRouter both give `pricing.prompt` and
 * `pricing.completion` as US dollars per token (strings); Leyline works in dollars per million tokens.
 */
export function parsePublishedPricing(pricing: unknown): { input: number; output: number } | undefined {
  if (!pricing || typeof pricing !== 'object') return undefined;
  const p = pricing as { prompt?: unknown; completion?: unknown };
  const input = Number(p.prompt);
  const output = Number(p.completion);
  if (p.prompt === undefined || p.completion === undefined || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
    return undefined;
  }
  // Rounded to a millionth of a dollar per million tokens: per-token strings carry float noise.
  const perMillion = (n: number) => Math.round(n * 1e12) / 1e6;
  return { input: perMillion(input), output: perMillion(output) };
}

/**
 * List prices (US dollars per million tokens) for models whose providers publish none in their model lists:
 * embeddings mostly (OpenAI, Gemini and Workers AI list no prices). Used like a published price: a price set by
 * hand on the dashboard wins, and with published prices switched off these don't apply either.
 */
export const BUILTIN_PRICES: Record<string, { input: number; output: number }> = {
  'text-embedding-3-small': { input: 0.02, output: 0 },
  'text-embedding-3-large': { input: 0.13, output: 0 },
  'text-embedding-ada-002': { input: 0.1, output: 0 },
  'gemini-embedding-001': { input: 0.15, output: 0 },
  '@cf/baai/bge-m3': { input: 0.012, output: 0 },
  '@cf/baai/bge-small-en-v1.5': { input: 0.02, output: 0 },
  '@cf/baai/bge-base-en-v1.5': { input: 0.067, output: 0 },
  '@cf/baai/bge-large-en-v1.5': { input: 0.204, output: 0 },
};

/** A built-in list price for a model (also under a gateway prefix such as openai/text-embedding-3-small). */
export function builtinPrice(model: string): { input: number; output: number } | undefined {
  return BUILTIN_PRICES[model] ?? BUILTIN_PRICES[model.split('/').pop() ?? model];
}
