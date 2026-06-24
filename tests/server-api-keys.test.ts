import request from 'supertest';
import { createServer } from '../src/server';
import { Router } from '../src/core/router';
import { QuotaManager } from '../src/core/quota-manager';
import { Provider, CompletionRequest, CompletionResponse, StreamChunk, ModelDetail } from '../src/core/types';
import { SecretStore, SecretStoreStatus, apiKeyAccount, runtimeConfigAccount, serializeRuntimeConfig } from '../src/core/secret-store';
import { logger } from '../src/core/logger';
import { LEYLINE_CLIENT_AUTH_HEADER } from './client-auth-header';

class TestSecretStore implements SecretStore {
  values = new Map<string, string>();
  deleted: string[] = [];

  constructor(private readonly storeStatus: SecretStoreStatus = {
    mode: 'keychain',
    available: true,
    service: '@theaiinc/leyline',
  }) {}

  async get(account: string): Promise<string | undefined> {
    return this.values.get(account);
  }

  async set(account: string, secret: string): Promise<void> {
    this.values.set(account, secret);
  }

  async delete(account: string): Promise<void> {
    this.deleted.push(account);
    this.values.delete(account);
  }

  status(): SecretStoreStatus {
    return this.storeStatus;
  }
}

class ConfigurableProvider implements Provider {
  name = 'OpenAI';
  defaultModel = 'gpt-5.5';
  private apiKey = '';

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  async isAvailable(): Promise<boolean> {
    return this.hasApiKey();
  }

  async getModels(): Promise<ModelDetail[]> {
    return [];
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    return {
      id: 'test',
      object: 'chat.completion',
      created: 1,
      model: request.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }

  async *completeStream(): AsyncGenerator<StreamChunk, void, unknown> {
    yield {
      id: 'test',
      object: 'chat.completion.chunk',
      created: 1,
      model: this.defaultModel,
      choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
    };
  }
}

class RuntimeProvider extends ConfigurableProvider {
  name = 'AzureOpenAI';
  defaultModel = 'gpt-5.5';
  baseUrl = '';

  getRuntimeConfig(): Record<string, string | boolean | undefined> {
    return {
      baseUrl: this.baseUrl,
      model: this.defaultModel,
      baseUrlConfigured: Boolean(this.baseUrl),
    };
  }

  setRuntimeConfig(config: Record<string, string | undefined>): void {
    if (typeof config.baseUrl === 'string') this.baseUrl = config.baseUrl.trim();
    if (typeof config.model === 'string') this.defaultModel = config.model.trim();
  }
}

class StaticProvider implements Provider {
  name = 'Ollama';
  defaultModel = 'llama2';

  async isAvailable(): Promise<boolean> { return true; }
  async getModels(): Promise<ModelDetail[]> { return []; }
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    return {
      id: 'test',
      object: 'chat.completion',
      created: 1,
      model: request.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    };
  }
  async *completeStream(): AsyncGenerator<StreamChunk, void, unknown> {
    yield {
      id: 'test',
      object: 'chat.completion.chunk',
      created: 1,
      model: this.defaultModel,
      choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
    };
  }
}

describe('dashboard API key overrides', () => {
  beforeEach(() => {
    logger.clear();
  });

  it('should list configurable provider key status without exposing keys', async () => {
    const router = new Router();
    router.addProvider(new ConfigurableProvider());
    router.addProvider(new StaticProvider());
    const app = createServer(router, new QuotaManager(), { apiKeyStore: new TestSecretStore() });

    const response = await request(app).get('/dashboard/api-keys').expect(200);

    expect(response.body.persistence.modes.keychain.available).toBe(true);
    expect(response.body.providers).toMatchObject([
      {
        name: 'OpenAI',
        defaultModel: 'gpt-5.5',
        configured: false,
        source: 'none',
        persisted: false,
        runtimeConfigurable: false,
      },
    ]);
    expect(JSON.stringify(response.body)).not.toContain('sk-');
  });

  it('should update a provider API key and persist through the store abstraction', async () => {
    const router = new Router();
    const provider = new ConfigurableProvider();
    const store = new TestSecretStore();
    router.addProvider(provider);
    const app = createServer(router, new QuotaManager(), { apiKeyStore: store });

    const response = await request(app)
      .post('/dashboard/api-keys')
      .send({ provider: 'openai', apiKey: 'sk-test', persistence: 'keychain' })
      .expect(200);

    expect(response.body).toMatchObject({
      provider: 'OpenAI',
      configured: true,
      source: 'keychain',
      persisted: true,
    });
    expect(store.values.get('api-key:OpenAI')).toBe('sk-test');
    expect(provider.hasApiKey()).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain('sk-test');
  });

  it('should apply a stored key on startup when env/config did not provide one', async () => {
    const router = new Router();
    const provider = new ConfigurableProvider();
    const store = new TestSecretStore();
    store.values.set('api-key:OpenAI', 'stored-key');
    router.addProvider(provider);
    const app = createServer(router, new QuotaManager(), { apiKeyStore: store });

    const response = await request(app).get('/dashboard/api-keys').expect(200);

    expect(provider.hasApiKey()).toBe(true);
    expect(response.body.providers[0]).toMatchObject({
      configured: true,
      source: 'keychain',
      persisted: true,
    });
    expect(JSON.stringify(response.body)).not.toContain('stored-key');
  });

  it('should accept browser localStorage mode without server-side persistence', async () => {
    const router = new Router();
    const provider = new ConfigurableProvider();
    const store = new TestSecretStore();
    router.addProvider(provider);
    const app = createServer(router, new QuotaManager(), { apiKeyStore: store });

    const response = await request(app)
      .post('/dashboard/api-keys')
      .send({ provider: 'OpenAI', apiKey: 'browser-key', persistence: 'localStorage' })
      .expect(200);

    expect(provider.hasApiKey()).toBe(true);
    expect(store.values.size).toBe(0);
    expect(response.body).toMatchObject({
      provider: 'OpenAI',
      configured: true,
      source: 'localStorage',
      persisted: false,
    });
    expect(JSON.stringify(response.body)).not.toContain('browser-key');
  });

  it('should update runtime provider URL and model without exposing the key', async () => {
    const router = new Router();
    const provider = new RuntimeProvider();
    const store = new TestSecretStore();
    router.addProvider(provider);
    const app = createServer(router, new QuotaManager(), { apiKeyStore: store });

    const response = await request(app)
      .post('/dashboard/api-keys')
      .send({
        provider: 'AzureOpenAI',
        apiKey: 'azure-key',
        baseUrl: 'https://otlrs-dev-agents-resource.services.ai.azure.com/openai/v1',
        model: 'gpt-5.5',
      })
      .expect(200);

    expect(response.body.provider).toBe('AzureOpenAI');
    expect(response.body.configured).toBe(true);
    expect(response.body.source).toBe('keychain');
    expect(response.body.runtimeConfig).toMatchObject({
      baseUrl: 'https://otlrs-dev-agents-resource.services.ai.azure.com/openai/v1',
      model: 'gpt-5.5',
      baseUrlConfigured: true,
    });
    expect(store.values.get(runtimeConfigAccount('AzureOpenAI'))).toBe(
      serializeRuntimeConfig({
        baseUrl: 'https://otlrs-dev-agents-resource.services.ai.azure.com/openai/v1',
        model: 'gpt-5.5',
      }),
    );
    expect(JSON.stringify(response.body)).not.toContain('azure-key');
  });

  it('should apply stored runtime settings on startup when env did not provide a base URL', async () => {
    const router = new Router();
    const provider = new RuntimeProvider();
    const store = new TestSecretStore();
    store.values.set(
      runtimeConfigAccount('AzureOpenAI'),
      serializeRuntimeConfig({
        baseUrl: 'https://otlrs-dev-agents-resource.services.ai.azure.com/openai/v1',
        model: 'gpt-5.5',
      }),
    );
    router.addProvider(provider);
    const app = createServer(router, new QuotaManager(), { apiKeyStore: store });

    const response = await request(app).get('/dashboard/api-keys').expect(200);

    expect(response.body.providers[0]).toMatchObject({
      name: 'AzureOpenAI',
      runtimeReady: true,
      runtimeConfig: {
        baseUrl: 'https://otlrs-dev-agents-resource.services.ai.azure.com/openai/v1',
        model: 'gpt-5.5',
        baseUrlConfigured: true,
      },
    });
  });

  it('should load keychain API key and runtime settings together on startup', async () => {
    const router = new Router();
    const provider = new RuntimeProvider();
    const store = new TestSecretStore();
    store.values.set('api-key:AzureOpenAI', 'stored-key');
    store.values.set(
      runtimeConfigAccount('AzureOpenAI'),
      serializeRuntimeConfig({
        baseUrl: 'https://otlrs-dev-agents-resource.services.ai.azure.com/openai/v1',
        model: 'gpt-5.5',
      }),
    );
    router.addProvider(provider);
    const app = createServer(router, new QuotaManager(), { apiKeyStore: store });

    const response = await request(app).get('/dashboard/api-keys').expect(200);

    expect(provider.hasApiKey()).toBe(true);
    expect(response.body.providers[0]).toMatchObject({
      configured: true,
      source: 'keychain',
      persisted: true,
      runtimeConfig: {
        baseUrl: 'https://otlrs-dev-agents-resource.services.ai.azure.com/openai/v1',
        model: 'gpt-5.5',
        baseUrlConfigured: true,
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('stored-key');
  });

  it('should persist Azure runtime settings to the secret store when saved from the dashboard', async () => {
    const router = new Router();
    const provider = new RuntimeProvider();
    const store = new TestSecretStore();
    router.addProvider(provider);
    const app = createServer(router, new QuotaManager(), { apiKeyStore: store });

    await request(app)
      .post('/dashboard/api-keys')
      .send({
        provider: 'AzureOpenAI',
        baseUrl: 'https://otlrs-dev-agents-resource.services.ai.azure.com/openai/v1',
        model: 'gpt-5.5',
      })
      .expect(200);

    expect(store.values.get('runtime-config:AzureOpenAI')).toBe(
      serializeRuntimeConfig({
        baseUrl: 'https://otlrs-dev-agents-resource.services.ai.azure.com/openai/v1',
        model: 'gpt-5.5',
      }),
    );
  });

  it('should clear a key without clearing runtime provider settings', async () => {
    const router = new Router();
    const provider = new RuntimeProvider();
    provider.setApiKey('azure-key');
    provider.setRuntimeConfig({
      baseUrl: 'https://otlrs-dev-agents-resource.services.ai.azure.com/openai/v1',
      model: 'gpt-5.5',
    });
    const store = new TestSecretStore();
    store.values.set('api-key:AzureOpenAI', 'azure-key');
    router.addProvider(provider);
    const app = createServer(router, new QuotaManager(), { apiKeyStore: store });

    const response = await request(app)
      .delete('/dashboard/api-keys/AzureOpenAI')
      .expect(200);

    expect(response.body.configured).toBe(false);
    expect(response.body.source).toBe('none');
    expect(store.deleted).toContain('api-key:AzureOpenAI');
    expect(response.body.runtimeConfig).toMatchObject({
      baseUrl: 'https://otlrs-dev-agents-resource.services.ai.azure.com/openai/v1',
      model: 'gpt-5.5',
      baseUrlConfigured: true,
    });
  });

  it('should expose completed router requests in dashboard stats logs', async () => {
    const router = new Router();
    const provider = new ConfigurableProvider();
    provider.setApiKey('test-key');
    router.addProvider(provider);
    const app = createServer(router, new QuotaManager(), { apiKeyStore: new TestSecretStore() });

    await request(app)
      .post('/v1/chat/completions')
      .set(LEYLINE_CLIENT_AUTH_HEADER)
      .send({ model: 'auto', messages: [{ role: 'user', content: 'hello' }] })
      .expect(200);

    const response = await request(app).get('/dashboard/stats').expect(200);

    expect(response.body.logs).toHaveLength(1);
    expect(response.body.logs[0]).toMatchObject({
      provider: 'OpenAI',
      model: 'gpt-5.5',
      status: 'success',
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    expect(response.body.logs[0].requestId).toEqual(expect.any(String));
    expect(response.body.logs[0].timestamp).toEqual(expect.any(String));
    expect(response.body.logs[0].duration).toEqual(expect.any(Number));
  });

  it('should expose unavailable provider attempts in dashboard stats logs', async () => {
    const router = new Router();
    router.addProvider(new ConfigurableProvider());
    const app = createServer(router, new QuotaManager(), { apiKeyStore: new TestSecretStore() });

    await request(app)
      .post('/v1/chat/completions')
      .set(LEYLINE_CLIENT_AUTH_HEADER)
      .send({ model: 'auto', messages: [{ role: 'user', content: 'hello' }] })
      .expect(503);

    const response = await request(app).get('/dashboard/stats').expect(200);

    expect(response.body.logs).toHaveLength(1);
    expect(response.body.logs[0]).toMatchObject({
      provider: 'OpenAI',
      model: 'gpt-5.5',
      status: 'error',
      error: 'OpenAI reported unavailable',
    });
  });
});
