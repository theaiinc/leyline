import { parsePublishedPricing, PublicPricingModel, toPublicPricingModel } from './pricing';

export type CatalogProviderKind = 'direct' | 'llm-api' | 'media';

export type CatalogProviderSnapshot = {
  name: string;
  kind: CatalogProviderKind;
  direct?: boolean;
  priceSource?: string;
  models: Array<{
    id: string;
    name?: string;
    pricing?: unknown;
    input_price?: unknown;
    output_price?: unknown;
    capabilities?: string[];
  }>;
};

export type OfferedCatalogModel = PublicPricingModel & {
  direct: boolean;
  capabilities: string[];
  /** Provider or upstream source that published the price. */
  priceSource: string;
};

export type OfferedModelCatalog = {
  models: OfferedCatalogModel[];
  byProvider: Record<string, OfferedCatalogModel[]>;
};

/**
 * Build the public catalogue from provider model-list responses.
 *
 * Provider listings are deliberately filtered here rather than falling back to
 * router/default prices: an unpriced model is not an offered model.
 */
export function buildOfferedModelCatalog(
  providers: readonly CatalogProviderSnapshot[],
  freeModels: readonly string[] = [],
): OfferedModelCatalog {
  const models: OfferedCatalogModel[] = [];
  const byProvider: Record<string, OfferedCatalogModel[]> = {};

  for (const provider of providers) {
    const offered: OfferedCatalogModel[] = [];
    for (const detail of provider.models) {
      const pricing = toPublicPricingModel(provider.name, detail, freeModels);
      if (!pricing) continue;
      const model: OfferedCatalogModel = {
        ...pricing,
        direct: provider.direct ?? provider.kind === 'direct',
        capabilities: detail.capabilities ?? ['chat'],
        priceSource: provider.priceSource ?? provider.name,
      };
      offered.push(model);
      models.push(model);
    }
    if (offered.length) byProvider[provider.name] = offered;
  }

  return { models, byProvider };
}

/** True when an upstream response means the provider is out of credit. */
export function isInsufficientBalanceError(error: unknown): boolean {
  const value = error as {
    response?: { status?: unknown; data?: unknown };
    status?: unknown;
    message?: unknown;
  } | undefined;
  const status = Number(value?.response?.status ?? value?.status);
  if (status === 402) return true;
  const text = JSON.stringify(value?.response?.data ?? value?.message ?? error).toLowerCase();
  return /insufficient\s+(?:balance|credit)|out\s+of\s+credit|credit\s+limit|billing\s+hard.?limit/i.test(text);
}

/** Normalize an OpenAI-compatible GET /models payload without inventing pricing. */
export function parseLlmApiModels(payload: unknown): CatalogProviderSnapshot['models'] {
  const rows = Array.isArray(payload)
    ? payload
    : (payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : []);
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const item = row as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id : '';
    if (!id) return [];
    const pricing = item.pricing ?? item.price ?? item.prices;
    return [{
      id,
      name: typeof item.name === 'string' ? item.name : undefined,
      pricing,
      input_price: item.input_price ?? item.inputPrice,
      output_price: item.output_price ?? item.outputPrice,
      capabilities: Array.isArray(item.capabilities)
        ? item.capabilities.filter((value): value is string => typeof value === 'string')
        : ['chat'],
    }];
  });
}

/** Merge provider snapshots while retaining the provider that published each price. */
export function mergeOfferedModelCatalog(
  snapshots: readonly CatalogProviderSnapshot[],
  freeModels: readonly string[] = [],
): OfferedModelCatalog {
  return buildOfferedModelCatalog(snapshots, freeModels);
}
