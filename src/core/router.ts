import {
  Provider,
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  ClassifyRequest,
  RouterClassification,
  RouteResult,
  TierConfig,
} from './types';
import { QuotaManager } from './quota-manager';
import { ModelRegistry } from './model-registry';
import { Classifier } from './classifier';
import { logger } from './logger';

// ── Router options (backward-compatible: all optional) ─────────────

export interface RouterOptions {
  quotaManager?: QuotaManager;
  modelRegistry?: ModelRegistry;
  classifier?: Classifier;
  tierConfig?: TierConfig;
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

// ── Service type detection ─────────────────────────────────────────

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

  constructor(quotaManagerOrOptions?: QuotaManager | RouterOptions) {
    // Backward-compatible constructor: accept QuotaManager directly or RouterOptions
    if (quotaManagerOrOptions instanceof QuotaManager) {
      this.quotaManager = quotaManagerOrOptions;
      this.modelRegistry = new ModelRegistry();
      this.tierConfig = {};
      this.codePolicy = selectModelByRouter;
      this.serviceTiers = { ...DEFAULT_SERVICE_TIERS };
    } else {
      const opts = quotaManagerOrOptions ?? {};
      this.quotaManager = opts.quotaManager ?? new QuotaManager();
      this.modelRegistry = opts.modelRegistry ?? new ModelRegistry();
      this.classifier = opts.classifier;
      this.tierConfig = opts.tierConfig ?? {};
      this.codePolicy = opts.codePolicy ?? selectModelByRouter;
      this.serviceTiers = opts.serviceTiers ?? { ...DEFAULT_SERVICE_TIERS };
    }
  }

  // ── Provider management (existing) ──────────────────────────────

  addProvider(provider: Provider) {
    this.providers.push(provider);
  }

  getProviders(): Provider[] {
    return this.providers;
  }

  // ── Route execution (existing) ──────────────────────────────────

  async route(request: CompletionRequest): Promise<CompletionResponse> {
    const start = Date.now();
    const requestId = Math.random().toString(36).substring(7);

    for (const provider of this.providers) {
      if (!this.quotaManager.checkQuota(provider.name)) {
        logger.log({ requestId, provider: provider.name, model: request.model, status: 'rate_limited', error: 'Quota exceeded' });
        console.warn(`[Router] Skipping ${provider.name} due to quota limit.`);
        continue;
      }

      console.log(`[Router] Attempting to route to ${provider.name}...`);
      try {
        const isAvailable = await provider.isAvailable();
        if (!isAvailable) {
            console.warn(`[Router] ${provider.name} reported unavailable.`);
            continue;
        }

        const effectiveModel = request.model === 'auto' ? provider.defaultModel : request.model;
        console.log(`[Router] Routing to ${provider.name} with model: ${effectiveModel}`);

        const response = await provider.complete({ ...request, model: effectiveModel });
        this.quotaManager.incrementUsage(provider.name);
        logger.log({
            requestId,
            provider: provider.name,
            model: effectiveModel,
            status: 'success',
            duration: Date.now() - start,
        });
        console.log(`[Router] Successfully routed to ${provider.name}.`);
        return response;
      } catch (error: any) {
        logger.log({ requestId, provider: provider.name, model: request.model, status: 'error', error: error.message, duration: Date.now() - start });
        console.error(`[Router] Error with ${provider.name}:`, error.message);
      }
    }
    throw new Error('All providers failed or are rate-limited.');
  }

  async *routeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
    const start = Date.now();
    const requestId = Math.random().toString(36).substring(7);
    let accumulatedContent = '';
    const originalMessages = [...request.messages];

    for (const provider of this.providers) {
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
        try {
            const isAvailable = await provider.isAvailable();
            if (!isAvailable) {
                console.warn(`[Router] ${provider.name} reported unavailable.`);
                continue;
            }

          const effectiveModel = request.model === 'auto' ? provider.defaultModel : request.model;
          console.log(`[Router] Routing stream to ${provider.name} with model: ${effectiveModel}`);

          const stream = provider.completeStream({ ...request, messages: currentMessages, model: effectiveModel });
          this.quotaManager.incrementUsage(provider.name);

          for await (const chunk of stream) {
              const content = chunk.choices[0]?.delta?.content || '';
              accumulatedContent += content;
              providerChars += content.length;
              yield chunk;
          }

          logger.log({
              requestId,
              provider: provider.name,
              model: effectiveModel,
              status: 'success',
              duration: Date.now() - start,
              usage: { chars: providerChars },
            });
          return;
        } catch (error: any) {
          logger.log({
              requestId,
              provider: provider.name,
              model: request.model,
              status: 'error',
              error: error.message,
              duration: Date.now() - start,
              usage: { chars: providerChars },
          });
          console.error(`[Router] Stream Error with ${provider.name}:`, error);
        }
      }
      throw new Error('All providers failed or are rate-limited.');
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
}
