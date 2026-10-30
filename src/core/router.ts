import { config } from '../config';
import {
  Provider,
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  ClassifyRequest,
  RouterClassification,
  RouteResult,
  RouteOptions,
  TierConfig,
  Capability,
  servesChat,
} from './types';
import { CapabilityError, errorStatus } from './media';
import { QuotaManager } from './quota-manager';
import { ModelRegistry } from './model-registry';
import { Classifier } from './classifier';
import { logger } from './logger';
import { maybeCompress } from './compress';
import { formatProviderError, hydrateAxiosError } from './api-errors';
import { ensureMessageArray } from './normalize-request';
import { requestHasNonTextContent } from './content';

type UsageSnapshot = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  cache_creation_input_tokens?: number;
};

function normalizeUsage(usage: unknown): UsageSnapshot | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const normalized = usage as {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  const cached_tokens = normalized.cached_tokens ?? normalized.prompt_tokens_details?.cached_tokens ?? normalized.cache_read_input_tokens;
  const cache_creation_input_tokens = normalized.cache_creation_input_tokens;
  const hasUsage = normalized.prompt_tokens !== undefined || normalized.completion_tokens !== undefined || normalized.total_tokens !== undefined || cached_tokens !== undefined || cache_creation_input_tokens !== undefined;
  if (!hasUsage) return undefined;
  return {
    prompt_tokens: normalized.prompt_tokens,
    completion_tokens: normalized.completion_tokens,
    total_tokens: normalized.total_tokens,
    ...(cached_tokens === undefined ? {} : { cached_tokens }),
    ...(cache_creation_input_tokens === undefined ? {} : { cache_creation_input_tokens }),
  };
}

function usageFromStreamChunk(chunk: StreamChunk): UsageSnapshot | undefined {
  return normalizeUsage(chunk.usage);
}

function streamLogUsage(providerUsage: UsageSnapshot | undefined, chars: number): UsageSnapshot | { chars: number } {
  return providerUsage ?? { chars };
}

interface RequestAwareProvider extends Provider {
  canHandle?(request: CompletionRequest): Promise<boolean>;
}

async function providerCanHandle(
  provider: Provider,
  request: CompletionRequest,
  effectiveModel: string,
): Promise<boolean> {
  const candidate = provider as RequestAwareProvider;
  if (typeof candidate.canHandle !== 'function') return true;
  return candidate.canHandle({ ...request, model: effectiveModel });
}

/**
 * A request with images (or audio, files) that no provider able to read them could take: a 400 naming the
 * providers that can't, rather than a model answering about an image it never received.
 */
export class UnsupportedContentError extends Error {
  readonly status = 400;
  readonly response: { status: number; data: { error: { message: string; type: string; code: string } } };

  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedContentError';
    this.response = { status: 400, data: { error: { message, type: 'invalid_request_error', code: 'unsupported_content' } } };
  }
}

/** Whether a provider can take the request's non-text content (always, for a text-only request). */
function providerAcceptsContent(provider: Provider, request: CompletionRequest, effectiveModel: string): boolean {
  if (!requestHasNonTextContent(request.messages)) return true;
  return provider.acceptsNonTextContent?.({ ...request, model: effectiveModel }) ?? true;
}

function unsupportedContent(providers: string[], model: string): UnsupportedContentError {
  const who = providers.join(', ');
  return new UnsupportedContentError(
    `The request has images (or other non-text content) but ${who} can't read them for model "${model}", and no provider that can is available. Ask for a vision-capable model.`,
  );
}

// ── Router options (backward-compatible: all optional) ─────────────

export interface RouterOptions {
  quotaManager?: QuotaManager;
  modelRegistry?: ModelRegistry;
  classifier?: Classifier;
  tierConfig?: TierConfig;
  singleModel?: SingleModelRouterConfig;
  /**
   * Model pool: provider name → model ids the router may use when the
   * request model is 'auto'. When at least one provider has a non-empty
   * list, only those models are candidates; providers without enabled
   * models are skipped. When unset (or every list is empty) all models
   * are candidates (legacy behavior).
   */
  enabledModels?: Record<string, string[]>;
  /**
   * Code policy function: maps a RouterClassification to a tier label.
   * Defaults to the built-in `selectModelByRouter` policy.
   */
  codePolicy?: (classification: RouterClassification | null) => string;
  /**
   * Default service type to tier mapping.
   * Keys are service names, values are tier labels (e.g. '2b', '4b', '12b').
   */
  serviceTiers?: Record<string, string>;
}

export interface SingleModelRouterConfig {
  enabled: boolean;
  provider?: string | null;
  model?: string | null;
}

// ── Service type detection ─────────────────────────────────────────

const MODEL_ID_CACHE_TTL_MS = 3600 * 1000;

/** Model lists by provider name, as shared between instances. */
export type ModelListSnapshot = Record<string, { ids: string[]; timestamp: number; prices?: Record<string, { input: number; output: number }> }>;

const DEFAULT_SERVICE_TIERS: Record<string, string> = {
  casual: '4b',
  teaching: '4b',
  tool_use: '12b',
  complex: '12b',
};

/**
 * Built-in code policy — a deterministic function that maps a router
 * classification (complexity/domain/reasoning) to a model tier.
 *
 * The router *describes* the request; this function *decides* the tier.
 * This way the routing policy can evolve without retraining the router model.
 *
 * Policy logic:
 *   - memory / extraction      → 2b
 *   - coding + medium/complex   → 12b
 *   - planning / workflow       → 12b
 *   - reasoning                 → 12b
 *   - simple                    → 2b
 *   - medium                    → 4b
 *   - complex                   → 12b
 */
export function selectModelByRouter(
  classification: RouterClassification | null,
): string {
  if (!classification) return '4b';  // default to operational if router fails
  const d = classification.domain;
  const c = classification.complexity;
  const r = classification.reasoning;

  // Domain-first rules
  if (d === 'memory' || d === 'extraction') return '2b';
  if (d === 'workflow') return '12b';
  if (d === 'coding' && (c === 'medium' || c === 'complex')) return '12b';
  if (d === 'planning') return '12b';

  // Reasoning flag overrides complexity
  if (r) return '12b';

  // Complexity-based
  if (c === 'simple') return '2b';
  if (c === 'medium') return '4b';
  return '12b';
}

/**
 * Resolve the model name for a given tier label from the TierConfig.
 */
function resolveTierModel(tier: string, tierConfig: TierConfig): string | null {
  return tierConfig[tier] || null;
}

// ── Router ─────────────────────────────────────────────────────────

export class Router {
  private providers: Provider[] = [];
  private quotaManager: QuotaManager;
  private modelRegistry: ModelRegistry;
  private classifier?: Classifier;
  private tierConfig: TierConfig;
  private codePolicy: (classification: RouterClassification | null) => string;
  private serviceTiers: Record<string, string>;
  private singleModel?: SingleModelRouterConfig;
  private enabledModels?: Record<string, string[]>;
  private providerModelIds = new Map<string, { ids: Set<string>; timestamp: number; prices?: Map<string, { input: number; output: number }> }>();
  private modelPins = new Map<string, string>();

  constructor(quotaManagerOrOptions?: QuotaManager | RouterOptions) {
    // Backward-compatible constructor: accept QuotaManager directly or RouterOptions
    if (quotaManagerOrOptions instanceof QuotaManager) {
      this.quotaManager = quotaManagerOrOptions;
      this.modelRegistry = new ModelRegistry();
      this.tierConfig = {};
      this.codePolicy = selectModelByRouter;
      this.serviceTiers = { ...DEFAULT_SERVICE_TIERS };
      this.singleModel = undefined;
    } else {
      const opts = quotaManagerOrOptions ?? {};
      this.quotaManager = opts.quotaManager ?? new QuotaManager();
      this.modelRegistry = opts.modelRegistry ?? new ModelRegistry();
      this.classifier = opts.classifier;
      this.tierConfig = opts.tierConfig ?? {};
      this.codePolicy = opts.codePolicy ?? selectModelByRouter;
      this.serviceTiers = opts.serviceTiers ?? { ...DEFAULT_SERVICE_TIERS };
      this.singleModel = opts.singleModel;
      this.enabledModels = opts.enabledModels;
    }
  }

  // ── Provider management (existing) ──────────────────────────────

  addProvider(provider: Provider) {
    this.providers.push(provider);
  }

  getProviders(): Provider[] {
    return this.providers;
  }

  /** Unregister a provider by exact name. Returns false if it wasn't registered. */
  removeProvider(name: string): boolean {
    const index = this.providers.findIndex(p => p.name === name);
    if (index === -1) return false;
    this.providers.splice(index, 1);
    this.providerModelIds.delete(name);
    for (const [model, pinned] of this.modelPins) {
      if (pinned === name) this.modelPins.delete(model);
    }
    return true;
  }

  // ── Model pool (per-model enable/disable) ───────────────────────

  /** Replace the enabled-model pool at runtime. Pass undefined to allow all models. */
  setEnabledModels(enabledModels?: Record<string, string[]>) {
    this.enabledModels = enabledModels;
  }

  getEnabledModels(): Record<string, string[]> | undefined {
    return this.enabledModels;
  }

  /** True when the pool constrains routing (at least one non-empty list). */
  private hasActiveModelPool(): boolean {
    return Boolean(
      this.enabledModels
      && Object.values(this.enabledModels).some(models => Array.isArray(models) && models.length > 0),
    );
  }

  /** Enabled models for a provider, or null when the pool is inactive. */
  private enabledModelsFor(provider: Provider): string[] | null {
    if (!this.hasActiveModelPool()) return null;
    const norm = normalizeProviderName(provider.name);
    for (const [key, models] of Object.entries(this.enabledModels!)) {
      if (normalizeProviderName(key) === norm) return models;
    }
    return [];
  }

  /**
   * Pick the model a provider should serve for an 'auto' request, or null
   * when the provider has no enabled models and must be skipped.
   */
  private async autoModelFor(provider: Provider, request?: CompletionRequest): Promise<string | null> {
    const enabled = this.enabledModelsFor(provider);
    if (enabled && enabled.length === 0) return null;

    const parts = (request?.messages ?? []).flatMap(message =>
      Array.isArray(message.content) ? message.content : [],
    );
    const needsVision = parts.some(part => part.type === 'image_url');
    const needsAudio = parts.some(part => part.type === 'input_audio');

    if (needsVision || needsAudio) {
      const capabilities = provider.capabilities;
      // Provider-wide metadata can exclude providers that cannot handle the
      // requested modality; gateway model metadata remains authoritative when
      // it advertises a specific media-capable model.
      if (capabilities?.length &&
          ((needsVision && !capabilities.includes('vision')) ||
           (needsAudio && !capabilities.includes('audio')))) {
        const preferredMediaModel = config.autoVisionModel ?? 'gemini-2.5-flash-lite';
        if (!preferredMediaModel || (enabled && !enabled.includes(preferredMediaModel))
            || !(await this.providerListsModel(provider, preferredMediaModel))) {
          return null;
        }
      }
      const preferredMediaModel = config.autoVisionModel ?? 'gemini-2.5-flash-lite';
      if (preferredMediaModel && (!enabled || enabled.includes(preferredMediaModel))
          && await this.providerListsModel(provider, preferredMediaModel)) {
        return preferredMediaModel;
      }
      const mediaModel = provider.defaultModelFor?.(
        needsAudio ? 'audio' : 'vision',
      );
      if (mediaModel && (!enabled || enabled.includes(mediaModel))
          && await this.providerListsModel(provider, mediaModel)) {
        return mediaModel;
      }
    }

    if (!enabled) return provider.defaultModel;
    return enabled.includes(provider.defaultModel) ? provider.defaultModel : enabled[0];
  }

  private async providerListsModel(provider: Provider, model: string): Promise<boolean> {
    const cached = this.providerModelIds.get(provider.name);
    if (cached && Date.now() - cached.timestamp < MODEL_ID_CACHE_TTL_MS) {
      return cached.ids.has(model);
    }
    await this.reindexProvider(provider);
    return this.providerModelIds.get(provider.name)?.ids.has(model) ?? false;
  }

  /** Refresh the cached model-id list for one provider (used eagerly and lazily). */
  async reindexProvider(provider: Provider): Promise<void> {
    let ids = new Set<string>();
    const prices = new Map<string, { input: number; output: number }>();
    try {
      const details = await provider.getModels();
      ids = new Set(details.map(detail => detail.id));
      for (const detail of details) if (detail.pricing) prices.set(detail.id, detail.pricing);
    } catch {
      // Provider offline or unlistable — treat as unknown and retry later.
    }
    this.providerModelIds.set(provider.name, { ids, timestamp: Date.now(), prices });
  }

  /** The price a provider publishes for a model (US$ per million tokens), from its last model list. */
  publishedPrice(providerName: string, model: string): { input: number; output: number } | undefined {
    return this.providerModelIds.get(providerName)?.prices?.get(model);
  }

  /**
   * Any provider's published price for a model: for a provider that publishes none (Anthropic lists models
   * without prices) serving a model a gateway prices (LLM API lists the same Claude models with theirs).
   */
  anyPublishedPrice(model: string): { input: number; output: number } | undefined {
    for (const entry of this.providerModelIds.values()) {
      const price = entry.prices?.get(model);
      if (price) return price;
    }
    return undefined;
  }

  /** How many models have a published price, per provider. */
  publishedPriceCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, entry] of this.providerModelIds) if (entry.prices?.size) out[name] = entry.prices.size;
    return out;
  }

  /** Eagerly refresh the model-id index for every registered provider. */
  async reindexAll(): Promise<void> {
    await Promise.all(this.providers.map(provider => this.reindexProvider(provider)));
  }

  /** Providers whose key is still loading (from Arcana Cloud): their requests wait for it, nobody else's do. */
  private readonly keysLoading = new Map<string, Promise<unknown>>();

  keyLoading(name: string, loading: Promise<unknown>): void {
    this.keysLoading.set(name, loading);
    void loading.finally(() => { if (this.keysLoading.get(name) === loading) this.keysLoading.delete(name); });
  }

  private async keyReady(provider: Provider): Promise<void> {
    const loading = this.keysLoading.get(provider.name);
    if (loading) await loading.catch(() => undefined);
  }

  /** Refresh only the providers whose model list is missing or older than the cache allows. */
  async reindexStale(now = Date.now()): Promise<void> {
    await Promise.all(this.providers
      .filter(provider => {
        if (this.keysLoading.has(provider.name)) return false; // listed once its key is in (see keyLoading)
        const cached = this.providerModelIds.get(provider.name);
        return !cached || now - cached.timestamp >= MODEL_ID_CACHE_TTL_MS;
      })
      .map(provider => this.reindexProvider(provider)));
  }

  /**
   * The providers' model lists, to share with other instances: listing every provider's models took ~2.5 s, and a
   * fresh Worker instance did it before answering its first request. Empty lists (a provider that couldn't be
   * listed) are left out so the next instance tries again.
   */
  exportModelLists(): ModelListSnapshot {
    const out: ModelListSnapshot = {};
    for (const [name, entry] of this.providerModelIds) {
      if (!entry.ids.size) continue;
      out[name] = { ids: [...entry.ids], timestamp: entry.timestamp, ...(entry.prices?.size ? { prices: Object.fromEntries(entry.prices) } : {}) };
    }
    return out;
  }

  /** Take model lists another instance made (exportModelLists), for providers this one has none for yet. */
  importModelLists(snapshot: ModelListSnapshot): void {
    for (const provider of this.providers) {
      const entry = snapshot[provider.name];
      if (!entry || this.providerModelIds.has(provider.name)) continue;
      this.providerModelIds.set(provider.name, { ids: new Set(entry.ids), timestamp: entry.timestamp, prices: new Map(Object.entries(entry.prices ?? {})) });
    }
  }

  /** When the oldest model list was made (null: none yet). */
  oldestModelList(): number | null {
    let oldest: number | null = null;
    for (const entry of this.providerModelIds.values()) oldest = oldest === null ? entry.timestamp : Math.min(oldest, entry.timestamp);
    return oldest;
  }

  /** Derived view of the model-id index: model id → provider names that list it, in priority order. */
  getModelIndex(): Record<string, string[]> {
    const index: Record<string, string[]> = {};
    for (const provider of this.providers) {
      const cached = this.providerModelIds.get(provider.name);
      if (!cached) continue;
      for (const modelId of cached.ids) {
        (index[modelId] ??= []).push(provider.name);
      }
    }
    return index;
  }

  /** Replace the model-id pin map (model id → preferred provider name) at runtime. */
  setModelPins(pins?: Record<string, string>) {
    this.modelPins = new Map(Object.entries(pins ?? {}));
  }

  getModelPins(): Record<string, string> {
    return Object.fromEntries(this.modelPins);
  }

  /**
   * Provider order for a request. For explicit model ids, providers that
   * enable or list that model are tried first; the original priority order
   * remains as failover so unknown ids keep the legacy behavior. When more
   * than one provider lists the model, a configured pin (if it names one of
   * the matches) is moved to the front to resolve the ambiguity.
   */
  private async candidateProviders(model: string): Promise<Provider[]> {
    // Providers that only do embeddings or audio (Deepgram) never take chat.
    const chat = this.providers.filter(servesChat);
    if (!model || model === 'auto') return chat;

    const matches: Provider[] = [];
    for (const provider of chat) {
      const enabled = this.enabledModelsFor(provider);
      if (enabled?.includes(model) || await this.providerListsModel(provider, model)) {
        matches.push(provider);
      }
    }
    // Nobody lists it (a deployment name, a model a provider doesn't advertise): try them all, as before.
    if (matches.length === 0) return chat;
    if (matches.length > 1) {
      const pinned = this.modelPins.get(model);
      const pinnedIndex = pinned ? matches.findIndex(p => p.name === pinned) : -1;
      if (pinnedIndex > 0) matches.unshift(matches.splice(pinnedIndex, 1)[0]);
    }
    // Only the providers that serve this model: falling through to the others would answer with a different
    // model (an Azure deployment answers whatever it's asked) while the client thinks it got the one it named.
    return matches;
  }

  // ── Embeddings, transcription, speech ───────────────────────────

  /** Providers that serve `model` for a capability: by name, or because they list it (gateways). */
  private async capabilityServers(capability: Capability, model: string): Promise<Provider[]> {
    const out: Provider[] = [];
    for (const provider of this.providers) {
      const providerCapability = provider.capabilities?.includes(capability) ?? false;
      const listedModel = provider.servesListedModels?.(capability)
        && await this.providerListsModel(provider, model);
      const servesListedModel = providerCapability && listedModel;
      const listedMediaModel = (capability === 'vision' || capability === 'audio') && listedModel;
      if ((providerCapability && (provider.servesModel?.(capability, model) || servesListedModel)) || listedMediaModel) {
        out.push(provider);
      }
    }
    const pinned = this.modelPins.get(model);
    const at = pinned ? out.findIndex(p => p.name === pinned) : -1;
    if (at > 0) out.unshift(out.splice(at, 1)[0]);
    return out;
  }

  /**
   * Run an embeddings / transcription / speech request on a provider that serves the model asked for, failing
   * over only to providers that serve that same model (vectors from another embedding model would not match an
   * index built with this one). `auto` takes the first configured provider's default model, in
   * CAPABILITY_PREFERENCE order. Errors the client caused (HTTP 400, 413, 415, 422) are not retried elsewhere.
   */
  async routeCapability<T>(
    capability: Exclude<Capability, 'chat'>,
    requested: string,
    run: (provider: Provider, model: string) => Promise<T>,
    opts: RouteOptions & { usageOf?: (result: T) => { prompt_tokens?: number; completion_tokens?: number } | undefined } = {},
  ): Promise<{ result: T; provider: string; model: string }> {
    const start = Date.now();
    const requestId = Math.random().toString(36).substring(7);
    const capable = this.providers.filter(p => p.capabilities?.includes(capability));
    let model = (requested || '').trim();
    let candidates: Provider[];

    if (opts.forceProvider) {
      const forced = capable.find(p => p.name === opts.forceProvider);
      if (!forced) throw new CapabilityError(400, 'unknown_provider', `Provider "${opts.forceProvider}" does not serve ${capability}.`);
      if (!model || model === 'auto') model = forced.defaultModelFor?.(capability) ?? '';
      if (!model) throw new CapabilityError(400, 'model_required', `Name a ${capability} model for ${forced.name}.`);
      candidates = [forced];
    } else if (!model || model === 'auto') {
      const preference = CAPABILITY_PREFERENCE[capability];
      const rank = (p: Provider) => {
        const i = preference.indexOf(p.name);
        return i === -1 ? preference.length : i;
      };
      let first: Provider | undefined;
      for (const provider of [...capable].sort((a, b) => rank(a) - rank(b))) {
        if (provider.defaultModelFor?.(capability) && await provider.isAvailable()) {
          first = provider;
          break;
        }
      }
      if (!first) throw new CapabilityError(503, 'no_provider', `No provider is configured for ${capability}.`);
      model = first.defaultModelFor!(capability)!;
      candidates = [first, ...(await this.capabilityServers(capability, model)).filter(p => p !== first)];
    } else {
      candidates = await this.capabilityServers(capability, model);
      if (candidates.length === 0) {
        throw new CapabilityError(404, 'model_not_found', `No provider here serves the ${capability} model "${model}".`);
      }
    }

    let lastError: unknown;
    for (const provider of candidates) {
      if (!this.quotaManager.checkQuota(provider.name)) {
        logger.log({ requestId, provider: provider.name, model, status: 'rate_limited', error: 'Quota exceeded' });
        continue;
      }
      if (!(await provider.isAvailable())) {
        logger.log({ requestId, provider: provider.name, model, status: 'error', error: `${provider.name} reported unavailable`, duration: Date.now() - start });
        continue;
      }
      try {
        await this.keyReady(provider);
        const result = await run(provider, model);
        opts.onServed?.(provider.name, model);
        this.quotaManager.incrementUsage(provider.name);
        logger.log({ requestId, provider: provider.name, model, status: 'success', duration: Date.now() - start, usage: opts.usageOf?.(result) });
        return { result, provider: provider.name, model };
      } catch (error) {
        lastError = await hydrateAxiosError(error);
        logger.log({ requestId, provider: provider.name, model, status: 'error', error: formatProviderError(lastError), duration: Date.now() - start });
        console.error(`[Router] ${capability} error with ${provider.name}:`, formatProviderError(lastError));
        const status = errorStatus(lastError);
        if (status === 400 || status === 413 || status === 415 || status === 422) throw lastError;
      }
    }
    throw lastError ?? new CapabilityError(503, 'no_provider', `No provider serving "${model}" is available for ${capability}.`);
  }

  // ── Route execution (existing) ──────────────────────────────────

  private async prepareRoutedRequest(request: CompletionRequest): Promise<CompletionRequest> {
    const compressed = await maybeCompress(request);
    const messages = ensureMessageArray(compressed.messages);
    return { ...compressed, messages };
  }

  /** A request whose only providers are at their monthly spend limit: 429, saying whose limit. */
  private budgetRefusal(excluded: string[]): CapabilityError {
    return new CapabilityError(429, 'provider_budget_exhausted',
      `${excluded.join(', ')} reached ${excluded.length > 1 ? 'their' : 'its'} spending limit for the month; it resets on the 1st (UTC).`);
  }

  async route(request: CompletionRequest, opts?: RouteOptions): Promise<CompletionResponse> {
    const start = Date.now();
    const requestId = Math.random().toString(36).substring(7);

    const routedRequest = await this.prepareRoutedRequest(request);

    if (opts?.forceProvider) {
      const provider = this.providers.find(p => p.name === opts.forceProvider);
      if (!provider) {
        throw new Error(`Provider "${opts.forceProvider}" is not registered.`);
      }
      if (opts.excludeProviders?.includes(provider.name)) throw this.budgetRefusal([provider.name]);
      opts.onServed?.(provider.name, routedRequest.model);
      return this.runForcedProvider(provider, routedRequest, requestId, start);
    }

    const fixedRoute = this.getSingleModelRoute();
    if (fixedRoute) {
      const { provider, model } = fixedRoute;
      if (opts?.excludeProviders?.includes(provider.name)) throw this.budgetRefusal([provider.name]);
      if (!this.quotaManager.checkQuota(provider.name)) {
        logger.log({ requestId, provider: provider.name, model, status: 'rate_limited', error: 'Quota exceeded' });
        throw new Error(`Fixed provider ${provider.name} is rate-limited.`);
      }

      try {
        const isAvailable = await provider.isAvailable();
        if (!isAvailable) {
          throw new Error(`Fixed provider ${provider.name} reported unavailable.`);
        }

        if (!providerAcceptsContent(provider, routedRequest, model)) throw unsupportedContent([provider.name], model);

        console.log(`[Router] Single-model mode: routing to ${provider.name} with model: ${model}`);
        await this.keyReady(provider);
        const response = await provider.complete({ ...routedRequest, model });
        opts?.onServed?.(provider.name, model);
        this.quotaManager.incrementUsage(provider.name);
        logger.log({
          requestId,
          provider: provider.name,
          model,
          status: 'success',
          duration: Date.now() - start,
          usage: response.usage,
        });
        return response;
      } catch (error: any) {
        logger.log({ requestId, provider: provider.name, model, status: 'error', error: error.message, duration: Date.now() - start });
        const hydrated = await hydrateAxiosError(error);
        console.error(`[Router] Error with fixed provider ${provider.name}:`, formatProviderError(hydrated));
        throw hydrated;
      }
    }

    // Providers skipped because they can't read the request's images; a 400 when nobody else got to try.
    const cannotRead: string[] = [];
    let attempted = false;
    const overBudget: string[] = [];
    for (const provider of await this.candidateProviders(request.model)) {
      if (opts?.excludeProviders?.includes(provider.name)) {
        overBudget.push(provider.name);
        continue;
      }
      const autoModel = (request.model === 'auto' || request.model === 'auto-vision') ? await this.autoModelFor(provider, routedRequest) : null;
      if ((request.model === 'auto' || request.model === 'auto-vision') && autoModel === null) {
        console.log(`[Router] Skipping ${provider.name} — no models enabled for routing.`);
        continue;
      }

      if (!this.quotaManager.checkQuota(provider.name)) {
        logger.log({ requestId, provider: provider.name, model: request.model, status: 'rate_limited', error: 'Quota exceeded' });
        console.warn(`[Router] Skipping ${provider.name} due to quota limit.`);
        continue;
      }

      console.log(`[Router] Attempting to route to ${provider.name}...`);
      let effectiveModel = request.model;
      try {
        effectiveModel = (request.model === 'auto' || request.model === 'auto-vision') ? autoModel! : request.model;
        const isAvailable = await provider.isAvailable();
        if (!isAvailable) {
            logger.log({
                requestId,
                provider: provider.name,
                model: effectiveModel,
                status: 'error',
                error: `${provider.name} reported unavailable`,
                duration: Date.now() - start,
            });
            console.warn(`[Router] ${provider.name} reported unavailable.`);
            continue;
        }

        const canHandle = await providerCanHandle(provider, routedRequest, effectiveModel);
        if (!canHandle) {
          logger.log({
            requestId,
            provider: provider.name,
            model: effectiveModel,
            status: 'error',
            error: `${provider.name} does not support model ${effectiveModel}`,
            duration: Date.now() - start,
          });
          console.warn(`[Router] Skipping ${provider.name} — model ${effectiveModel} not supported`);
          continue;
        }

        if (!providerAcceptsContent(provider, routedRequest, effectiveModel)) {
          cannotRead.push(provider.name);
          logger.log({ requestId, provider: provider.name, model: effectiveModel, status: 'error', error: `${provider.name} can't read images for ${effectiveModel}`, duration: Date.now() - start });
          console.warn(`[Router] Skipping ${provider.name} — can't read the request's images with ${effectiveModel}`);
          continue;
        }

        console.log(`[Router] Routing to ${provider.name} with model: ${effectiveModel}`);
        attempted = true;

        await this.keyReady(provider);
        const response = await provider.complete({ ...routedRequest, model: effectiveModel });
        const normalizedUsage = normalizeUsage(response.usage);
        const normalizedResponse: CompletionResponse = normalizedUsage
          ? {
              ...response,
              usage: {
                prompt_tokens: normalizedUsage.prompt_tokens ?? response.usage?.prompt_tokens ?? 0,
                completion_tokens: normalizedUsage.completion_tokens ?? response.usage?.completion_tokens ?? 0,
                total_tokens: normalizedUsage.total_tokens ?? response.usage?.total_tokens ?? 0,
                ...(normalizedUsage.cached_tokens === undefined ? {} : { cached_tokens: normalizedUsage.cached_tokens }),
                ...(normalizedUsage.cache_creation_input_tokens === undefined ? {} : { cache_creation_input_tokens: normalizedUsage.cache_creation_input_tokens }),
              },
            }
          : response;
        opts?.onServed?.(provider.name, effectiveModel);
        this.quotaManager.incrementUsage(provider.name);
        logger.log({
            requestId,
            provider: provider.name,
            model: effectiveModel,
            status: 'success',
            duration: Date.now() - start,
            usage: normalizedUsage,
        });
        console.log(`[Router] Successfully routed to ${provider.name}.`);
        return normalizedResponse;
      } catch (error: any) {
        logger.log({ requestId, provider: provider.name, model: effectiveModel, status: 'error', error: error.message, duration: Date.now() - start });
        console.error(`[Router] Error with ${provider.name}:`, error.message);
      }
    }
    if (!attempted && cannotRead.length) throw unsupportedContent(cannotRead, request.model);
    if (!attempted && overBudget.length) throw this.budgetRefusal(overBudget);
    throw new Error('All providers failed or are rate-limited.');
  }

  async *routeStream(request: CompletionRequest, opts?: RouteOptions): AsyncGenerator<StreamChunk, void, unknown> {
    const start = Date.now();
    const requestId = Math.random().toString(36).substring(7);
    let accumulatedContent = '';

    const routedRequest = await this.prepareRoutedRequest(request);
    const originalMessages = routedRequest.messages;

    if (opts?.forceProvider) {
      const provider = this.providers.find(p => p.name === opts.forceProvider);
      if (!provider) {
        throw new Error(`Provider "${opts.forceProvider}" is not registered.`);
      }
      if (opts.excludeProviders?.includes(provider.name)) throw this.budgetRefusal([provider.name]);
      opts.onServed?.(provider.name, routedRequest.model);
      yield* this.runForcedProviderStream(provider, routedRequest, requestId, start);
      return;
    }

    const fixedRoute = this.getSingleModelRoute();
    if (fixedRoute) {
      const { provider, model } = fixedRoute;
      if (opts?.excludeProviders?.includes(provider.name)) throw this.budgetRefusal([provider.name]);
      let providerChars = 0;
      let providerUsage: UsageSnapshot | undefined;

      if (!this.quotaManager.checkQuota(provider.name)) {
        logger.log({ requestId, provider: provider.name, model, status: 'rate_limited', error: 'Quota exceeded' });
        throw new Error(`Fixed provider ${provider.name} is rate-limited.`);
      }

      try {
        const isAvailable = await provider.isAvailable();
        if (!isAvailable) {
          throw new Error(`Fixed provider ${provider.name} reported unavailable.`);
        }

        if (!providerAcceptsContent(provider, routedRequest, model)) throw unsupportedContent([provider.name], model);

        console.log(`[Router] Single-model mode: routing stream to ${provider.name} with model: ${model}`);
        await this.keyReady(provider);
        const stream = provider.completeStream({ ...routedRequest, model });
        opts?.onServed?.(provider.name, model);
        this.quotaManager.incrementUsage(provider.name);

        for await (const chunk of stream) {
          const content = chunk.choices[0]?.delta?.content || '';
          providerChars += content.length;
          providerUsage = usageFromStreamChunk(chunk) ?? providerUsage;
          yield chunk;
        }

        logger.log({
          requestId,
          provider: provider.name,
          model,
          status: 'success',
          duration: Date.now() - start,
          usage: streamLogUsage(providerUsage, providerChars),
        });
        return;
      } catch (error: any) {
        logger.log({
          requestId,
          provider: provider.name,
          model,
          status: 'error',
          error: error.message,
          duration: Date.now() - start,
          usage: streamLogUsage(providerUsage, providerChars),
        });
        const hydrated = await hydrateAxiosError(error);
        console.error(`[Router] Stream error with fixed provider ${provider.name}:`, formatProviderError(hydrated));
        throw hydrated;
      }
    }

    const cannotRead: string[] = [];
    let attempted = false;
    const overBudget: string[] = [];
    for (const provider of await this.candidateProviders(request.model)) {
      if (opts?.excludeProviders?.includes(provider.name)) {
        overBudget.push(provider.name);
        continue;
      }
        const autoModel = (request.model === 'auto' || request.model === 'auto-vision') ? await this.autoModelFor(provider, routedRequest) : null;
        if ((request.model === 'auto' || request.model === 'auto-vision') && autoModel === null) {
          console.log(`[Router] Skipping ${provider.name} — no models enabled for routing.`);
          continue;
        }

        if (!this.quotaManager.checkQuota(provider.name)) {
          logger.log({ requestId, provider: provider.name, model: request.model, status: 'rate_limited', error: 'Quota exceeded' });
          console.warn(`[Router] Skipping ${provider.name} due to quota limit.`);
          continue;
        }

        console.log(`[Router] Attempting to route stream to ${provider.name}...`);

        const currentMessages = [...originalMessages];
        if (accumulatedContent) {
             currentMessages.push({ role: 'assistant', content: accumulatedContent });
             console.log(`[Router] Stitching content for ${provider.name}. Length: ${accumulatedContent.length}`);
        }

        let providerChars = 0;
        let providerUsage: UsageSnapshot | undefined;
        let effectiveModel = request.model;
        try {
            effectiveModel = (request.model === 'auto' || request.model === 'auto-vision') ? autoModel! : request.model;
            const isAvailable = await provider.isAvailable();
            if (!isAvailable) {
                logger.log({
                  requestId,
                  provider: provider.name,
                  model: effectiveModel,
                  status: 'error',
                  error: `${provider.name} reported unavailable`,
                  duration: Date.now() - start,
                  usage: streamLogUsage(providerUsage, providerChars),
                });
                console.warn(`[Router] ${provider.name} reported unavailable.`);
                continue;
            }

            const canHandle = await providerCanHandle(provider, { ...request, messages: currentMessages }, effectiveModel);
            if (!canHandle) {
              logger.log({
                requestId,
                provider: provider.name,
                model: effectiveModel,
                status: 'error',
                error: `${provider.name} does not support model ${effectiveModel}`,
                duration: Date.now() - start,
                usage: streamLogUsage(providerUsage, providerChars),
              });
              console.warn(`[Router] Skipping ${provider.name} — model ${effectiveModel} not supported`);
              continue;
            }

            if (!providerAcceptsContent(provider, { ...routedRequest, messages: currentMessages }, effectiveModel)) {
              cannotRead.push(provider.name);
              logger.log({ requestId, provider: provider.name, model: effectiveModel, status: 'error', error: `${provider.name} can't read images for ${effectiveModel}`, duration: Date.now() - start });
              console.warn(`[Router] Skipping ${provider.name} — can't read the request's images with ${effectiveModel}`);
              continue;
            }

          console.log(`[Router] Routing stream to ${provider.name} with model: ${effectiveModel}`);
          attempted = true;

          await this.keyReady(provider);
          const stream = provider.completeStream({ ...routedRequest, messages: currentMessages, model: effectiveModel });
          opts?.onServed?.(provider.name, effectiveModel);
          this.quotaManager.incrementUsage(provider.name);

          for await (const chunk of stream) {
              const content = chunk.choices[0]?.delta?.content || '';
              accumulatedContent += content;
              providerChars += content.length;
              providerUsage = usageFromStreamChunk(chunk) ?? providerUsage;
              yield chunk;
          }

          logger.log({
              requestId,
              provider: provider.name,
              model: effectiveModel,
              status: 'success',
              duration: Date.now() - start,
              usage: streamLogUsage(providerUsage, providerChars),
            });
          return;
        } catch (error: any) {
          logger.log({
              requestId,
              provider: provider.name,
              model: effectiveModel,
              status: 'error',
              error: error.message,
              duration: Date.now() - start,
              usage: streamLogUsage(providerUsage, providerChars),
          });
          console.error(`[Router] Stream Error with ${provider.name}:`, error);
        }
      }
      if (!attempted && cannotRead.length) throw unsupportedContent(cannotRead, request.model);
      if (!attempted && overBudget.length) throw this.budgetRefusal(overBudget);
      throw new Error('All providers failed or are rate-limited.');
  }

  /** Execute a single non-streaming request against an explicitly forced provider — no fallback. */
  private async runForcedProvider(
    provider: Provider,
    routedRequest: CompletionRequest,
    requestId: string,
    start: number,
  ): Promise<CompletionResponse> {
    const model = routedRequest.model;
    if (!this.quotaManager.checkQuota(provider.name)) {
      logger.log({ requestId, provider: provider.name, model, status: 'rate_limited', error: 'Quota exceeded' });
      throw new Error(`Provider ${provider.name} is rate-limited.`);
    }

    try {
      const isAvailable = await provider.isAvailable();
      if (!isAvailable) {
        throw new Error(`Provider ${provider.name} reported unavailable.`);
      }

      const canHandle = await providerCanHandle(provider, routedRequest, model);
      if (!canHandle) {
        throw new Error(`${provider.name} does not support model ${model}`);
      }
      if (!providerAcceptsContent(provider, routedRequest, model)) throw unsupportedContent([provider.name], model);

      console.log(`[Router] Forced routing to ${provider.name} with model: ${model}`);
      await this.keyReady(provider);
      const response = await provider.complete(routedRequest);
      this.quotaManager.incrementUsage(provider.name);
      logger.log({ requestId, provider: provider.name, model, status: 'success', duration: Date.now() - start, usage: response.usage });
      return response;
    } catch (error: any) {
      logger.log({ requestId, provider: provider.name, model, status: 'error', error: error.message, duration: Date.now() - start });
      const hydrated = await hydrateAxiosError(error);
      console.error(`[Router] Error with forced provider ${provider.name}:`, formatProviderError(hydrated));
      throw hydrated;
    }
  }

  /** Streaming counterpart of `runForcedProvider`. */
  private async *runForcedProviderStream(
    provider: Provider,
    routedRequest: CompletionRequest,
    requestId: string,
    start: number,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const model = routedRequest.model;
    let providerChars = 0;
    let providerUsage: UsageSnapshot | undefined;

    if (!this.quotaManager.checkQuota(provider.name)) {
      logger.log({ requestId, provider: provider.name, model, status: 'rate_limited', error: 'Quota exceeded' });
      throw new Error(`Provider ${provider.name} is rate-limited.`);
    }

    try {
      const isAvailable = await provider.isAvailable();
      if (!isAvailable) {
        throw new Error(`Provider ${provider.name} reported unavailable.`);
      }

      const canHandle = await providerCanHandle(provider, routedRequest, model);
      if (!canHandle) {
        throw new Error(`${provider.name} does not support model ${model}`);
      }
      if (!providerAcceptsContent(provider, routedRequest, model)) throw unsupportedContent([provider.name], model);

      console.log(`[Router] Forced routing stream to ${provider.name} with model: ${model}`);
      await this.keyReady(provider);
      const stream = provider.completeStream(routedRequest);
      this.quotaManager.incrementUsage(provider.name);

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        providerChars += content.length;
        providerUsage = usageFromStreamChunk(chunk) ?? providerUsage;
        yield chunk;
      }

      logger.log({
        requestId,
        provider: provider.name,
        model,
        status: 'success',
        duration: Date.now() - start,
        usage: streamLogUsage(providerUsage, providerChars),
      });
    } catch (error: any) {
      logger.log({
        requestId,
        provider: provider.name,
        model,
        status: 'error',
        error: error.message,
        duration: Date.now() - start,
        usage: streamLogUsage(providerUsage, providerChars),
      });
      const hydrated = await hydrateAxiosError(error);
      console.error(`[Router] Stream error with forced provider ${provider.name}:`, formatProviderError(hydrated));
      throw hydrated;
    }
  }

  // ── NEW: Semantic route resolution ──────────────────────────────

  /**
   * Resolve a full routing decision for a user message.
   *
   * 1. If a Classifier is configured, classify the request to get
   *    complexity/domain/reasoning.
   * 2. Apply the code policy to map classification → tier.
   * 3. Resolve the tier → actual model name from TierConfig.
   * 4. Look up the model's provider from the ModelRegistry.
   *
   * This is the method that agent pipelines call to
   * decide *which model* to use before dispatching a request.
   */
  async resolveRoute(request: ClassifyRequest): Promise<RouteResult> {
    const fixedRoute = this.getSingleModelDecision();
    if (fixedRoute) {
      return {
        classification: null,
        selectedTier: 'fixed',
        selectedModel: fixedRoute.model,
        selectedProvider: fixedRoute.provider,
      };
    }

    const classification = this.classifier
      ? await this.classifier.classifyRequest(request)
      : null;

    // Apply code policy
    const selectedTier = this.codePolicy(classification);

    // Resolve model name from tier config
    const selectedModel = resolveTierModel(selectedTier, this.tierConfig);

    // Look up provider from model registry
    const selectedProvider = selectedModel
      ? this.modelRegistry.lookupVariant(null, selectedModel)?.provider ?? null
      : null;

    return {
      classification,
      selectedTier,
      selectedModel,
      selectedProvider,
    };
  }

  /**
   * Resolve effective model for a given route and optional semantic structure,
   * using service-level tier defaults and optionally overriding with the
   * router classification code policy.
   *
   * @param route - the semantic route (casual, tool_use, complex, teaching)
   * @param classification - optional router classification for policy override
   * @returns the resolved model name, provider, and a routing description string
   */
  resolveEffectiveModel(
    route: string,
    classification?: RouterClassification | null,
  ): { model: string | null; provider: string | null; routing: string } {
    const fixedRoute = this.getSingleModelDecision();
    if (fixedRoute) {
      return {
        model: fixedRoute.model,
        provider: fixedRoute.provider,
        routing: 'fixed',
      };
    }

    const defaultTier = this.serviceTiers[route] || '4b';
    const model = resolveTierModel(defaultTier, this.tierConfig);

    if (!classification) {
      const provider = model
        ? this.modelRegistry.lookupVariant(null, model)?.provider ?? null
        : null;
      return { model, provider, routing: `${route}:${defaultTier}` };
    }

    // Apply code policy override
    const policyTier = this.codePolicy(classification);
    // For tool_use routes, enforce at minimum 12b tier
    const selectedTier = route === 'tool_use' ? '12b' : policyTier;
    const selectedModel = resolveTierModel(selectedTier, this.tierConfig);
    const selectedProvider = selectedModel
      ? this.modelRegistry.lookupVariant(null, selectedModel)?.provider ?? null
      : null;

    return {
      model: selectedModel || model,
      provider: selectedProvider,
      routing: `${route}:${selectedTier} (policy override from ${defaultTier})`,
    };
  }

  /** Update the tier config at runtime. */
  setTierConfig(tierConfig: TierConfig) {
    this.tierConfig = tierConfig;
  }

  /** Replace the classifier at runtime. */
  setClassifier(classifier?: Classifier) {
    this.classifier = classifier;
  }

  /** Replace the code policy at runtime. */
  setCodePolicy(policy: (classification: RouterClassification | null) => string) {
    this.codePolicy = policy;
  }

  /** Replace the service tiers at runtime. */
  setServiceTiers(tiers: Record<string, string>) {
    this.serviceTiers = { ...tiers };
  }

  /** Enable, disable, or update single-model mode at runtime. */
  setSingleModel(config?: SingleModelRouterConfig) {
    this.singleModel = config;
  }

  getSingleModel(): SingleModelRouterConfig | undefined {
    return this.singleModel;
  }

  private getSingleModelRoute(): { provider: Provider; model: string } | null {
    const decision = this.getSingleModelDecision();
    if (!decision) return null;

    const provider = this.providers.find(p => normalizeProviderName(p.name) === normalizeProviderName(decision.provider));
    if (!provider) {
      throw new Error(`Fixed provider "${decision.provider}" is not registered.`);
    }

    return { provider, model: decision.model };
  }

  private getSingleModelDecision(): { provider: string; model: string } | null {
    if (!this.singleModel?.enabled) return null;

    const model = (this.singleModel.model || '').trim();
    if (!model) {
      throw new Error('Single-model mode requires LEYLINE_FIXED_MODEL.');
    }

    const provider = (this.singleModel.provider || '').trim()
      || this.modelRegistry.lookupVariant(null, model)?.provider
      || '';

    if (!provider) {
      throw new Error(`Single-model mode could not infer a provider for "${model}". Set LEYLINE_FIXED_PROVIDER.`);
    }

    return { provider, model };
  }
}

/**
 * Who answers `auto` for each capability, first configured first: the usual default (OpenAI) before
 * alternatives. Providers not named here come after, in registration order.
 */
export const CAPABILITY_PREFERENCE: Record<Exclude<Capability, 'chat'>, string[]> = {
  vision: ['Gemini', 'OpenRouter', 'OpenAI', 'AzureOpenAI', 'WorkersAI'],
  audio: ['Gemini', 'OpenAI', 'AzureOpenAI', 'WorkersAI', 'OpenRouter'],
  embeddings: ['OpenAI', 'AzureOpenAI', 'WorkersAI', 'Gemini', 'OpenRouter'],
  transcription: ['OpenAI', 'Deepgram', 'WorkersAI'],
  speech: ['OpenAI', 'WorkersAI'],
};

function normalizeProviderName(provider: string): string {
  return provider.toLowerCase().replace(/[^a-z0-9]/g, '');
}
