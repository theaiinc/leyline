import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import { Router } from './core/router';
import { CompletionRequest, ClassifyRequest, Provider, ApiKeyConfigurableProvider, RuntimeConfigurableProvider } from './core/types';
import { logger } from './core/logger';
import { QuotaManager } from './core/quota-manager';
import { getModelScore } from './core/leaderboard-data';
import { config } from './config';
import { requireClientApiKey } from './core/client-auth';
import { chatCompletionErrorResponse, formatProviderError, hydrateAxiosError } from './core/api-errors';
import { normalizeCompletionRequest } from './core/normalize-request';
import type { TunnelInfo } from './core/cloudflared-tunnel';
import {
  ApiKeyPersistenceMode,
  ApiKeySource,
  SecretStore,
  apiKeyAccount,
  createDefaultSecretStore,
  parseRuntimeConfig,
  runtimeConfigAccount,
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
}

type ProviderKeyMetadata = {
  source: ApiKeySource;
};

function isApiKeyPersistenceMode(value: unknown): value is ApiKeyPersistenceMode {
  return value === 'keychain' || value === 'memory' || value === 'localStorage';
}

function providerRuntimeReady(provider: Provider): boolean | undefined {
  if (!isRuntimeConfigurableProvider(provider)) return undefined;
  return Boolean(provider.getRuntimeConfig().baseUrlConfigured);
}

function dashboardRoutingStatus() {
  return {
    singleModelEnabled: config.singleModel.enabled,
    fixedProvider: config.singleModel.provider || null,
    fixedModel: config.singleModel.model || null,
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

export const createServer = (router: Router, quotaManager: QuotaManager, options: CreateServerOptions = {}) => {
  const app = express();
  const apiKeyStore = options.apiKeyStore || createDefaultSecretStore();
  const getTunnelInfo = options.getTunnelInfo;
  const keyMetadata = new Map<string, ProviderKeyMetadata>();

  app.use(cors());
  app.use(express.json({ limit: config.bodyLimit }));

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

  const initializeApiKeys = async () => {
    await Promise.all(router.getProviders().map(async provider => {
      if (isApiKeyConfigurableProvider(provider)) {
        if (provider.hasApiKey()) {
          keyMetadata.set(provider.name, { source: 'env' });
        } else {
          const persistedKey = await apiKeyStore.get(apiKeyAccount(provider.name));
          if (persistedKey) {
            provider.setApiKey(persistedKey);
            keyMetadata.set(provider.name, { source: apiKeyStore.status().mode });
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

  const providerKeyStatus = (provider: ApiKeyConfigurableProvider) => {
    const source = keyMetadata.get(provider.name)?.source || (provider.hasApiKey() ? 'env' : 'none');
    const storeStatus = apiKeyStore.status();
    const runtimeConfig = isRuntimeConfigurableProvider(provider) ? provider.getRuntimeConfig() : undefined;
    const runtimeReady = !isRuntimeConfigurableProvider(provider)
      || Boolean(runtimeConfig?.baseUrlConfigured && provider.hasApiKey());

    return {
      configured: provider.hasApiKey(),
      source: provider.hasApiKey() ? source : 'none',
      persisted: provider.hasApiKey() && source === 'keychain',
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
      routing: dashboardRoutingStatus(),
      providers: router.getProviders()
        .filter(isApiKeyConfigurableProvider)
        .map(provider => ({
          name: provider.name,
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
    const { provider: providerName, apiKey, baseUrl, model, persistence } = req.body || {};

    if (!providerName || typeof providerName !== 'string') {
      return res.status(400).json({ error: 'provider is required' });
    }
    if (apiKey !== undefined && typeof apiKey !== 'string') {
      return res.status(400).json({ error: 'apiKey must be a string' });
    }
    if (persistence !== undefined && !isApiKeyPersistenceMode(persistence)) {
      return res.status(400).json({ error: 'persistence must be keychain, localStorage, or memory' });
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

    if (trimmedApiKey) {
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

    return res.json({
      provider: provider.name,
      ...providerKeyStatus(provider),
      persistence: dashboardPersistenceStatus(),
      runtimeConfig: isRuntimeConfigurableProvider(provider) ? provider.getRuntimeConfig() : undefined,
    });
  });

  // Existing: chat completions endpoint (with provider failover)
  app.post('/v1/chat/completions', requireClientApiKey, async (req, res) => {
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

    try {
      if (request.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const stream = await router.routeStream(request);

        for await (const chunk of stream) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();

      } else {
        const response = await router.route(request);
        res.json(response);
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
  app.post('/v1/route', requireClientApiKey, async (req, res) => {
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
