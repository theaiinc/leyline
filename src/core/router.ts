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
} from './types';
import { QuotaManager } from './quota-manager';
import { ModelRegistry } from './model-registry';
import { Classifier } from './classifier';
import { logger } from './logger';
import { maybeCompress } from './compress';
import { formatProviderError, hydrateAxiosError } from './api-errors';
import { ensureMessageArray } from './normalize-request';

type UsageSnapshot = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

function usageFromStreamChunk(chunk: StreamChunk): UsageSnapshot | undefined {
  if (!chunk.usage) return undefined;
  const { prompt_tokens, completion_tokens, total_tokens } = chunk.usage;
  if (prompt_tokens === undefined && completion_tokens === undefined && total_tokens === undefined) {
    return undefined;
  }
  return { prompt_tokens, completion_tokens, total_tokens };
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
  private providerModelIds = new Map<string, { ids: Set<string>; timestamp: number }>();
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
  private autoModelFor(provider: Provider): string | null {
    const enabled = this.enabledModelsFor(provider);
    if (!enabled) return provider.defaultModel;
    if (enabled.length === 0) return null;
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
    try {
      ids = new Set((await provider.getModels()).map(detail => detail.id));
    } catch {
      // Provider offline or unlistable — treat as unknown and retry later.
    }
    this.providerModelIds.set(provider.name, { ids, timestamp: Date.now() });
  }

  /** Eagerly refresh the model-id index for every registered provider. */
  async reindexAll(): Promise<void> {
    await Promise.all(this.providers.map(provider => this.reindexProvider(provider)));
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
    if (!model || model === 'auto') return this.providers;

    const matches: Provider[] = [];
    for (const provider of this.providers) {
      const enabled = this.enabledModelsFor(provider);
      if (enabled?.includes(model) || await this.providerListsModel(provider, model)) {
        matches.push(provider);
      }
    }
    if (matches.length === 0) return this.providers;
    if (matches.length > 1) {
      const pinned = this.modelPins.get(model);
      const pinnedIndex = pinned ? matches.findIndex(p => p.name === pinned) : -1;
      if (pinnedIndex > 0) matches.unshift(matches.splice(pinnedIndex, 1)[0]);
    }
    return [...matches, ...this.providers.filter(provider => !matches.includes(provider))];
  }

  // ── Route execution (existing) ──────────────────────────────────

  private async prepareRoutedRequest(request: CompletionRequest): Promise<CompletionRequest> {
    const compressed = await maybeCompress(request);
    const messages = ensureMessageArray(compressed.messages);
    return { ...compressed, messages };
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
      return this.runForcedProvider(provider, routedRequest, requestId, start);
    }

    const fixedRoute = this.getSingleModelRoute();
    if (fixedRoute) {
      const { provider, model } = fixedRoute;
      if (!this.quotaManager.checkQuota(provider.name)) {
        logger.log({ requestId, provider: provider.name, model, status: 'rate_limited', error: 'Quota exceeded' });
        throw new Error(`Fixed provider ${provider.name} is rate-limited.`);
      }

      try {
        const isAvailable = await provider.isAvailable();
        if (!isAvailable) {
          throw new Error(`Fixed provider ${provider.name} reported unavailable.`);
        }

        console.log(`[Router] Single-model mode: routing to ${provider.name} with model: ${model}`);
        const response = await provider.complete({ ...routedRequest, model });
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

    for (const provider of await this.candidateProviders(request.model)) {
      const autoModel = request.model === 'auto' ? this.autoModelFor(provider) : null;
      if (request.model === 'auto' && autoModel === null) {
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
        effectiveModel = request.model === 'auto' ? autoModel! : request.model;
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

        console.log(`[Router] Routing to ${provider.name} with model: ${effectiveModel}`);

        const response = await provider.complete({ ...routedRequest, model: effectiveModel });
        this.quotaManager.incrementUsage(provider.name);
        logger.log({
            requestId,
            provider: provider.name,
            model: effectiveModel,
            status: 'success',
            duration: Date.now() - start,
            usage: response.usage,
        });
        console.log(`[Router] Successfully routed to ${provider.name}.`);
        return response;
      } catch (error: any) {
        logger.log({ requestId, provider: provider.name, model: effectiveModel, status: 'error', error: error.message, duration: Date.now() - start });
        console.error(`[Router] Error with ${provider.name}:`, error.message);
      }
    }
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
      yield* this.runForcedProviderStream(provider, routedRequest, requestId, start);
      return;
    }

    const fixedRoute = this.getSingleModelRoute();
    if (fixedRoute) {
      const { provider, model } = fixedRoute;
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

        console.log(`[Router] Single-model mode: routing stream to ${provider.name} with model: ${model}`);
        const stream = provider.completeStream({ ...routedRequest, model });
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

    for (const provider of await this.candidateProviders(request.model)) {
        const autoModel = request.model === 'auto' ? this.autoModelFor(provider) : null;
        if (request.model === 'auto' && autoModel === null) {
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
            effectiveModel = request.model === 'auto' ? autoModel! : request.model;
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

          console.log(`[Router] Routing stream to ${provider.name} with model: ${effectiveModel}`);

          const stream = provider.completeStream({ ...routedRequest, messages: currentMessages, model: effectiveModel });
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

      console.log(`[Router] Forced routing to ${provider.name} with model: ${model}`);
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

      console.log(`[Router] Forced routing stream to ${provider.name} with model: ${model}`);
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

function normalizeProviderName(provider: string): string {
  return provider.toLowerCase().replace(/[^a-z0-9]/g, '');
}
