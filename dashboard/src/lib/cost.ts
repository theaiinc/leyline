export type CostUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  cache_read_input_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
};

export type ModelPrice = {
  model: string;
  input: number;
  output: number;
  cachedInput?: number;
  freeTier?: number;
};

export type PricingEntry = {
  model?: string;
  input?: number;
  output?: number;
  cachedInput?: number;
  cached_input?: number;
  freeTier?: number;
};

export type RunCost = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  servedModel: string;
  cost?: number;
  priceLabel?: string;
};

export function calculateRunCost({
  usage,
  pricing,
  servedModel,
}: {
  usage: CostUsage;
  pricing?: PricingEntry;
  servedModel: string;
}): RunCost {
  const inputTokens = Number(usage.prompt_tokens ?? 0);
  const outputTokens = Number(usage.completion_tokens ?? 0);
  const cachedTokens = Number(usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0);
  const result: RunCost = { inputTokens, outputTokens, cachedTokens, servedModel };
  if (!pricing || typeof pricing.input !== 'number' || typeof pricing.output !== 'number') {
    result.priceLabel = 'price not published';
    return result;
  }
  result.cost = costForTokens(
    inputTokens,
    outputTokens,
    {
      model: servedModel,
      input: pricing.input,
      output: pricing.output,
      cachedInput: pricing.cachedInput ?? pricing.cached_input,
    },
    cachedTokens,
  );
  return result;
}

export type DisplayUsage = {
  input: number;
  output: number;
  cached: number;
  servedModel: string;
  cost?: number;
};

export function displayUsage(data: { usage?: Record<string, unknown>; model?: string }, fallbackModel: string, prices: Record<string, ModelPrice>, fallbackPrice?: ModelPrice): DisplayUsage {
  const raw = data.usage ?? {};
  const input = Number(raw.prompt_tokens ?? 0);
  const output = Number(raw.completion_tokens ?? 0);
  const cached = Number(raw.cached_tokens ?? raw.cache_read_input_tokens ?? 0);
  const safeCached = Number.isFinite(cached) ? cached : 0;
  const servedModel = data.model || fallbackModel;
  return {
    input,
    output,
    cached: safeCached,
    servedModel,
    cost: costForTokens(input, output, prices[servedModel] ?? fallbackPrice, safeCached),
  };
}

export function costForTokens(inputTokens: number, outputTokens: number, price?: ModelPrice, cachedTokens = 0): number | undefined {
  if (!price) return undefined;
  const regularInput = Math.max(0, inputTokens - Math.max(0, cachedTokens));
  const cachedRate = price.cachedInput ?? price.input;
  return regularInput * price.input / 1_000_000 + Math.max(0, cachedTokens) * cachedRate / 1_000_000 + Math.max(0, outputTokens) * price.output / 1_000_000;
}

export function formatUsd(value: number | undefined): string {
  if (value === undefined) return 'price not published';
  if (value === 0) return '$0.00';
  return `$${value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
}

export function usageCost(usage: CostUsage | undefined, price?: ModelPrice): number | undefined {
  if (!usage) return undefined;
  const input = Number(usage.prompt_tokens ?? 0);
  const output = Number(usage.completion_tokens ?? 0);
  const cached = Number(usage.cached_tokens ?? usage.cache_read_input_tokens ?? 0);
  return costForTokens(input, output, price, Number.isFinite(cached) ? cached : 0);
}

export function monthlyCost(inputTokens: number, outputTokens: number, requests: number, price?: ModelPrice): number | undefined {
  const perRequest = costForTokens(inputTokens, outputTokens, price);
  return perRequest === undefined ? undefined : perRequest * Math.max(0, requests);
}

export function freeTierRemaining(monthlySpend: number, freeTier = 0): number {
  return Math.max(0, freeTier - monthlySpend);
}