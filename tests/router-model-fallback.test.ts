import { Router } from '../src/core/router';
import { QuotaManager } from '../src/core/quota-manager';
import { ModelRegistry } from '../src/core/model-registry';
import type { CompletionRequest, CompletionResponse, Provider, StreamChunk } from '../src/core/types';

/** A provider that lists some models and either answers or fails. */
function provider(name: string, models: string[], fails = false): Provider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name,
    defaultModel: models[0] ?? 'x',
    calls,
    async isAvailable() { return true; },
    async getModels() { return models.map((id) => ({ id })); },
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      calls.push(req.model);
      if (fails) throw new Error(`${name} failed`);
      return { id: '1', object: 'chat.completion', created: 1, model: req.model, choices: [{ index: 0, message: { role: 'assistant', content: name }, finish_reason: 'stop' }] };
    },
    async *completeStream(req: CompletionRequest): AsyncGenerator<StreamChunk> {
      calls.push(req.model);
      if (fails) throw new Error(`${name} failed`);
      yield { id: '1', object: 'chat.completion.chunk', created: 1, model: req.model, choices: [{ index: 0, delta: { content: name }, finish_reason: 'stop' }] };
    },
  } as Provider & { calls: string[] };
}

describe('a named model is only sent to providers that serve it', () => {
  const setup = () => {
    const quotaManager = new QuotaManager();
    const router = new Router({ quotaManager, modelRegistry: new ModelRegistry() });
    const gateway = provider('Gateway', ['claude-sonnet-5-5'], true); // serves it, but fails
    const azure = provider('Azure', ['gpt-5.6-luna']); // would answer anything with its own deployment
    router.addProvider(gateway);
    router.addProvider(azure);
    return { router, gateway, azure };
  };

  it('does not fall through to a provider that does not list the model', async () => {
    const { router, gateway, azure } = setup();
    await expect(router.route({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
    expect(gateway.calls).toEqual(['claude-sonnet-5-5']);
    expect(azure.calls).toEqual([]);
  });

  it('streaming too', async () => {
    const { router, azure } = setup();
    const run = async () => { for await (const _ of router.routeStream({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] })) { /* none */ } };
    await expect(run()).rejects.toThrow();
    expect(azure.calls).toEqual([]);
  });

  it('a model nobody lists still tries every provider, as before', async () => {
    const { router, azure } = setup();
    const res = await router.route({ model: 'some-deployment', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.choices[0].message.content).toBe('Azure');
    expect(azure.calls).toEqual(['some-deployment']);
  });
});

describe('auto unavailable-model circuit breaker', () => {
  function setup(fails = true) {
    const calls: string[] = [];
    const router = new Router({ quotaManager: new QuotaManager(), modelRegistry: new ModelRegistry() });
    const modelProvider: Provider = {
      name: 'OpenRouter',
      defaultModel: 'stealth/ox-alpha',
      async isAvailable() { return true; },
      async getModels() { return [{ id: 'stealth/ox-alpha' }]; },
      async complete(req) {
        calls.push(req.model);
        if (fails) throw new Error('OpenRouter reported unavailable');
        return { id: 'ok', object: 'chat.completion', created: 1, model: req.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] };
      },
      async *completeStream() { yield* []; },
    };
    router.addProvider(modelProvider);
    return { router, calls, setFails(value: boolean) { fails = value; } };
  }

  const request = { model: 'auto', messages: [{ role: 'user' as const, content: 'hi' }] };

  it('opens after three unavailable failures and skips during cooldown', async () => {
    const { router, calls } = setup();
    await expect(router.route(request)).rejects.toThrow();
    await expect(router.route(request)).rejects.toThrow();
    await expect(router.route(request)).rejects.toThrow();
    await expect(router.route(request)).rejects.toThrow();
    expect(calls).toHaveLength(3);
    expect(router.autoCircuitBreakers()).toEqual([expect.objectContaining({ provider: 'OpenRouter', model: 'stealth/ox-alpha', error: 'OpenRouter reported unavailable' })]);
  });

  it('probes after cooldown and closes on success', async () => {
    const { router, calls, setFails } = setup();
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      for (let i = 0; i < 3; i += 1) await expect(router.route(request)).rejects.toThrow();
      expect(calls).toHaveLength(3);
      now.mockReturnValue(1_000_000 + 15 * 60 * 1000);
      setFails(false);
      await expect(router.route(request)).resolves.toMatchObject({ choices: [{ message: { content: 'ok' } }] });
      expect(calls).toHaveLength(4);
      expect(router.autoCircuitBreakers()).toEqual([]);
    } finally {
      now.mockRestore();
    }
  });

  it('does not circuit-break explicit requests', async () => {
    const { router, calls } = setup();
    for (let i = 0; i < 3; i += 1) await expect(router.route(request)).rejects.toThrow();
    await expect(router.route({ ...request, model: 'stealth/ox-alpha' })).rejects.toThrow('OpenRouter reported unavailable');
    expect(calls).toHaveLength(4);
  });
});
