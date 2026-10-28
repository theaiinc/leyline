import request from 'supertest';
import { createServer } from '../src/server';
import { Router } from '../src/core/router';
import { QuotaManager } from '../src/core/quota-manager';
import { ModelRegistry } from '../src/core/model-registry';
import { IssuedKeys, MemoryDocStore, cleanSettings } from '../src/core/issued-keys';
import { MemorySecretStore } from '../src/core/secret-store';
import { providersOverBudget, type HostedOptions } from '../src/core/hosted';
import { costUsd } from '../src/core/issued-keys';
import type { CompletionRequest, CompletionResponse, Provider, StreamChunk } from '../src/core/types';

describe('cached token pricing', () => {
  it('uses the default 10% cached-input rate', () => {
    expect(costUsd({ input: 2, output: 8 }, { prompt_tokens: 1_000_000, completion_tokens: 0, cached_tokens: 500_000 })).toBe(1.1);
  });

  it('uses an explicit cached-input rate', () => {
    expect(costUsd({ input: 2, output: 8, cachedInput: 0.25 }, { prompt_tokens: 1_000_000, completion_tokens: 0, cached_tokens: 500_000 })).toBe(1.125);
  });

  it('prices Anthropic cache creation at 1.25 times input', () => {
    expect(costUsd({ input: 2, output: 8 }, {
      prompt_tokens: 1_000_000,
      completion_tokens: 0,
      cache_creation_input_tokens: 500_000,
    })).toBe(3.25);
  });

  it('prices usage without cache fields as before', () => {
    expect(costUsd({ input: 2, output: 8 }, { prompt_tokens: 1_000_000, completion_tokens: 0 })).toBe(2);
  });
});

/** A provider serving `models`, with a price list like a gateway's (or none, like Anthropic). */
class Fake implements Provider {
  served = 0;
  constructor(public name: string, private models: string[], private price?: { input: number; output: number }) {}
  defaultModel = 'm';
  async isAvailable() { return true; }
  async getModels() { return this.models.map(id => ({ id, ...(this.price ? { pricing: this.price } : {}) })); }
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.served++;
    return {
      id: 'c', object: 'chat.completion', created: 1, model: req.model,
      choices: [{ index: 0, message: { role: 'assistant', content: `from ${this.name}` }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 },
    };
  }
  async *completeStream(): AsyncGenerator<StreamChunk> { /* not used */ }
}

async function setup(over: Partial<HostedOptions> = {}) {
  const quotaManager = new QuotaManager();
  const router = new Router({ quotaManager, modelRegistry: new ModelRegistry() });
  const anthropic = new Fake('Anthropic', ['claude-x']);
  const gateway = new Fake('LLM API', ['claude-x'], { input: 2, output: 8 });
  const onlyAnthropic = new Fake('Anthropic', ['claude-only']);
  router.addProvider(anthropic);
  router.addProvider(gateway);
  await router.reindexAll();
  const keys = new IssuedKeys(new MemoryDocStore());
  const hosted: HostedOptions = {
    keys, models: [], aliases: {}, login: null, adminEmails: [], adminToken: 'admin-secret-token', publicUrl: 'https://leyline.test', ...over,
  };
  const app = createServer(router, quotaManager, { hosted, enforceExternalSurface: false, apiKeyStore: new MemorySecretStore() });
  const { key } = await keys.create({ name: 'k', by: 'test' });
  return { app, keys, hosted, router, anthropic, gateway, onlyAnthropic, key };
}

const chat = (app: any, key: string, model = 'claude-x') =>
  request(app).post('/v1/chat/completions').set('Authorization', `Bearer ${key}`).send({ model, messages: [{ role: 'user', content: 'hi' }] });

describe('cached usage pricing', () => {
  it('prices cached input at the default 10 percent, an explicit cachedInput rate, and Anthropic cache creation at 1.25x', () => {
    expect(costUsd({ input: 10, output: 40 }, { prompt_tokens: 100, cached_tokens: 50, completion_tokens: 0 })).toBeCloseTo(0.00055);
    expect(costUsd({ input: 10, output: 40, cachedInput: 2 }, { prompt_tokens: 100, cached_tokens: 50, completion_tokens: 0 })).toBeCloseTo(0.0006);
    expect(costUsd({ input: 10, output: 40 }, { prompt_tokens: 100, cache_creation_input_tokens: 50, completion_tokens: 0 })).toBeCloseTo(0.001125);
  });

  it('keeps pricing unchanged when a response has no cache fields', () => {
    expect(costUsd({ input: 10, output: 40 }, { prompt_tokens: 100, completion_tokens: 20 })).toBeCloseTo(0.0018);
  });
});

describe('per-provider monthly limits', () => {
  it('keeps only positive limits by name, rounded to cents', () => {
    expect(cleanSettings({ providerBudgetsUsd: { Anthropic: 100.004, ' ': 5, Zero: 0, Bad: 'x' as never } } as never).providerBudgetsUsd).toEqual({ Anthropic: 100 });
  });

  it('prices a provider that publishes no prices at another provider\'s published price for the same model', async () => {
    const { router } = await setup();
    expect(router.publishedPrice('Anthropic', 'claude-x')).toBeUndefined();
    expect(router.anyPublishedPrice('claude-x')).toEqual({ input: 2, output: 8 });
  });

  it('sends a model to another provider once the first reaches its limit', async () => {
    const { app, key, anthropic, gateway, hosted, keys } = await setup({ providerBudgetsUsd: { Anthropic: 1 } });
    // Under the limit: Anthropic (first in order) answers; 1M input tokens at $2/M is $2 on Anthropic's line.
    expect((await chat(app, key)).body.choices[0].message.content).toBe('from Anthropic');
    expect((await keys.spend()).byProvider?.Anthropic?.usd).toBe(2);
    expect(await providersOverBudget(hosted, Date.now() + 60_000)).toEqual(['Anthropic']);
    const next = await chat(app, key);
    expect(next.body.choices[0].message.content).toBe('from LLM API');
    expect(anthropic.served).toBe(1);
    expect(gateway.served).toBe(1);
  });

  it('refuses with 429, naming the provider, when no other provider serves the model', async () => {
    const quotaManager = new QuotaManager();
    const router = new Router({ quotaManager, modelRegistry: new ModelRegistry() });
    router.addProvider(new Fake('Anthropic', ['claude-only']));
    await router.reindexAll();
    await expect(router.route({ model: 'claude-only', messages: [{ role: 'user', content: 'hi' }] }, { excludeProviders: ['Anthropic'] }))
      .rejects.toMatchObject({ status: 429, code: 'provider_budget_exhausted', message: expect.stringContaining('Anthropic reached its spending limit') });
    const keys = new IssuedKeys(new MemoryDocStore());
    const hosted: HostedOptions = { keys, models: [], aliases: {}, login: null, adminEmails: [], publicUrl: 'https://l.test', providerBudgetsUsd: { Anthropic: 0.01 } };
    await keys.record(null, 'claude-only', { prompt_tokens: 10, completion_tokens: 0 }, 5, { provider: 'Anthropic', model: 'claude-only' });
    const app = createServer(router, quotaManager, { hosted, enforceExternalSurface: false, apiKeyStore: new MemorySecretStore() });
    const { key } = await keys.create({ name: 'k', by: 'test' });
    const res = await chat(app, key, 'claude-only');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('provider_budget_exhausted');
  });

  it('is set on the dashboard settings and shown back', async () => {
    const { app } = await setup();
    const saved = await request(app).put('/admin/api/settings').set({ Authorization: 'Bearer admin-secret-token' }).send({ providerBudgetsUsd: { Anthropic: 100 } });
    expect(saved.body.providerBudgetsUsd).toEqual({ Anthropic: 100 });
    expect((await request(app).get('/admin/api/settings').set({ Authorization: 'Bearer admin-secret-token' })).body.providerBudgetsUsd).toEqual({ Anthropic: 100 });
  });

  it('re-arms budget alerts when the monthly limit changes', async () => {
    const { keys } = await setup();
    const { CostAlerts } = await import('../src/core/alerts');
    const alerts = new CostAlerts(new MemoryDocStore(), keys, () => Date.parse('2026-10-20T12:00:00Z'));
    const channels = {} as never;
    const settings = { thresholds: [80, 100], keyThresholds: [], emails: [], webhookUrl: null, email: false };
    await keys.record(null, 'm', { prompt_tokens: 1, completion_tokens: 0 }, 50, { provider: 'Anthropic', model: 'm' });
    expect((await alerts.check(settings, 50, null, { to: [], publicUrl: 'https://leyline.test' }, channels)).map(a => a.threshold)).toEqual([100]);
    expect((await alerts.check(settings, 100, null, { to: [], publicUrl: 'https://leyline.test' }, channels)).map(a => a.threshold)).toEqual([]);
    await keys.record(null, 'm', { prompt_tokens: 1, completion_tokens: 0 }, 30, { provider: 'Anthropic', model: 'm' });
    expect((await alerts.check(settings, 100, null, { to: [], publicUrl: 'https://leyline.test' }, channels)).map(a => a.threshold)).toEqual([80]);
  });
});
