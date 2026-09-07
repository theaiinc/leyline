import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Server as HttpServer } from 'http';
import cors from 'cors';
import path from 'path';
import { Router } from './core/router';
import { CompletionRequest, ClassifyRequest, Provider, ApiKeyConfigurableProvider, RuntimeConfigurableProvider } from './core/types';
import { logger } from './core/logger';
import { QuotaManager } from './core/quota-manager';
import { getModelScore } from './core/leaderboard-data';
import { config } from './config';
import { requireClientApiKey } from './core/client-auth';
import { createRequireAegisToken, AegisTenant } from './core/aegis-auth';
import { chatCompletionErrorResponse, formatProviderError, hydrateAxiosError } from './core/api-errors';
import { normalizeCompletionRequest } from './core/normalize-request';
import { createMcpHttpHandler } from './mcp/http';
import type { TunnelInfo } from './core/cloudflared-tunnel';
import { INSTANCE_FAMILIES } from './core/provider-instances';
import { generateInstanceId } from './core/instance-naming';
import {
  ApiKeyPersistenceMode,
  ApiKeySource,
  PersistedRoutingConfig,
  ROUTING_CONFIG_ACCOUNT,
  SecretStore,
  apiKeyAccount,
  createDefaultSecretStore,
  instanceManifestAccount,
  parseInstanceManifest,
  parseRoutingConfig,
  parseRuntimeConfig,
  runtimeConfigAccount,
  sanitizeEnabledModels,
  sanitizeModelPins,
  serializeInstanceManifest,
  serializeRoutingConfig,
  serializeRuntimeConfig,
} from './core/secret-store';

function isApiKeyConfigurableProvider(provider: Provider): provider is ApiKeyConfigurableProvider {
  const candidate = provider as Partial<ApiKeyConfigurableProvider>;
  return typeof candidate.setApiKey === 'function' && typeof candidate.hasApiKey === 'function';
}

function isRuntimeConfigurableProvider(provider: Provider): provider is RuntimeConfigurableProvider {
  const candidate = provider as Partial<RuntimeConfigurableProvider>;
  return typeof candidate.setRuntimeConfig === 'function' && typeof candidate.getRuntimeConfig === 'function';
}

export interface CreateServerOptions {
  apiKeyStore?: SecretStore;
  getTunnelInfo?: () => TunnelInfo;
  /** Bind address used by the standalone process. Defaults to loopback. */
  host?: string;
  /** Enable the public-proxy route allowlist. Defaults to true. */
  enforceExternalSurface?: boolean;
  /** Per-tenant quota manager for Aegis-verified hosted mode. Defaults to a fresh instance. */
  aegisQuotaManager?: QuotaManager;
}

type ProviderKeyMetadata = {
  source: ApiKeySource;
};

function isApiKeyPersistenceMode(value: unknown): value is ApiKeyPersistenceMode {
  return value === 'keychain' || value === 'memory' || value === 'localStorage' || value === 'arcana';
}

function providerRuntimeReady(provider: Provider): boolean | undefined {
  if (!isRuntimeConfigurableProvider(provider)) return undefined;
  return Boolean(provider.getRuntimeConfig().baseUrlConfigured);
}

function dashboardRoutingStatus(router: Router) {
  const single = router.getSingleModel();
  return {
    singleModelEnabled: Boolean(single?.enabled),
    fixedProvider: single?.provider || null,
    fixedModel: single?.model || null,
    enabledModels: router.getEnabledModels() ?? {},
    modelPins: router.getModelPins(),
    modelIndex: router.getModelIndex(),
  };
}

function isLoopbackAddress(address?: string): boolean {
  return !address
    || address === '::1'
    || address === '127.0.0.1'
    || address === '::ffff:127.0.0.1';
}

function hasPublicProxyHeaders(req: Request): boolean {
  return Boolean(
    req.headers['cf-connecting-ip']
    || req.headers['cf-ray']
    || req.headers['cf-visitor']
    || req.headers['x-forwarded-for']
    || req.headers['x-real-ip'],
  );
}

function requireLocalDashboardAccess(req: Request, res: Response, next: NextFunction): void {
  const remoteAddress = req.socket.remoteAddress || req.ip;
  if (isLoopbackAddress(remoteAddress) && !hasPublicProxyHeaders(req)) {
    next();
    return;
  }

  res.status(403).json({
    error: {
      message: 'Dashboard is only available from localhost.',
      type: 'access_denied',
      code: 'local_dashboard_only',
    },
  });
}

// Public operational endpoints must remain reachable through hosted proxies so
// Render/Cloudflare can perform health checks and Argus can distinguish a
// sleeping service from an API-surface policy response.
const EXTERNAL_ROUTES = new Set(['/healthz', '/readyz', '/v1/chat/completions', '/v1/route', '/mcp']);

function requireExternalSurfaceAllowlist(req: Request, res: Response, next: NextFunction): void {
  if (
    !hasPublicProxyHeaders(req)
    || EXTERNAL_ROUTES.has(req.path)
    || req.path === '/dashboard'
    || req.path.startsWith('/dashboard/')
  ) {
    next();
    return;
  }

  res.status(404).json({
    error: {
      message: 'Endpoint is not available through the external API surface.',
      type: 'not_found',
      code: 'external_endpoint_not_exposed',
    },
  });
}

export const createServer = (router: Router, quotaManager: QuotaManager, options: CreateServerOptions = {}) => {
  const app = express();
  const apiKeyStore = options.apiKeyStore || createDefaultSecretStore();
  const getTunnelInfo = options.getTunnelInfo;
  const keyMetadata = new Map<string, ProviderKeyMetadata>();

  // Aegis-verified hosted mode is opt-in and additive: when disabled (the default), this is
  // exactly `requireClientApiKey`, so local/desktop behavior is unchanged.
  const authMiddleware = config.aegis.enabled
    ? createRequireAegisToken({
        issuer: config.aegis.issuer,
        audience: config.aegis.clientId,
        quota: options.aegisQuotaManager ?? new QuotaManager(),
        defaultRequestsPerMinute: config.aegis.defaultRequestsPerMinute,
        defaultRequestsPerDay: config.aegis.defaultRequestsPerDay,
      })
    : requireClientApiKey;

  const logTenantUsage = (req: Request, model: string, usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) => {
    const tenant = (req as Request & { tenant?: AegisTenant }).tenant;
    if (!tenant || !usage) return;
    try {
      console.log(JSON.stringify({
        event: 'tenant_usage',
        clientId: tenant.clientId,
        model,
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
      }));
    } catch (e) {
      console.error('Failed to log tenant usage', e);
    }
  };

  app.use(cors({ exposedHeaders: ['Mcp-Session-Id'] }));
  app.use(express.json({ limit: config.bodyLimit }));

  if (options.enforceExternalSurface !== false) {
    app.use(requireExternalSurfaceAllowlist);
  }

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'leyline' });
  });

  app.get('/readyz', (_req, res) => {
    const providerCount = router.getProviders().length;
    res.status(providerCount > 0 ? 200 : 503).json({
      status: providerCount > 0 ? 'ready' : 'unavailable',
      service: 'leyline',
      providers: providerCount,
    });
  });

  app.use('/dashboard', requireLocalDashboardAccess);

  // Serve dashboard static files
  app.use('/dashboard', express.static(path.join(__dirname, '../public')));

  // Serve logo at root level
  app.get('/logo.png', (_req, res) => {
    res.sendFile(path.join(__dirname, '../public/logo.png'));
  });

  // Simple in-memory cache for models
  const modelCache: Record<string, { models: any[], timestamp: number }> = {};
  const CACHE_TTL = 3600 * 1000; // 1 hour

  const applyRoutingConfig = (routing: PersistedRoutingConfig) => {
    if (routing.mode === 'pinned') {
      router.setSingleModel({
        enabled: true,
        provider: routing.pinnedProvider || null,
        model: routing.pinnedModel || null,
      });
    } else if (routing.mode === 'auto') {
      router.setSingleModel(undefined);
    }
    if (routing.enabledModels !== undefined) {
      const hasEntries = Object.keys(routing.enabledModels).length > 0;
      router.setEnabledModels(hasEntries ? routing.enabledModels : undefined);
    }
    if (routing.modelPins !== undefined) {
      const hasEntries = Object.keys(routing.modelPins).length > 0;
      router.setModelPins(hasEntries ? routing.modelPins : undefined);
    }
  };

  const persistRoutingConfig = async () => {
    const single = router.getSingleModel();
    await apiKeyStore.set(ROUTING_CONFIG_ACCOUNT, serializeRoutingConfig({
      mode: single?.enabled ? 'pinned' : 'auto',
      pinnedProvider: single?.provider || '',
      pinnedModel: single?.model || '',
      enabledModels: router.getEnabledModels(),
      modelPins: router.getModelPins(),
    }));
  };

  const initializeRouting = async () => {
    const persisted = await apiKeyStore.get(ROUTING_CONFIG_ACCOUNT);
    if (!persisted) return;
    const saved = parseRoutingConfig(persisted);
    if (saved) applyRoutingConfig(saved);
  };

  const initializeApiKeys = async () => {
    await initializeRouting();
    await Promise.all(router.getProviders().map(async provider => {
      if (isApiKeyConfigurableProvider(provider)) {
        if (provider.hasApiKey()) {
          keyMetadata.set(provider.name, { source: 'env' });
        } else {
          const persistedKey = await apiKeyStore.get(apiKeyAccount(provider.name));
          if (persistedKey) {
            provider.setApiKey(persistedKey);
            const source = apiKeyStore.getSource
              ? await apiKeyStore.getSource(apiKeyAccount(provider.name))
              : apiKeyStore.status().mode;
            keyMetadata.set(provider.name, { source });
          } else {
            keyMetadata.set(provider.name, { source: 'none' });
          }
        }
      }

      if (isRuntimeConfigurableProvider(provider)) {
        const persistedRuntime = await apiKeyStore.get(runtimeConfigAccount(provider.name));
        if (!persistedRuntime) return;

        const saved = parseRuntimeConfig(persistedRuntime);
        if (!saved) return;

        const current = provider.getRuntimeConfig();
        provider.setRuntimeConfig({
          baseUrl: current.baseUrlConfigured ? undefined : saved.baseUrl,
          model: saved.model,
        });
      }
    }));

    await router.reindexAll();
  };

  const persistRuntimeConfig = async (provider: RuntimeConfigurableProvider) => {
    const runtime = provider.getRuntimeConfig();
    await apiKeyStore.set(
      runtimeConfigAccount(provider.name),
      serializeRuntimeConfig({
        baseUrl: typeof runtime.baseUrl === 'string' ? runtime.baseUrl : '',
        model: typeof runtime.model === 'string' ? runtime.model : '',
      }),
    );
  };

  const apiKeyInitialization = initializeApiKeys();

  app.get('/readyz', async (_req, res) => {
    await apiKeyInitialization;
    res.json({ status: 'ready', service: 'leyline' });
  });

  const mcpHandler = createMcpHttpHandler(router);
  app.post('/mcp', authMiddleware, async (req, res, next) => {
    await apiKeyInitialization;
    return mcpHandler(req, res, next);
  });
  app.delete('/mcp', authMiddleware, async (req, res, next) => {
    await apiKeyInitialization;
    return mcpHandler(req, res, next);
  });

  const providerKeyStatus = (provider: ApiKeyConfigurableProvider) => {
    const source = keyMetadata.get(provider.name)?.source || (provider.hasApiKey() ? 'env' : 'none');
    const storeStatus = apiKeyStore.status();
    const runtimeConfig = isRuntimeConfigurableProvider(provider) ? provider.getRuntimeConfig() : undefined;
    const runtimeReady = !isRuntimeConfigurableProvider(provider)
      || Boolean(runtimeConfig?.baseUrlConfigured && provider.hasApiKey());

    return {
      configured: provider.hasApiKey(),
      source: provider.hasApiKey() ? source : 'none',
      persisted: provider.hasApiKey() && (source === 'keychain' || source === 'arcana'),
      arcanaAvailable: Boolean(
        apiKeyStore.setArcanaReference
        || apiKeyStore.hasArcanaReference?.(apiKeyAccount(provider.name)),
      ),
      arcanaReference: apiKeyStore.getArcanaReference?.(apiKeyAccount(provider.name)),
      keychainAvailable: storeStatus.mode === 'keychain' && storeStatus.available,
      runtimeReady,
    };
  };

  const dashboardPersistenceStatus = () => {
    const storeStatus = apiKeyStore.status();
    return {
      server: storeStatus,
      modes: {
        keychain: {
          available: storeStatus.mode === 'keychain' && storeStatus.available,
          service: storeStatus.service,
          warning: storeStatus.mode === 'keychain' && storeStatus.available ? undefined : storeStatus.warning,
        },
        memory: {
          available: true,
          warning: 'Memory keys are available only until this server process exits.',
        },
        localStorage: {
          available: true,
          warning: 'Browser localStorage is browser-local, less secure than Apple Keychain, and cleared if browser storage is cleared.',
        },
        arcana: {
          available: Boolean(apiKeyStore.setArcanaReference || apiKeyStore.hasArcanaReference?.()),
          warning: 'Arcana references are read-only and must be configured in the environment or Arcana project policy.',
        },
      },
    };
  };

  // Dashboard Stats API
  app.get('/dashboard/stats', async (req, res) => {
    await apiKeyInitialization;
    const stats = quotaManager.getStats();

    const providers = await Promise.all(router.getProviders().map(async p => {
        const pStats = stats[p.name];

        let models: any[] = [];
        const cached = modelCache[p.name];

        if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
            models = cached.models;
        } else {
            try {
                models = await p.getModels();
                models = models.map(m => ({
                    ...m,
                    score: getModelScore(m.id)
                }));
                modelCache[p.name] = { models, timestamp: Date.now() };
            } catch (e) {
                console.error(`Failed to fetch models for ${p.name}`, e);
                models = [];
            }
        }

        return {
            name: p.name,
            family: p.family,
            label: p.label,
            defaultModel: p.defaultModel,
            apiKeyConfigurable: isApiKeyConfigurableProvider(p),
            apiKeyConfigured: isApiKeyConfigurableProvider(p) ? p.hasApiKey() : undefined,
            apiKeyStatus: isApiKeyConfigurableProvider(p) ? providerKeyStatus(p) : undefined,
            runtimeConfigurable: isRuntimeConfigurableProvider(p),
            runtimeConfig: isRuntimeConfigurableProvider(p) ? p.getRuntimeConfig() : undefined,
            runtimeReady: providerRuntimeReady(p),
            models,
            quota: pStats?.quota,
            usage: {
                minute: pStats?.minute || 0,
                day: pStats?.day || 0
            }
        };
    }));

    res.json({
        providers,
        logs: logger.getLogs(),
        tunnel: getTunnelInfo?.() ?? { enabled: false, state: 'disabled' },
        clientAuth: {
          enabled: Boolean(config.clientApiKey),
          apiKey: config.clientApiKey || null,
          generated: config.tunnel.enabled && process.env.LEYLINE_CLIENT_API_KEY === undefined && process.env.LEYLINE_CLIENT_AUTH_ENABLED !== 'false',
        },
    });
  });

  app.get('/dashboard/tunnel', (_req, res) => {
    res.json(getTunnelInfo?.() ?? { enabled: false, state: 'disabled' });
  });

  app.get('/dashboard/api-keys', async (_req, res) => {
    await apiKeyInitialization;
    res.json({
      persistence: dashboardPersistenceStatus(),
      routing: dashboardRoutingStatus(router),
      providers: router.getProviders()
        .filter(isApiKeyConfigurableProvider)
        .map(provider => ({
          name: provider.name,
          family: provider.family,
          label: provider.label,
          defaultModel: provider.defaultModel,
          ...providerKeyStatus(provider),
          runtimeConfigurable: isRuntimeConfigurableProvider(provider),
          runtimeConfig: isRuntimeConfigurableProvider(provider) ? provider.getRuntimeConfig() : undefined,
          runtimeReady: providerRuntimeReady(provider),
        })),
    });
  });

  app.post('/dashboard/api-keys', async (req, res) => {
    await apiKeyInitialization;
    const { provider: providerName, apiKey, baseUrl, model, persistence, arcanaReference } = req.body || {};

    if (!providerName || typeof providerName !== 'string') {
      return res.status(400).json({ error: 'provider is required' });
    }
    if (apiKey !== undefined && typeof apiKey !== 'string') {
      return res.status(400).json({ error: 'apiKey must be a string' });
    }
    if (arcanaReference !== undefined && typeof arcanaReference !== 'string') {
      return res.status(400).json({ error: 'arcanaReference must be a string' });
    }
    if (persistence !== undefined && !isApiKeyPersistenceMode(persistence)) {
      return res.status(400).json({ error: 'persistence must be keychain, localStorage, memory, or arcana' });
    }

    const provider = router.getProviders()
      .find(p => p.name.toLowerCase() === providerName.toLowerCase());

    if (!provider) {
      return res.status(404).json({ error: `Provider "${providerName}" is not registered` });
    }
    if (!isApiKeyConfigurableProvider(provider)) {
      return res.status(400).json({ error: `Provider "${provider.name}" does not support API key overrides` });
    }

    const trimmedApiKey = typeof apiKey === 'string' ? apiKey.trim() : undefined;
    const requestedPersistence: ApiKeyPersistenceMode = persistence || 'keychain';

    if (requestedPersistence === 'arcana') {
      if (arcanaReference?.trim()) {
        if (!apiKeyStore.setArcanaReference) {
          return res.status(400).json({ error: 'Arcana references cannot be configured by this secret store' });
        }
        try {
          apiKeyStore.setArcanaReference(apiKeyAccount(provider.name), arcanaReference.trim());
        } catch (error) {
          return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid Arcana reference' });
        }
      }
      const arcanaKey = await apiKeyStore.get(apiKeyAccount(provider.name));
      if (!arcanaKey || (await apiKeyStore.getSource?.(apiKeyAccount(provider.name))) !== 'arcana') {
        return res.status(400).json({
          error: `No Arcana reference resolved for provider "${provider.name}"`,
        });
      }
      provider.setApiKey(arcanaKey);
      keyMetadata.set(provider.name, { source: 'arcana' });
    } else if (trimmedApiKey) {
      provider.setApiKey(trimmedApiKey);

      if (requestedPersistence === 'keychain') {
        await apiKeyStore.set(apiKeyAccount(provider.name), trimmedApiKey);
        keyMetadata.set(provider.name, { source: apiKeyStore.status().mode });
      } else {
        keyMetadata.set(provider.name, { source: requestedPersistence });
      }
    } else if (trimmedApiKey === '') {
      await apiKeyStore.delete(apiKeyAccount(provider.name));
      provider.setApiKey('');
      keyMetadata.set(provider.name, { source: 'none' });
    }
    if (isRuntimeConfigurableProvider(provider)) {
      provider.setRuntimeConfig({
        baseUrl: typeof baseUrl === 'string' ? baseUrl : undefined,
        model: typeof model === 'string' ? model : undefined,
      });
      if (typeof baseUrl === 'string' || typeof model === 'string') {
        await persistRuntimeConfig(provider);
      }
    }
    delete modelCache[provider.name];
    await router.reindexProvider(provider);

    return res.json({
      provider: provider.name,
      ...providerKeyStatus(provider),
      persistence: dashboardPersistenceStatus(),
      runtimeConfig: isRuntimeConfigurableProvider(provider) ? provider.getRuntimeConfig() : undefined,
    });
  });

  app.delete('/dashboard/api-keys/:provider', async (req, res) => {
    await apiKeyInitialization;
    const providerName = req.params.provider;
    const provider = router.getProviders()
      .find(p => p.name.toLowerCase() === providerName.toLowerCase());

    if (!provider) {
      return res.status(404).json({ error: `Provider "${providerName}" is not registered` });
    }
    if (!isApiKeyConfigurableProvider(provider)) {
      return res.status(400).json({ error: `Provider "${provider.name}" does not support API key overrides` });
    }

    await apiKeyStore.delete(apiKeyAccount(provider.name));
    provider.setApiKey('');
    keyMetadata.set(provider.name, { source: 'none' });
    delete modelCache[provider.name];
    await router.reindexProvider(provider);

    return res.json({
      provider: provider.name,
      ...providerKeyStatus(provider),
      persistence: dashboardPersistenceStatus(),
      runtimeConfig: isRuntimeConfigurableProvider(provider) ? provider.getRuntimeConfig() : undefined,
    });
  });

  // Routing control: auto vs pinned mode, and the per-model routing pool
  app.get('/dashboard/routing', async (_req, res) => {
    await apiKeyInitialization;
    res.json(dashboardRoutingStatus(router));
  });

  app.post('/dashboard/routing', async (req, res) => {
    await apiKeyInitialization;
    const { mode, pinnedProvider, pinnedModel, enabledModels, modelPins } = req.body || {};

    if (mode !== undefined && mode !== 'auto' && mode !== 'pinned') {
      return res.status(400).json({ error: "mode must be 'auto' or 'pinned'" });
    }
    if (pinnedProvider !== undefined && typeof pinnedProvider !== 'string') {
      return res.status(400).json({ error: 'pinnedProvider must be a string' });
    }
    if (pinnedModel !== undefined && typeof pinnedModel !== 'string') {
      return res.status(400).json({ error: 'pinnedModel must be a string' });
    }

    const registered = new Map(router.getProviders().map(p => [p.name.toLowerCase(), p.name]));
    if (pinnedProvider?.trim() && !registered.has(pinnedProvider.trim().toLowerCase())) {
      return res.status(400).json({ error: `Provider "${pinnedProvider}" is not registered` });
    }

    let sanitizedEnabled: Record<string, string[]> | undefined;
    if (enabledModels !== undefined) {
      sanitizedEnabled = sanitizeEnabledModels(enabledModels);
      if (!sanitizedEnabled) {
        return res.status(400).json({ error: 'enabledModels must map provider names to arrays of model ids' });
      }
      for (const provider of Object.keys(sanitizedEnabled)) {
        if (!registered.has(provider.toLowerCase())) {
          return res.status(400).json({ error: `Provider "${provider}" is not registered` });
        }
      }
    }

    let sanitizedPins: Record<string, string> | undefined;
    if (modelPins !== undefined) {
      sanitizedPins = sanitizeModelPins(modelPins);
      if (!sanitizedPins) {
        return res.status(400).json({ error: 'modelPins must map model ids to provider names' });
      }
      for (const provider of Object.values(sanitizedPins)) {
        if (!registered.has(provider.toLowerCase())) {
          return res.status(400).json({ error: `Provider "${provider}" is not registered` });
        }
      }
    }

    const currentSingle = router.getSingleModel();
    const nextMode: 'auto' | 'pinned' = mode ?? (currentSingle?.enabled ? 'pinned' : 'auto');
    const nextPinnedModel = (pinnedModel ?? currentSingle?.model ?? '').trim();
    if (nextMode === 'pinned' && !nextPinnedModel) {
      return res.status(400).json({ error: 'pinnedModel is required when mode is pinned' });
    }

    applyRoutingConfig({
      mode: nextMode,
      pinnedProvider: (pinnedProvider ?? currentSingle?.provider ?? '').trim(),
      pinnedModel: nextPinnedModel,
      enabledModels: sanitizedEnabled,
      modelPins: sanitizedPins,
    });
    await persistRoutingConfig();

    return res.json(dashboardRoutingStatus(router));
  });

  // ── Generic multi-instance provider management ───────────────────────
  // Lets a family (currently just Azure OpenAI) register more than one
  // configured instance (distinct endpoint/key/etc). The generic routes
  // below know nothing about Azure specifically — they're driven entirely
  // by each family's declared `fields` and their `role` tags.

  function findNamingProvider(): Provider | undefined {
    return router.getProviders().find(p => {
      if (!isApiKeyConfigurableProvider(p) || !p.hasApiKey()) return false;
      const runtimeReady = providerRuntimeReady(p);
      return runtimeReady !== false;
    });
  }

  async function buildNamingAdapter() {
    const namingProvider = findNamingProvider();
    if (!namingProvider) return undefined;
    return {
      async complete(system: string, user: string): Promise<string> {
        const response = await namingProvider.complete({
          model: namingProvider.defaultModel,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_tokens: 20,
        });
        return response.choices?.[0]?.message?.content || '';
      },
    };
  }

  app.get('/dashboard/provider-instances', (_req, res) => {
    res.json({
      families: INSTANCE_FAMILIES.map(f => ({
        family: f.family,
        displayName: f.displayName,
        baseName: f.baseName,
        fields: f.fields,
        instances: router.getProviders()
          .filter(p => p.family === f.family && p.name !== f.baseName)
          .map(p => ({ id: p.name.slice(f.baseName.length + 1), name: p.name, label: p.label })),
      })),
    });
  });

  app.post('/dashboard/provider-instances', async (req, res) => {
    await apiKeyInitialization;
    const { family, config: instanceConfig } = req.body || {};

    if (typeof family !== 'string' || !family) {
      return res.status(400).json({ error: 'family is required' });
    }
    const familyDef = INSTANCE_FAMILIES.find(f => f.family === family);
    if (!familyDef) {
      return res.status(404).json({ error: `Unknown provider family "${family}"` });
    }
    if (!instanceConfig || typeof instanceConfig !== 'object') {
      return res.status(400).json({ error: 'config is required' });
    }

    const rawConfig: Record<string, string> = {};
    for (const field of familyDef.fields) {
      const value = (instanceConfig as Record<string, unknown>)[field.key];
      if (value !== undefined && typeof value !== 'string') {
        return res.status(400).json({ error: `config.${field.key} must be a string` });
      }
      // Secret fields are set afterward via the existing /dashboard/api-keys card (same
      // persistence-mode UI every other provider uses), not collected at creation time.
      if (field.required && field.role !== 'secret' && !value?.trim()) {
        return res.status(400).json({ error: `config.${field.key} is required` });
      }
      rawConfig[field.key] = typeof value === 'string' ? value.trim() : '';
    }

    const existingIds = new Set(
      router.getProviders()
        .filter(p => p.family === familyDef.family && p.name !== familyDef.baseName)
        .map(p => p.name.slice(familyDef.baseName.length + 1)),
    );
    const llm = await buildNamingAdapter();
    const id = await generateInstanceId(familyDef.namingHint(rawConfig), existingIds, llm);

    const provider = familyDef.create({ ...rawConfig, id, label: id });
    router.addProvider(provider);

    for (const field of familyDef.fields) {
      if (field.role === 'secret' && rawConfig[field.key]) {
        await apiKeyStore.set(apiKeyAccount(provider.name), rawConfig[field.key]);
        if (isApiKeyConfigurableProvider(provider)) {
          keyMetadata.set(provider.name, { source: apiKeyStore.status().mode });
        }
      }
    }
    if (isRuntimeConfigurableProvider(provider)) {
      const baseUrlField = familyDef.fields.find(f => f.role === 'runtimeBaseUrl');
      const modelField = familyDef.fields.find(f => f.role === 'runtimeModel');
      provider.setRuntimeConfig({
        baseUrl: baseUrlField ? rawConfig[baseUrlField.key] : undefined,
        model: modelField ? rawConfig[modelField.key] : undefined,
      });
      await persistRuntimeConfig(provider);
    }

    const extra: Record<string, string> = {};
    for (const field of familyDef.fields) {
      if (field.role === 'extra' && rawConfig[field.key]) extra[field.key] = rawConfig[field.key];
    }

    const manifestRaw = await apiKeyStore.get(instanceManifestAccount(familyDef.family));
    const manifest = manifestRaw ? parseInstanceManifest(manifestRaw) : [];
    manifest.push({ id, label: id, extra });
    await apiKeyStore.set(instanceManifestAccount(familyDef.family), serializeInstanceManifest(manifest));

    delete modelCache[provider.name];
    await router.reindexProvider(provider);

    return res.json({ name: provider.name, id, label: provider.label });
  });

  app.delete('/dashboard/provider-instances/:family/:id', async (req, res) => {
    await apiKeyInitialization;
    const familyDef = INSTANCE_FAMILIES.find(f => f.family === req.params.family);
    if (!familyDef) {
      return res.status(404).json({ error: `Unknown provider family "${req.params.family}"` });
    }
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ error: 'id is required' });
    }

    const name = `${familyDef.baseName}:${id}`;
    const provider = router.getProviders().find(p => p.name === name);
    if (!provider) {
      return res.status(404).json({ error: `Instance "${id}" is not registered for ${familyDef.family}` });
    }

    router.removeProvider(name);
    await apiKeyStore.delete(apiKeyAccount(name));
    await apiKeyStore.delete(runtimeConfigAccount(name));
    keyMetadata.delete(name);
    delete modelCache[name];

    const manifestRaw = await apiKeyStore.get(instanceManifestAccount(familyDef.family));
    const manifest = (manifestRaw ? parseInstanceManifest(manifestRaw) : []).filter(entry => entry.id !== id);
    await apiKeyStore.set(instanceManifestAccount(familyDef.family), serializeInstanceManifest(manifest));

    await persistRoutingConfig();

    return res.json({ removed: true });
  });

  // Existing: chat completions endpoint (with provider failover)
  app.post('/v1/chat/completions', authMiddleware, async (req, res) => {
    await apiKeyInitialization;
    const request = normalizeCompletionRequest(req.body);

    if (request.messages.length === 0) {
      return res.status(400).json({
        error: {
          message: 'At least one message is required',
          type: 'invalid_request_error',
          code: 'missing_messages',
        },
      });
    }

    const forceProviderHeader = req.headers['x-leyline-force-provider'];
    const forceProvider = typeof forceProviderHeader === 'string' && forceProviderHeader.trim()
      ? forceProviderHeader.trim()
      : undefined;
    if (forceProvider && !router.getProviders().some(p => p.name === forceProvider)) {
      return res.status(400).json({
        error: {
          message: `Provider "${forceProvider}" is not registered`,
          type: 'invalid_request_error',
          code: 'unknown_provider',
        },
      });
    }
    const routeOptions = forceProvider ? { forceProvider } : undefined;

    try {
      if (request.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const stream = await router.routeStream(request, routeOptions);
        let streamUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;

        for await (const chunk of stream) {
            if (chunk.usage) streamUsage = chunk.usage;
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
        logTenantUsage(req, request.model, streamUsage);

      } else {
        const response = await router.route(request, routeOptions);
        res.json(response);
        logTenantUsage(req, request.model, response.usage);
      }
    } catch (error: any) {
      const hydrated = await hydrateAxiosError(error);
      console.error('API Error:', formatProviderError(hydrated));
      const { status, body } = chatCompletionErrorResponse(hydrated);
      res.status(status).json(body);
    }
  });

  // ── NEW: Routing decision endpoint ───────────────────────────────────
  // Returns a full routing decision (tier, model, provider, classification)
  // for a user message. Used by agent pipelines to decide which model to
  // use before dispatching a request.
  app.post('/v1/route', authMiddleware, async (req, res) => {
    await apiKeyInitialization;
    const { user_message, chat_history } = req.body || {};
    if (!user_message) {
      return res.status(400).json({ error: 'user_message is required' });
    }

    try {
      const classifyReq: ClassifyRequest = {
        userMessage: user_message,
        chatHistory: chat_history,
      };
      const result = await router.resolveRoute(classifyReq);
      return res.json(result);
    } catch (error: any) {
      console.error('/v1/route Error:', error.message);
      return res.status(500).json({
        error: 'Routing failed: ' + error.message,
      });
    }
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    const payloadError = err as { type?: string; status?: number; message?: string };
    if (payloadError?.type === 'entity.too.large' || payloadError?.status === 413) {
      return res.status(413).json({
        error: {
          message: `Request body exceeds Leyline limit (${config.bodyLimit}). Set LEYLINE_BODY_LIMIT to raise it.`,
          type: 'invalid_request_error',
          code: 'payload_too_large',
        },
      });
    }
    next(err);
  });

  return app;
};

export interface StartServerOptions extends CreateServerOptions {
  port?: number;
}

export function startServer(
  router: Router,
  quotaManager: QuotaManager,
  options: StartServerOptions = {},
): Promise<HttpServer> {
  const app = createServer(router, quotaManager, options);
  const port = options.port ?? config.port;
  const host = options.host ?? '127.0.0.1';

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once('error', reject);
  });
}
