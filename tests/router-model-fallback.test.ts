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
