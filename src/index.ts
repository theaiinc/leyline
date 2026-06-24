// ── Public API exports ──────────────────────────────────────────────
// Consumers import models and types from @theaiinc/leyline:
//   import { Router, ModelRegistry, Classifier, LMStudioProvider } from '@theaiinc/leyline';
export { Router, selectModelByRouter } from './core/router';
export type { RouterOptions, SingleModelRouterConfig } from './core/router';
export { ModelRegistry } from './core/model-registry';
export { Classifier } from './core/classifier';
export type { ClassifyFn } from './core/classifier';
export { QuotaManager } from './core/quota-manager';
export type {
  Provider,
  ApiKeyConfigurableProvider,
  RuntimeConfigurableProvider,
  CompletionRequest, CompletionResponse, StreamChunk, ModelDetail, Quota,
  ModelVariant, BillingClass, ResourceClass,
  RouterClassification, ClassifyRequest, RouteResult, TierConfig,
} from './core/types';
export { GeminiProvider } from './providers/gemini';
export { HuggingFaceProvider } from './providers/huggingface';
export { OpenAIProvider } from './providers/openai';
export { OpenRouterProvider } from './providers/openrouter';
export { OllamaProvider } from './providers/ollama';
export { LMStudioProvider } from './providers/lmstudio';
export { LiteLLMProvider } from './providers/litellm';
export { AzureOpenAIProvider } from './providers/azure-openai';
export { createServer } from './server';
export type { CreateServerOptions } from './server';
export { config, DEFAULT_LEYLINE_CLIENT_API_KEY } from './config';
export type { LeylineConfig, QuotaConfig, RouterModelConfig, DefaultModelsConfig, CompressionConfig, SingleModelConfig, TunnelConfig } from './config';
export { CloudflaredTunnel, parseCloudflaredPublicUrl } from './core/cloudflared-tunnel';
export type { TunnelInfo, TunnelState, CloudflaredTunnelOptions } from './core/cloudflared-tunnel';
export { maybeCompress, isCompressionAvailable } from './core/compress';
export {
  DEFAULT_KEYCHAIN_SERVICE,
  FallbackSecretStore,
  KeychainSecretStore,
  MemorySecretStore,
  apiKeyAccount,
  createDefaultSecretStore,
  runtimeConfigAccount,
  parseRuntimeConfig,
  serializeRuntimeConfig,
} from './core/secret-store';
export type { ApiKeyPersistenceMode, ApiKeySource, SecretStore, SecretStoreStatus, PersistedRuntimeConfig } from './core/secret-store';

// ── Internal imports (for bootstrap) ─────────────────────────────────
import { createServer } from './server';
import { Router } from './core/router';
import { ModelRegistry } from './core/model-registry';
import { Classifier } from './core/classifier';
import { QuotaManager } from './core/quota-manager';
import { GeminiProvider } from './providers/gemini';
import { HuggingFaceProvider } from './providers/huggingface';
import { OpenAIProvider } from './providers/openai';
import { OpenRouterProvider } from './providers/openrouter';
import { OllamaProvider } from './providers/ollama';
import { LMStudioProvider } from './providers/lmstudio';
import { LiteLLMProvider } from './providers/litellm';
import { AzureOpenAIProvider } from './providers/azure-openai';
import { config, DEFAULT_LEYLINE_CLIENT_API_KEY } from './config';
import type { ModelVariant } from './core/types';
import { isCompressionAvailable } from './core/compress';
import { CloudflaredTunnel } from './core/cloudflared-tunnel';

// ── Standalone server bootstrap ──────────────────────────────────────

async function bootstrap() {
  const quotaManager = new QuotaManager();

  // Configure optional Leyline-side quotas (off by default — Cursor bursts exceed low RPM caps)
  if (config.quotas.enabled) {
    quotaManager.setQuota('Gemini', config.quotas.gemini);
    quotaManager.setQuota('HuggingFace', config.quotas.huggingface);
    quotaManager.setQuota('OpenAI', config.quotas.openai);
    quotaManager.setQuota('OpenRouter', config.quotas.openrouter);
    quotaManager.setQuota('Ollama', config.quotas.ollama);
    quotaManager.setQuota('AzureOpenAI', config.quotas.azureOpenAI);
  }

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
  if (!config.singleModel.enabled && routerModel && routerBaseUrl) {
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
    singleModel: config.singleModel,
  });

  // Add providers in priority order
  router.addProvider(new GeminiProvider());
  router.addProvider(new HuggingFaceProvider());
  router.addProvider(new OpenAIProvider());
  router.addProvider(new OpenRouterProvider());
  if (process.env.LITELLM_ENABLED === 'true' || process.env.LITELLM_BASE_URL || process.env.LITELLM_MODEL) {
    router.addProvider(new LiteLLMProvider());
  }
  router.addProvider(new AzureOpenAIProvider());
  if (process.env.OLLAMA_ENABLED === 'true') {
    router.addProvider(new OllamaProvider());
  }
  // Add LMStudio provider if configured
  if (process.env.LMSTUDIO_BASE_URL || process.env.LMSTUDIO_MODEL) {
    router.addProvider(new LMStudioProvider());
  }

  const tunnel = new CloudflaredTunnel(config.tunnel);
  const localUrl = `http://127.0.0.1:${config.port}`;

  const app = createServer(router, quotaManager, {
    getTunnelInfo: () => tunnel.getInfo(),
  });

  const shutdown = () => {
    tunnel.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  app.listen(config.port, async () => {
    console.log(`[Leyline] AI Router listening on port ${config.port}`);
    console.log(`[Leyline] Local URL: ${localUrl}`);
    console.log(`[Leyline] Max request body: ${config.bodyLimit}`);
    if (process.env.LEYLINE_CLIENT_AUTH_ENABLED === 'false') {
      console.warn('[Leyline] Client API auth disabled (LEYLINE_CLIENT_AUTH_ENABLED=false)');
    } else if (process.env.LEYLINE_CLIENT_API_KEY !== undefined) {
      console.log('[Leyline] Client API key loaded from LEYLINE_CLIENT_API_KEY');
    } else if (config.tunnel.enabled) {
      console.log('[Leyline] Generated random client API key for this tunnel session');
    } else {
      console.log('[Leyline] Client API key uses local default; set LEYLINE_CLIENT_API_KEY before exposing publicly');
    }
    if (config.quotas.enabled) {
      console.log('[Leyline] Provider quotas enabled (LEYLINE_QUOTAS_ENABLED=true)');
    } else {
      console.log('[Leyline] Provider quotas disabled — upstream providers enforce their own rate limits');
    }
    if (config.singleModel.enabled) {
      const fixedModel = (config.singleModel.model || '').trim();
      const fixedProvider = (config.singleModel.provider || '').trim();
      if (fixedModel) {
        const providerLabel = fixedProvider || 'inferred from registry';
        console.log(`[Leyline] /v1/route available (fixed model mode: ${providerLabel} / ${fixedModel})`);
        console.log('[Leyline] Dynamic routing disabled — all requests use the fixed provider/model');
        const normalizedFixedProvider = fixedProvider.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!fixedProvider || normalizedFixedProvider.includes('azure')) {
          const envBaseUrl = (process.env.AZURE_OPENAI_BASE_URL || process.env.AZURE_OPENAI_ENDPOINT || '').trim();
          if (!envBaseUrl) {
            console.log('[Leyline] Azure base URL comes from dashboard runtime settings or Keychain — set AZURE_OPENAI_BASE_URL in .env or save it in /dashboard');
          }
        }
      } else {
        console.warn('[Leyline] Fixed model mode enabled but LEYLINE_FIXED_MODEL is unset — /v1/route will fail until configured');
      }
    } else if (classifier) {
      console.log(`[Leyline] /v1/route available (classifier mode: ${config.routerModel.model})`);
    } else {
      console.log('[Leyline] /v1/route available (tier defaults — no classifier configured)');
      console.log('[Leyline] Classifier mode: set LEYLINE_ROUTER_MODEL and LEYLINE_OPENAI_BASE_URL');
      console.log('[Leyline] Fixed model mode: set LEYLINE_ROUTER_ENABLED=false and LEYLINE_FIXED_MODEL');
    }
    if (config.compression.enabled) {
      const available = await isCompressionAvailable();
      if (available) {
        console.log(`[Leyline] Prompt compression enabled via @theaiinc/headroom-ai`);
      } else {
        console.warn('[Leyline] LEYLINE_COMPRESSION_ENABLED=true but @theaiinc/headroom-ai is not installed — run: pip install headroom-ai');
      }
    }

    if (config.tunnel.enabled) {
      console.log('[Leyline] Starting Cloudflare quick tunnel (cloudflared)...');
      void tunnel.start(localUrl).then((info) => {
        if (info.state === 'ready' && info.publicUrl) {
          console.log(`[Leyline] Public tunnel URL: ${info.publicUrl}`);
          console.log(`[Leyline] OpenAI SDK baseURL: ${info.publicBaseUrl}`);
          console.log(`[Leyline] Client API key: ${config.clientApiKey || DEFAULT_LEYLINE_CLIENT_API_KEY}`);
          console.log('[Leyline] Use the public URL for cloud clients that cannot reach localhost.');
        } else if (info.error) {
          console.warn(`[Leyline] Cloudflare tunnel failed: ${info.error}`);
          console.warn('[Leyline] Local-only access remains available; install cloudflared or set LEYLINE_TUNNEL_ENABLED=false');
        }
      });
    }
  });
}

bootstrap();
