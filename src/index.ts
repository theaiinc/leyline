// ── Public API exports ──────────────────────────────────────────────
// Consumers import models and types from @theaiinc/leyline:
//   import { Router, ModelRegistry, Classifier, LMStudioProvider } from '@theaiinc/leyline';
export { Router, selectModelByRouter } from './core/router';
export type { RouterOptions } from './core/router';
export { ModelRegistry } from './core/model-registry';
export { Classifier } from './core/classifier';
export type { ClassifyFn } from './core/classifier';
export { QuotaManager } from './core/quota-manager';
export type {
  Provider,
  CompletionRequest, CompletionResponse, StreamChunk, ModelDetail, Quota,
  ModelVariant, BillingClass, ResourceClass,
  RouterClassification, ClassifyRequest, RouteResult, TierConfig,
} from './core/types';
export { GeminiProvider } from './providers/gemini';
export { HuggingFaceProvider } from './providers/huggingface';
export { OpenRouterProvider } from './providers/openrouter';
export { OllamaProvider } from './providers/ollama';
export { LMStudioProvider } from './providers/lmstudio';
export { createServer } from './server';
export { config } from './config';
export type { LeylineConfig, QuotaConfig, RouterModelConfig, DefaultModelsConfig } from './config';

// ── Internal imports (for bootstrap) ─────────────────────────────────
import { createServer } from './server';
import { Router } from './core/router';
import { ModelRegistry } from './core/model-registry';
import { Classifier } from './core/classifier';
import { QuotaManager } from './core/quota-manager';
import { GeminiProvider } from './providers/gemini';
import { HuggingFaceProvider } from './providers/huggingface';
import { OpenRouterProvider } from './providers/openrouter';
import { OllamaProvider } from './providers/ollama';
import { LMStudioProvider } from './providers/lmstudio';
import { config } from './config';
import type { ModelVariant } from './core/types';

// ── Standalone server bootstrap ──────────────────────────────────────

async function bootstrap() {
  const quotaManager = new QuotaManager();

  // Configure Quotas
  quotaManager.setQuota('Gemini', config.quotas.gemini);
  quotaManager.setQuota('HuggingFace', config.quotas.huggingface);
  quotaManager.setQuota('OpenRouter', config.quotas.openrouter);
  quotaManager.setQuota('Ollama', config.quotas.ollama);

  // Build model registry — load custom variants if provided, else use defaults
  let parsedCustomVariants: ModelVariant[] | undefined;
  if (config.customVariants) {
    try {
      const parsed = JSON.parse(config.customVariants);
      if (Array.isArray(parsed)) {
        parsedCustomVariants = parsed;
        console.log(`[Leyline] Loaded ${parsedCustomVariants.length} custom model variants`);
      }
    } catch (e) {
      console.warn('[Leyline] Failed to parse LEYLINE_CUSTOM_VARIANTS, using defaults');
    }
  }
  const modelRegistry = new ModelRegistry(parsedCustomVariants);

  // Build classifier for the router model if configured
  // Uses OpenAI client (already a dependency) for the lightweight router call
  let classifier: Classifier | undefined;
  const routerModel = config.routerModel.model;
  const routerBaseUrl = config.routerModel.baseUrl;
  if (routerModel && routerBaseUrl) {
    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({
      baseURL: routerBaseUrl,
      apiKey: process.env.OPENAI_API_KEY || 'not-needed',
    });
    classifier = new Classifier(async (system: string, userMessage: string) => {
      const response = await openai.chat.completions.create({
        model: routerModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userMessage },
        ],
        max_tokens: config.routerModel.maxTokens,
        temperature: config.routerModel.temperature,
        stop: ['\n\n'],
      });
      return response.choices[0]?.message?.content || '';
    });
    console.log(`[Leyline] Router classifier configured: model=${routerModel}, baseUrl=${routerBaseUrl}`);
  }

  const router = new Router({
    quotaManager,
    modelRegistry,
    classifier,
    tierConfig: config.tierModels,
  });

  // Add providers in priority order
  router.addProvider(new GeminiProvider());
  router.addProvider(new HuggingFaceProvider());
  router.addProvider(new OpenRouterProvider());
  router.addProvider(new OllamaProvider());
  // Add LMStudio provider if configured
  if (process.env.LMSTUDIO_BASE_URL || process.env.LMSTUDIO_MODEL) {
    router.addProvider(new LMStudioProvider());
  }

  const app = createServer(router, quotaManager);

  app.listen(config.port, () => {
    console.log(`[Leyline] AI Router listening on port ${config.port}`);
    if (classifier) {
      console.log(`[Leyline] /v1/route endpoint available (router model: ${config.routerModel.model})`);
    } else {
      console.log('[Leyline] /v1/route endpoint NOT available — set LEYLINE_ROUTER_MODEL and LEYLINE_OPENAI_BASE_URL');
    }
  });
}

bootstrap();
