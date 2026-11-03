/**
 * Prices providers publish in their model lists. llmapi.ai and OpenRouter both give `pricing.prompt` and
 * `pricing.completion` as US dollars per token (strings); Leyline works in dollars per million tokens.
 */
export function parsePublishedPricing(pricing: unknown): { input: number; output: number; cachedInput?: number } | undefined {
  if (!pricing || typeof pricing !== 'object') return undefined;
  const p = pricing as { prompt?: unknown; completion?: unknown };
  const input = Number(p.prompt);
  const output = Number(p.completion);
  if (p.prompt === undefined || p.completion === undefined || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
    return undefined;
  }
  // Rounded to a millionth of a dollar per million tokens: per-token strings carry float noise.
  const perMillion = (n: number) => Math.round(n * 1e12) / 1e6;
  const cached = Number((pricing as { cache_read?: unknown; cached_input?: unknown }).cache_read ?? (pricing as { cached_input?: unknown }).cached_input);
  return { input: perMillion(input), output: perMillion(output), ...(Number.isFinite(cached) && cached >= 0 ? { cachedInput: perMillion(cached) } : {}) };
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

export type PublicPricingModel = {
  id: string;
  name: string;
  provider: string;
  input: number;
  output: number;
  cached_input?: number;
  free_tier: boolean;
  source: string;
};

/** Public defaults for the Valefront product's free grant. Billing state is private-product data. */
export const DEFAULT_FREE_TIER_TOKENS = 1_000_000;
export const DEFAULT_FREE_TIER_EXPIRES_AFTER_DAYS = 30;

/** BytePlus ModelArk chat models covered by the public free-tier offer. */
import { config } from '../config';

/** Verified free-tier model IDs, supplied by deployment configuration. */
export const FREE_TIER_MODEL_IDS = config.freeTierModels;

const OFFICIAL_PRICING_PAGES: Record<string, string> = {
  Anthropic: 'https://www.anthropic.com/pricing',
  AzureOpenAI: 'https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/',
  BytePlus: 'https://www.byteplus.com/en/product/modelark/pricing',
  Gemini: 'https://ai.google.dev/pricing',
  HuggingFace: 'https://huggingface.co/pricing',
  OpenAI: 'https://openai.com/api/pricing/',
  OpenRouter: 'https://openrouter.ai/pricing',
};

function modelPricing(model: unknown): { input: number; output: number; cachedInput?: number } | undefined {
  if (!model || typeof model !== 'object') return undefined;
  const detail = model as { pricing?: unknown; input_price?: unknown; output_price?: unknown };
  const parsed = parsePublishedPricing(detail.pricing);
  if (parsed) return parsed;
  if (detail.pricing && typeof detail.pricing === 'object') {
    const normalized = detail.pricing as { input?: unknown; output?: unknown };
    const input = Number(normalized.input);
    const output = Number(normalized.output);
    if (Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0) {
      return { input, output };
    }
  }
  const input = Number(detail.input_price);
  const output = Number(detail.output_price);
  return Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0
    ? { input, output }
    : undefined;
}

export function toPublicPricingModel(
  provider: string,
  model: { id?: unknown; name?: unknown; pricing?: unknown; input_price?: unknown; output_price?: unknown },
  freeModels: readonly string[] = [],
): PublicPricingModel | undefined {
  const id = typeof model.id === 'string' ? model.id : '';
  const prices = modelPricing(model);
  if (!id || !prices) return undefined;
  return {
    id,
    name: typeof model.name === 'string' && model.name ? model.name : id,
    provider,
    ...prices,
    free_tier: freeModels.includes(id),
    source: OFFICIAL_PRICING_PAGES[provider] ?? 'https://www.theaiinc.com/',
  };
}
