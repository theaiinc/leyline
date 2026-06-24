import request from 'supertest';
import { createServer } from '../src/server';
import { Router } from '../src/core/router';
import { QuotaManager } from '../src/core/quota-manager';
import { ModelRegistry } from '../src/core/model-registry';
import type { ModelVariant } from '../src/core/types';
import { LEYLINE_CLIENT_AUTH_HEADER } from './client-auth-header';

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
});
