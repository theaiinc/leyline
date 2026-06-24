import axios from 'axios';
import request from 'supertest';
import { createServer } from '../src/server';
import { Router } from '../src/core/router';
import { QuotaManager } from '../src/core/quota-manager';
import { logger } from '../src/core/logger';
import { AzureOpenAIProvider } from '../src/providers/azure-openai';
import { SecretStore, SecretStoreStatus } from '../src/core/secret-store';
import { LEYLINE_CLIENT_AUTH_HEADER } from './client-auth-header';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

class TestSecretStore implements SecretStore {
  values = new Map<string, string>();

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
    this.values.delete(account);
  }

  status(): SecretStoreStatus {
    return this.storeStatus;
  }
}

function createAzureApp(provider: AzureOpenAIProvider) {
  const quotaManager = new QuotaManager();
  const router = new Router({
    quotaManager,
    singleModel: { enabled: true, provider: 'AzureOpenAI', model: 'gpt-5.5' },
  });
  router.addProvider(provider);

  return createServer(router, quotaManager, { apiKeyStore: new TestSecretStore() });
}

describe('AzureOpenAI dashboard logging', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    logger.clear();
  });

  it('logs successful AzureOpenAI requests after browser localStorage key rehydration', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        id: 'azure-success',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-5.5',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      },
    });
    const provider = new AzureOpenAIProvider(
      '',
      'https://example.services.ai.azure.com/openai/v1',
      'gpt-5.5',
    );
    const app = createAzureApp(provider);

    await request(app)
      .post('/dashboard/api-keys')
      .send({ provider: 'AzureOpenAI', apiKey: 'browser-key', persistence: 'localStorage' })
      .expect(200);
    await request(app)
      .post('/v1/chat/completions')
      .set(LEYLINE_CLIENT_AUTH_HEADER)
      .send({ model: 'auto', messages: [{ role: 'user', content: 'hello' }] })
      .expect(200);

    const response = await request(app).get('/dashboard/stats').expect(200);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://example.services.ai.azure.com/openai/v1/chat/completions',
      {
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer browser-key',
        }),
      }),
    );
    expect(response.body.providers[0]).toMatchObject({
      name: 'AzureOpenAI',
      apiKeyConfigured: true,
      apiKeyStatus: { configured: true, source: 'localStorage' },
    });
    expect(response.body.logs[0]).toMatchObject({
      provider: 'AzureOpenAI',
      model: 'gpt-5.5',
      status: 'success',
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    });
  });

  it('logs unavailable AzureOpenAI attempts when required configuration is missing', async () => {
    const app = createAzureApp(new AzureOpenAIProvider('', '', 'gpt-5.5'));

    await request(app)
      .post('/v1/chat/completions')
      .set(LEYLINE_CLIENT_AUTH_HEADER)
      .send({ model: 'auto', messages: [{ role: 'user', content: 'hello' }] })
      .expect(503);

    const response = await request(app).get('/dashboard/stats').expect(200);

    expect(response.body.logs).toHaveLength(1);
    expect(response.body.logs[0]).toMatchObject({
      provider: 'AzureOpenAI',
      model: 'gpt-5.5',
      status: 'error',
      error: 'Fixed provider AzureOpenAI reported unavailable.',
    });
  });

  it('logs AzureOpenAI auth failures with provider, model, status, and error', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('Request failed with status code 401'));
    const app = createAzureApp(new AzureOpenAIProvider(
      'test-key',
      'https://example.services.ai.azure.com/openai/v1',
      'gpt-5.5',
    ));

    await request(app)
      .post('/v1/chat/completions')
      .set(LEYLINE_CLIENT_AUTH_HEADER)
      .send({ model: 'auto', messages: [{ role: 'user', content: 'hello' }] })
      .expect(503);

    const response = await request(app).get('/dashboard/stats').expect(200);

    expect(response.body.logs).toHaveLength(1);
    expect(response.body.logs[0]).toMatchObject({
      provider: 'AzureOpenAI',
      model: 'gpt-5.5',
      status: 'error',
      error: 'Request failed with status code 401',
    });
  });
});
