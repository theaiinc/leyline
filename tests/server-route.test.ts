import request from 'supertest';
import { createServer } from '../src/server';
import { Router } from '../src/core/router';
import { QuotaManager } from '../src/core/quota-manager';
import { ModelRegistry } from '../src/core/model-registry';
import type { ModelVariant } from '../src/core/types';
import { LEYLINE_CLIENT_AUTH_HEADER } from './client-auth-header';
import { config } from '../src/config';

const TEST_VARIANTS: ModelVariant[] = [
  {
    id: 'mid-model',
    name: 'Mid 4B',
    family: 'test',
    provider: 'openai',
    source: 'lmstudio',
    parameter_size_b: 4,
    quantization: 'Q4',
    context_length: 16384,
    capabilities: { tools: true, thinking: false, vision: false, code: true, embedding: false },
    billing_class: 'free_local',
    resource_class: 'standard',
  },
];

function createFixedModelApp(options: {
  provider?: string;
  model: string;
  tierModels?: Record<string, string | undefined>;
}) {
  const quotaManager = new QuotaManager();
  const router = new Router({
    quotaManager,
    modelRegistry: new ModelRegistry(),
    tierConfig: options.tierModels,
    singleModel: {
      enabled: true,
      provider: options.provider,
      model: options.model,
    },
  });

  return createServer(router, quotaManager);
}

describe('POST /v1/route', () => {
  it('returns 400 when user_message is missing', async () => {
    const app = createFixedModelApp({ provider: 'OpenAI', model: 'gpt-5.5' });

    const response = await request(app).post('/v1/route').set(LEYLINE_CLIENT_AUTH_HEADER).send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('user_message is required');
  });

  it('returns fixed routing in single-model mode', async () => {
    const app = createFixedModelApp({ provider: 'AzureOpenAI', model: 'gpt-5.5' });

    const response = await request(app)
      .post('/v1/route')
      .set(LEYLINE_CLIENT_AUTH_HEADER)
      .send({ user_message: 'hello', chat_history: [{ role: 'user', content: 'prior' }] });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      classification: null,
      selectedTier: 'fixed',
      selectedModel: 'gpt-5.5',
      selectedProvider: 'AzureOpenAI',
    });
  });

  it('accepts the default Leyline client API key', async () => {
    const app = createFixedModelApp({ provider: 'AzureOpenAI', model: 'gpt-5.5' });

    const response = await request(app)
      .post('/v1/route')
      .set(LEYLINE_CLIENT_AUTH_HEADER)
      .send({ user_message: 'hello' });

    expect(response.status).toBe(200);
    expect(response.body.selectedProvider).toBe('AzureOpenAI');
  });

  it('rejects requests without the Leyline client API key', async () => {
    const app = createFixedModelApp({ provider: 'AzureOpenAI', model: 'gpt-5.5' });

    const response = await request(app)
      .post('/v1/route')
      .send({ user_message: 'hello' });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('invalid_api_key');
  });

  it('rejects requests with an incorrect client API key', async () => {
    const app = createFixedModelApp({ provider: 'AzureOpenAI', model: 'gpt-5.5' });

    const response = await request(app)
      .post('/v1/route')
      .set('Authorization', 'Bearer wrong-key')
      .send({ user_message: 'hello' });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe('Incorrect API key provided');
  });

  it('uses tier defaults when classifier is not configured', async () => {
    const quotaManager = new QuotaManager();
    const registry = new ModelRegistry(TEST_VARIANTS);
    const router = new Router({
      quotaManager,
      modelRegistry: registry,
      tierConfig: { '4b': 'mid-model' },
    });
    const app = createServer(router, quotaManager);

    const response = await request(app)
      .post('/v1/route')
      .set(LEYLINE_CLIENT_AUTH_HEADER)
      .send({ user_message: 'hello' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      classification: null,
      selectedTier: '4b',
      selectedModel: 'mid-model',
      selectedProvider: 'openai',
    });
  });

  it('advertises only free-tier models that are offered with published prices', async () => {
    const quotaManager = new QuotaManager();
    const router = new Router({ quotaManager, modelRegistry: new ModelRegistry() });
    const verifiedModels = [
      'seed-2-0-lite-260428',
      'seed-2-0-mini-260428',
      'deepseek-v4-1-flash-261017',
      'deepseek-v4-flash-ga-260731',
      'glm-5-3-flash-260828',
    ];
    router.addProvider({
      name: 'BytePlus',
      defaultModel: verifiedModels[0],
      getModels: async () => verifiedModels.map((id) => ({
        id,
        name: id,
        pricing: { input: 0.2, output: 1.2 },
      })),
      isAvailable: async () => true,
      complete: async () => { throw new Error('not used'); },
      completeStream: async function* () { throw new Error('not used'); },
    });
    await router.reindexProvider(router.getProviders()[0]);
    // The pricing endpoint reads the provider's live model list directly.

    const previousFreeTierModels = config.freeTierModels;
    config.freeTierModels = verifiedModels;
    try {
      const app = createServer(router, quotaManager);
      const response = await request(app).get('/v1/pricing');

    expect(response.status).toBe(200);
    expect(response.body.free_tier.models).toEqual(verifiedModels);
    const offered = new Map<string, { id: string; input: number; output: number }>(
      response.body.models.map((model: { id: string; input: number; output: number }) => [model.id, model]),
    );
    expect(response.body.free_tier.models.length).toBeGreaterThan(0);
    for (const id of response.body.free_tier.models) {
      const model = offered.get(id);
      expect(model).toBeDefined();
      if (!model) continue;
      expect(Number.isFinite(model.input)).toBe(true);
      expect(Number.isFinite(model.output)).toBe(true);
    }
      expect(response.body.models).toHaveLength(verifiedModels.length);
    } finally {
      config.freeTierModels = previousFreeTierModels;
    }
  });
});
