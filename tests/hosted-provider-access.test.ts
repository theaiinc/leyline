import request from 'supertest';
import { Router } from '../src/core/router';
import { ModelRegistry } from '../src/core/model-registry';
import { QuotaManager } from '../src/core/quota-manager';
import { MemoryDocStore } from '../src/core/issued-keys';
import { MemorySecretStore } from '../src/core/secret-store';
import { IssuedKeys } from '../src/core/issued-keys';
import { createServer } from '../src/server';
import type { Provider } from '../src/core/types';
import type { CompletionRequest, CompletionResponse, StreamChunk } from '../src/core/types';
import type { HostedOptions } from '../src/core/hosted';

class TestProvider implements Provider {
  name = 'Test';
  defaultModel = 'test-model';

  async isAvailable() { return true; }
  async getModels() { return [{ id: this.defaultModel }]; }
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    return {
      id: 'test-completion',
      object: 'chat.completion',
      created: 1,
      model: req.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }
  async *completeStream(req: CompletionRequest): AsyncGenerator<StreamChunk> {
    yield {
      id: 'test-stream',
      object: 'chat.completion.chunk',
      created: 1,
      model: req.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    };
  }
}

function setupHosted() {
  const quotaManager = new QuotaManager();
  const router = new Router({ quotaManager, modelRegistry: new ModelRegistry() });
  router.addProvider(new TestProvider());
  const keys = new IssuedKeys(new MemoryDocStore());
  const hosted: HostedOptions = {
    keys,
    models: ['test-model'],
    aliases: {},
    login: null,
    adminEmails: [],
    adminToken: 'admin-secret-token',
    publicUrl: 'https://hosted.example',
    ...({} as Partial<HostedOptions>),
  };
  const app = createServer(router, quotaManager, {
    hosted,
    enforceExternalSurface: false,
    apiKeyStore: new MemorySecretStore(),
  });
  return { app };
}

const ADMIN = { Authorization: 'Bearer admin-secret-token' };

describe('hosted provider access', () => {
  it('does not expose provider key fields to a customer', async () => {
    const { app } = setupHosted();
    const response = await request(app).get('/dashboard/api/providers');
    expect(response.status).not.toBe(500);
    expect(JSON.stringify(response.body)).not.toMatch(/apiKey|api_key|secret|password/i);
  });

  it('rejects provider configuration writes for a customer', async () => {
    const { app } = setupHosted();
    for (const [method, path] of [
      ['post', '/dashboard/api/providers'],
      ['put', '/dashboard/api/providers/test'],
      ['patch', '/dashboard/api/providers/test'],
      ['delete', '/dashboard/api/providers/test'],
    ] as const) {
      const response = await request(app)[method](path).set({ Authorization: 'Bearer customer-key' }).send({ name: 'changed', apiKey: 'secret' });
      expect(response.status).toBe(401);
    }
  });

  it('continues to allow the admin token', async () => {
    const { app } = setupHosted();
    const response = await request(app).get('/admin/api/settings').set(ADMIN);
    expect(response.status).toBe(200);
  });
});
