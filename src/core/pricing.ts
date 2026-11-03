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

export type ProviderCredit = {
  provider: string;
  amountUsd: number;
  expiresAt: string;
};

export type FreeGrant = {
  remainingTokens: number;
  expiresAt: string;
};

export type FreeTierCandidate = {
  id: string;
  provider: string;
  input: number;
  output: number;
  healthy?: boolean;
};

/** A grant is usable only while it has balance and has not reached its expiry instant. */
export function canUseFreeGrant(grant: FreeGrant, now = Date.now()): boolean {
  const expiry = Date.parse(grant.expiresAt);
  return grant.remainingTokens > 0 && Number.isFinite(expiry) && now < expiry;
}

/**
 * Select a free-tier model after capability filtering. A pinned model outside the eligible
 * set returns undefined so the caller can bill it normally instead of silently switching models.
 */
export function selectFreeTierCandidate(
  candidates: readonly FreeTierCandidate[],
  eligibleModelIds: readonly string[],
  options: {
    pinnedModel?: string;
    credits?: readonly ProviderCredit[];
    volumeDiscountProviders?: readonly string[];
    providerBudgetsUsd?: Record<string, number>;
    providerSpendUsd?: Record<string, number>;
    now?: number;
  } = {},
): FreeTierCandidate | undefined {
  if (options.pinnedModel && !eligibleModelIds.includes(options.pinnedModel)) return undefined;
  const eligible = candidates.filter((candidate) =>
    eligibleModelIds.includes(candidate.id)
    && candidate.healthy !== false
    && (options.pinnedModel === undefined || candidate.id === options.pinnedModel)
    && (options.providerBudgetsUsd?.[candidate.provider] === undefined
      || (options.providerSpendUsd?.[candidate.provider] ?? 0) < options.providerBudgetsUsd[candidate.provider]),
  );
  return rankFreeTierProviders(eligible, options.credits, options.volumeDiscountProviders, options.now)[0];
}

/** Deterministic provider ordering for a free request. Credits expiring soon win, then discounts, then price. */
export function rankFreeTierProviders<T extends { provider: string; input: number; output: number }>(
  models: readonly T[],
  credits: readonly ProviderCredit[] = [],
  volumeDiscountProviders: readonly string[] = [],
  now = Date.now(),
): T[] {
  const creditRank = new Map<string, number>();
  for (const credit of credits) {
    const expiry = Date.parse(credit.expiresAt);
    if (!Number.isFinite(expiry) || credit.amountUsd <= 0 || expiry <= now) continue;
    const current = creditRank.get(credit.provider);
    if (current === undefined || expiry < current) creditRank.set(credit.provider, expiry);
  }
  const discountRank = new Set(volumeDiscountProviders);
  return [...models].sort((a, b) => {
    const ac = creditRank.get(a.provider);
    const bc = creditRank.get(b.provider);
    if (ac !== undefined || bc !== undefined) {
      if (ac === undefined) return 1;
      if (bc === undefined) return -1;
      if (ac !== bc) return ac - bc;
    }
    const ad = discountRank.has(a.provider);
    const bd = discountRank.has(b.provider);
    if (ad !== bd) return ad ? -1 : 1;
    return (a.input + a.output) - (b.input + b.output);
  });
}

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
    source: OFFICIAL_PRICING_PAGES[provider] ?? 'https://github.com/theaiinc/leyline',
  };
}
