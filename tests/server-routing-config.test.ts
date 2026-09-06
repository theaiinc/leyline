import request from 'supertest';
import { createServer } from '../src/server';
import { Router } from '../src/core/router';
import { QuotaManager } from '../src/core/quota-manager';
import { MemorySecretStore, ROUTING_CONFIG_ACCOUNT, serializeRoutingConfig } from '../src/core/secret-store';
import { Provider, CompletionRequest, CompletionResponse, StreamChunk, ModelDetail } from '../src/core/types';

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

  async getModels(): Promise<ModelDetail[]> {
    return [{ id: this.defaultModel }];
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    return {
      id: 'mock',
      object: 'chat.completion',
      created: Date.now(),
      model: request.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    };
  }

  async *completeStream(_request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
    // not exercised in these tests
  }
}

function createApp(store = new MemorySecretStore()) {
  const quotaManager = new QuotaManager();
  const router = new Router({ quotaManager });
  router.addProvider(new MockProvider('OpenAI', 'gpt-5.5'));
  router.addProvider(new MockProvider('Ollama', 'llama2'));
  const app = createServer(router, quotaManager, { apiKeyStore: store });
  return { app, router, store };
}

describe('/dashboard/routing', () => {
  it('returns auto mode with an empty pool by default', async () => {
    const { app } = createApp();

    const response = await request(app).get('/dashboard/routing');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      singleModelEnabled: false,
      fixedProvider: null,
      fixedModel: null,
      enabledModels: {},
      modelPins: {},
      modelIndex: { 'gpt-5.5': ['OpenAI'], llama2: ['Ollama'] },
    });
  });

  it('updates the enabled model pool and applies it to the router', async () => {
    const { app, router } = createApp();

    const response = await request(app)
      .post('/dashboard/routing')
      .send({ enabledModels: { OpenAI: ['gpt-5.5'] } });

    expect(response.status).toBe(200);
    expect(response.body.enabledModels).toEqual({ OpenAI: ['gpt-5.5'] });
    expect(router.getEnabledModels()).toEqual({ OpenAI: ['gpt-5.5'] });
  });

  it('pins and unpins the router', async () => {
    const { app, router } = createApp();

    const pin = await request(app)
      .post('/dashboard/routing')
      .send({ mode: 'pinned', pinnedProvider: 'Ollama', pinnedModel: 'llama2' });

    expect(pin.status).toBe(200);
    expect(pin.body.singleModelEnabled).toBe(true);
    expect(pin.body.fixedProvider).toBe('Ollama');
    expect(router.getSingleModel()?.enabled).toBe(true);

    const unpin = await request(app).post('/dashboard/routing').send({ mode: 'auto' });

    expect(unpin.status).toBe(200);
    expect(unpin.body.singleModelEnabled).toBe(false);
    expect(router.getSingleModel()).toBeUndefined();
  });

  it('rejects pinning without a model', async () => {
    const { app } = createApp();

    const response = await request(app).post('/dashboard/routing').send({ mode: 'pinned' });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('pinnedModel');
  });

  it('rejects unknown providers in the pool', async () => {
    const { app } = createApp();

    const response = await request(app)
      .post('/dashboard/routing')
      .send({ enabledModels: { Nope: ['some-model'] } });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Nope');
  });

  it('persists routing config and restores it on the next server', async () => {
    const store = new MemorySecretStore();
    const first = createApp(store);

    await request(first.app)
      .post('/dashboard/routing')
      .send({ mode: 'pinned', pinnedProvider: 'OpenAI', pinnedModel: 'gpt-5.5', enabledModels: { OpenAI: ['gpt-5.5'] } });

    const second = createApp(store);
    const response = await request(second.app).get('/dashboard/routing');

    expect(response.body).toEqual({
      singleModelEnabled: true,
      fixedProvider: 'OpenAI',
      fixedModel: 'gpt-5.5',
      enabledModels: { OpenAI: ['gpt-5.5'] },
      modelPins: {},
      modelIndex: { 'gpt-5.5': ['OpenAI'], llama2: ['Ollama'] },
    });
  });

  it('loads a pre-seeded persisted config at startup', async () => {
    const store = new MemorySecretStore();
    await store.set(ROUTING_CONFIG_ACCOUNT, serializeRoutingConfig({
      mode: 'auto',
      enabledModels: { Ollama: ['llama2'] },
    }));

    const { app, router } = createApp(store);
    const response = await request(app).get('/dashboard/routing');

    expect(response.status).toBe(200);
    expect(response.body.enabledModels).toEqual({ Ollama: ['llama2'] });
    expect(router.getEnabledModels()).toEqual({ Ollama: ['llama2'] });
  });
});
