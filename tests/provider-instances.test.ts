import request from 'supertest';
import { createServer } from '../src/server';
import { Router } from '../src/core/router';
import { QuotaManager } from '../src/core/quota-manager';
import { MemorySecretStore, apiKeyAccount, runtimeConfigAccount } from '../src/core/secret-store';
import { AzureOpenAIProvider } from '../src/providers/azure-openai';
import { Provider, CompletionRequest, CompletionResponse, StreamChunk } from '../src/core/types';
import { LEYLINE_CLIENT_AUTH_HEADER } from './client-auth-header';

class MockProvider implements Provider {
  name: string;
  defaultModel: string;

  constructor(name: string, defaultModel: string) {
    this.name = name;
    this.defaultModel = defaultModel;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async getModels() {
    return [{ id: this.defaultModel }];
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    return {
      id: 'mock',
      object: 'chat.completion',
      created: Date.now(),
      model: request.model,
      choices: [{ index: 0, message: { role: 'assistant', content: `Response from ${this.name}` }, finish_reason: 'stop' }],
    };
  }

  async *completeStream(): AsyncGenerator<StreamChunk, void, unknown> {}
}

function createApp(store = new MemorySecretStore()) {
  const quotaManager = new QuotaManager();
  const router = new Router({ quotaManager });
  router.addProvider(new AzureOpenAIProvider('', '', ''));
  const app = createServer(router, quotaManager, { apiKeyStore: store });
  return { app, router, store };
}

describe('/dashboard/provider-instances', () => {
  it('lists the Azure OpenAI family with its field spec', async () => {
    const { app } = createApp();

    const response = await request(app).get('/dashboard/provider-instances');

    expect(response.status).toBe(200);
    const azure = response.body.families.find((f: any) => f.family === 'AzureOpenAI');
    expect(azure).toMatchObject({ family: 'AzureOpenAI', baseName: 'AzureOpenAI', displayName: 'Azure OpenAI' });
    expect(azure.fields.map((f: any) => f.key)).toEqual(['endpoint', 'deployment', 'apiKey', 'apiVersion']);
    expect(azure.instances).toEqual([]);
  });

  it('creates a new named instance, registers it on the router, and persists its secrets', async () => {
    const { app, router, store } = createApp();

    const response = await request(app)
      .post('/dashboard/provider-instances')
      .send({
        family: 'AzureOpenAI',
        config: {
          endpoint: 'https://contoso.openai.azure.com',
          deployment: 'gpt-4o',
          apiKey: 'secret-key',
          apiVersion: '2024-10-21',
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.name).toMatch(/^AzureOpenAI:/);

    const provider = router.getProviders().find(p => p.name === response.body.name) as AzureOpenAIProvider;
    expect(provider).toBeDefined();
    expect(provider.hasApiKey()).toBe(true);
    expect(provider.getRuntimeConfig().baseUrl).toBe('https://contoso.openai.azure.com');
    expect(provider.getRuntimeConfig().model).toBe('gpt-4o');

    expect(await store.get(apiKeyAccount(response.body.name))).toBe('secret-key');
    expect(await store.get(runtimeConfigAccount(response.body.name))).toContain('gpt-4o');
  });

  it('allows creating an instance without a key — it is set afterward via /dashboard/api-keys', async () => {
    const { app, router } = createApp();

    const response = await request(app)
      .post('/dashboard/provider-instances')
      .send({ family: 'AzureOpenAI', config: { endpoint: 'https://contoso.openai.azure.com', deployment: 'gpt-4o' } });

    expect(response.status).toBe(200);
    const provider = router.getProviders().find(p => p.name === response.body.name) as AzureOpenAIProvider;
    expect(provider.hasApiKey()).toBe(false);

    const keySet = await request(app)
      .post('/dashboard/api-keys')
      .send({ provider: response.body.name, apiKey: 'set-later', persistence: 'memory' });

    expect(keySet.status).toBe(200);
    expect(provider.hasApiKey()).toBe(true);
  });

  it('rejects a create request missing a required field', async () => {
    const { app } = createApp();

    const response = await request(app)
      .post('/dashboard/provider-instances')
      .send({ family: 'AzureOpenAI', config: { endpoint: '', deployment: 'gpt-4o', apiKey: 'k' } });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('endpoint');
  });

  it('rejects an unknown family', async () => {
    const { app } = createApp();

    const response = await request(app)
      .post('/dashboard/provider-instances')
      .send({ family: 'Nope', config: {} });

    expect(response.status).toBe(404);
  });

  it('removes a named instance and its secrets, but refuses to remove the base instance', async () => {
    const { app, router, store } = createApp();

    const created = await request(app)
      .post('/dashboard/provider-instances')
      .send({
        family: 'AzureOpenAI',
        config: { endpoint: 'https://contoso.openai.azure.com', deployment: 'gpt-4o', apiKey: 'secret-key' },
      });
    const id = created.body.id;

    const removed = await request(app).delete(`/dashboard/provider-instances/AzureOpenAI/${id}`);
    expect(removed.status).toBe(200);
    expect(router.getProviders().some(p => p.name === `AzureOpenAI:${id}`)).toBe(false);
    expect(await store.get(apiKeyAccount(`AzureOpenAI:${id}`))).toBeUndefined();

    // The base (un-suffixed) instance's name is exactly "AzureOpenAI" — this route always composes
    // `${baseName}:${id}`, so there is no `id` that resolves to the base instance's real name.
    const removeBase = await request(app).delete('/dashboard/provider-instances/AzureOpenAI/AzureOpenAI');
    expect(removeBase.status).toBe(404);
    expect(router.getProviders().some(p => p.name === 'AzureOpenAI')).toBe(true);
  });

  it('survives a restart by reconstructing instances from the persisted manifest', async () => {
    const store = new MemorySecretStore();
    const first = createApp(store);
    const created = await request(first.app)
      .post('/dashboard/provider-instances')
      .send({
        family: 'AzureOpenAI',
        config: { endpoint: 'https://contoso.openai.azure.com', deployment: 'gpt-4o', apiKey: 'secret-key' },
      });

    const second = createApp(store);
    // Bootstrap (src/index.ts) is what normally reconstructs extra instances from the manifest
    // before startServer(); here we simulate that step directly against the fresh router.
    const { parseInstanceManifest, instanceManifestAccount } = await import('../src/core/secret-store');
    const manifestRaw = await store.get(instanceManifestAccount('AzureOpenAI'));
    for (const instance of manifestRaw ? parseInstanceManifest(manifestRaw) : []) {
      second.router.addProvider(AzureOpenAIProvider.forInstance({ id: instance.id, label: instance.label, ...instance.extra }));
    }

    const response = await request(second.app).get('/dashboard/provider-instances');
    const azure = response.body.families.find((f: any) => f.family === 'AzureOpenAI');
    expect(azure.instances).toEqual([{ id: created.body.id, name: created.body.name, label: created.body.label }]);
  });
});

describe('/v1/chat/completions X-Leyline-Force-Provider', () => {
  function createRoutingApp() {
    const quotaManager = new QuotaManager();
    const router = new Router({ quotaManager });
    router.addProvider(new MockProvider('AzureOpenAI', 'gpt-4o'));
    router.addProvider(new MockProvider('AzureOpenAI:prod-eastus', 'gpt-4o'));
    const app = createServer(router, quotaManager, { apiKeyStore: new MemorySecretStore() });
    return { app, router };
  }

  it('routes to the exact forced provider even when the model id is ambiguous', async () => {
    const { app } = createRoutingApp();

    const response = await request(app)
      .post('/v1/chat/completions')
      .set(LEYLINE_CLIENT_AUTH_HEADER)
      .set('X-Leyline-Force-Provider', 'AzureOpenAI:prod-eastus')
      .send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(200);
    expect(response.body.choices[0].message.content).toBe('Response from AzureOpenAI:prod-eastus');
  });

  it('returns a 400 for an unknown forced provider instead of a generic failure', async () => {
    const { app } = createRoutingApp();

    const response = await request(app)
      .post('/v1/chat/completions')
      .set(LEYLINE_CLIENT_AUTH_HEADER)
      .set('X-Leyline-Force-Provider', 'Nope')
      .send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('unknown_provider');
  });
});
