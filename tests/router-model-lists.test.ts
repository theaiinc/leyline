import { Router } from '../src/core/router';
import { QuotaManager } from '../src/core/quota-manager';
import { Provider, CompletionRequest, CompletionResponse, StreamChunk, ModelDetail } from '../src/core/types';

class ListingProvider implements Provider {
  listings = 0;
  constructor(public name: string, public defaultModel: string, private readonly models: string[]) {}
  async isAvailable() { return true; }
  async getModels(): Promise<ModelDetail[]> { this.listings++; return this.models.map((id) => ({ id })); }
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    return { id: 'x', object: 'chat.completion', created: 0, model: request.model, choices: [{ index: 0, message: { role: 'assistant', content: this.name }, finish_reason: 'stop' }] };
  }
  async *completeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
    yield { id: 'x', object: 'chat.completion.chunk', created: 0, model: request.model, choices: [{ index: 0, delta: { content: this.name }, finish_reason: null }] };
  }
}

function setup() {
  const a = new ListingProvider('A', 'a-1', ['a-1']);
  const b = new ListingProvider('B', 'gemini-x', ['gemini-x']);
  const router = new Router({ quotaManager: new QuotaManager() });
  router.addProvider(a);
  router.addProvider(b);
  return { router, a, b };
}

describe('shared model lists', () => {
  it("lets a fresh instance route a named model with another instance's lists, without listing anything", async () => {
    const first = setup();
    await first.router.reindexAll();
    const snapshot = JSON.parse(JSON.stringify(first.router.exportModelLists()));

    const fresh = setup();
    fresh.router.importModelLists(snapshot);
    await fresh.router.reindexStale();
    const res = await fresh.router.route({ model: 'gemini-x', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.choices[0]!.message.content).toBe('B');
    expect(fresh.a.listings + fresh.b.listings).toBe(0);
  });

  it('relists only providers that are missing or stale', async () => {
    const { router, a, b } = setup();
    router.importModelLists({ A: { ids: ['a-1'], timestamp: Date.now() } });
    await router.reindexStale();
    expect([a.listings, b.listings]).toEqual([0, 1]);
    await router.reindexStale(Date.now() + 2 * 3600_000);
    expect([a.listings, b.listings]).toEqual([1, 2]);
  });

  it("doesn't share a list that came back empty, so the next instance tries again", async () => {
    const { router } = setup();
    router.importModelLists({ A: { ids: ['a-1'], timestamp: 5 } });
    expect(Object.keys(router.exportModelLists())).toEqual(['A']);
    expect(router.oldestModelList()).toBe(5);
  });
});

describe('keys still loading', () => {
  it('holds only requests for that provider until its key is in', async () => {
    const { router } = setup();
    await router.reindexAll();
    let release!: () => void;
    router.keyLoading('B', new Promise<void>((r) => { release = r; }));

    // A's model answers at once.
    await expect(router.route({ model: 'a-1', messages: [{ role: 'user', content: 'hi' }] })).resolves.toMatchObject({ choices: [{ message: { content: 'A' } }] });

    let done = false;
    const b = router.route({ model: 'gemini-x', messages: [{ role: 'user', content: 'hi' }] }).then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    release();
    await expect(b).resolves.toMatchObject({ choices: [{ message: { content: 'B' } }] });
  });

  it("doesn't list a provider before its key is in", async () => {
    const { router, a, b } = setup();
    router.keyLoading('B', new Promise<void>(() => undefined));
    await router.reindexStale();
    expect([a.listings, b.listings]).toEqual([1, 0]);
  });
});

