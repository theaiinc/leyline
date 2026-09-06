import { Router } from '../src/core/router';
import { QuotaManager } from '../src/core/quota-manager';
import { Provider, CompletionRequest, CompletionResponse, StreamChunk, ModelDetail } from '../src/core/types';

class MockProvider implements Provider {
  name: string;
  defaultModel: string;
  models: string[];
  available = true;

  constructor(name: string, defaultModel: string, models: string[]) {
    this.name = name;
    this.defaultModel = defaultModel;
    this.models = models;
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async getModels(): Promise<ModelDetail[]> {
    return this.models.map(id => ({ id }));
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

  async *completeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
    yield {
      id: 'mock',
      object: 'chat.completion.chunk',
      created: Date.now(),
      model: request.model,
      choices: [{ index: 0, delta: { content: `Response from ${this.name}` }, finish_reason: null }],
    };
  }
}

describe('Router multi-instance support', () => {
  let router: Router;
  let azureDefault: MockProvider;
  let azureProd: MockProvider;

  beforeEach(() => {
    router = new Router({ quotaManager: new QuotaManager() });
    azureDefault = new MockProvider('AzureOpenAI', 'gpt-4o', ['gpt-4o']);
    azureProd = new MockProvider('AzureOpenAI:prod-eastus', 'gpt-4o', ['gpt-4o']);
    router.addProvider(azureDefault);
    router.addProvider(azureProd);
  });

  describe('removeProvider', () => {
    it('unregisters a provider by exact name', () => {
      expect(router.removeProvider('AzureOpenAI:prod-eastus')).toBe(true);
      expect(router.getProviders().map(p => p.name)).toEqual(['AzureOpenAI']);
    });

    it('returns false for an unknown name', () => {
      expect(router.removeProvider('does-not-exist')).toBe(false);
      expect(router.getProviders()).toHaveLength(2);
    });

    it('drops any model pin pointing at the removed provider', async () => {
      await router.reindexAll();
      router.setModelPins({ 'gpt-4o': 'AzureOpenAI:prod-eastus' });
      router.removeProvider('AzureOpenAI:prod-eastus');
      expect(router.getModelPins()).toEqual({});
    });
  });

  describe('reindexAll / getModelIndex', () => {
    it('builds a model id -> provider names index eagerly', async () => {
      await router.reindexAll();
      expect(router.getModelIndex()).toEqual({ 'gpt-4o': ['AzureOpenAI', 'AzureOpenAI:prod-eastus'] });
    });

    it('reindexProvider refreshes just one provider', async () => {
      await router.reindexAll();
      azureProd.models = ['gpt-4o', 'gpt-4o-mini'];
      await router.reindexProvider(azureProd);
      expect(router.getModelIndex()['gpt-4o-mini']).toEqual(['AzureOpenAI:prod-eastus']);
    });
  });

  describe('model pins', () => {
    it('moves the pinned provider to the front when a model is ambiguous', async () => {
      await router.reindexAll();
      router.setModelPins({ 'gpt-4o': 'AzureOpenAI:prod-eastus' });
      const response = await router.route({ model: 'gpt-4o', messages: [] });
      expect(response.choices[0].message.content).toBe('Response from AzureOpenAI:prod-eastus');
    });

    it('keeps priority order when no pin is set', async () => {
      await router.reindexAll();
      const response = await router.route({ model: 'gpt-4o', messages: [] });
      expect(response.choices[0].message.content).toBe('Response from AzureOpenAI');
    });

    it('ignores a pin that does not match any candidate', async () => {
      await router.reindexAll();
      router.setModelPins({ 'gpt-4o': 'SomeOtherProvider' });
      const response = await router.route({ model: 'gpt-4o', messages: [] });
      expect(response.choices[0].message.content).toBe('Response from AzureOpenAI');
    });
  });

  describe('forceProvider (RouteOptions)', () => {
    it('routes to the exact named provider, bypassing candidate selection', async () => {
      const response = await router.route({ model: 'gpt-4o', messages: [] }, { forceProvider: 'AzureOpenAI:prod-eastus' });
      expect(response.choices[0].message.content).toBe('Response from AzureOpenAI:prod-eastus');
    });

    it('throws a clear error when the forced provider is not registered', async () => {
      await expect(router.route({ model: 'gpt-4o', messages: [] }, { forceProvider: 'Nope' }))
        .rejects.toThrow('Provider "Nope" is not registered.');
    });

    it('throws when the forced provider reports unavailable', async () => {
      azureProd.available = false;
      await expect(router.route({ model: 'gpt-4o', messages: [] }, { forceProvider: 'AzureOpenAI:prod-eastus' }))
        .rejects.toThrow(/unavailable/);
    });

    it('supports forceProvider for streamed requests', async () => {
      const chunks: StreamChunk[] = [];
      for await (const chunk of router.routeStream({ model: 'gpt-4o', messages: [] }, { forceProvider: 'AzureOpenAI:prod-eastus' })) {
        chunks.push(chunk);
      }
      expect(chunks[0].choices[0].delta.content).toBe('Response from AzureOpenAI:prod-eastus');
    });
  });
});
