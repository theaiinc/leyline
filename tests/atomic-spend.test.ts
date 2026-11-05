import { D1DocStore } from '../src/core/d1-stores';
import { IssuedKeys, MemoryDocStore, type KeyUsage, type MonthSpend } from '../src/core/issued-keys';
import { sqliteD1 } from './helpers/sqlite-d1';

// Steve's money rule: every finished request is counted. 100 parallel requests on production counted 37 (2026-11-05):
// each one read the month's spend document, added itself and wrote it back, and the losers of a race were dropped.
describe('spend is recorded atomically: parallel requests are all counted', () => {
  const NOW = Date.UTC(2026, 10, 5, 7, 0, 0);
  for (const [name, makeStore] of [['D1 (real SQLite)', () => new D1DocStore(sqliteD1() as never)], ['memory', () => new MemoryDocStore()]] as const) {
    it(`${name}: 200 parallel records add up exactly, per month, provider, model, day and key`, async () => {
      const store = makeStore();
      const keys = new IssuedKeys(store, { now: () => NOW });
      const { record: key } = await keys.create({ name: 'load', caps: {}, by: 'test' });
      const served = [{ provider: 'AzureOpenAI', model: 'gpt-5.6-luna' }, { provider: 'BytePlus', model: 'deepseek-v4-flash-ga-260731' }];
      await Promise.all(Array.from({ length: 200 }, (_, i) =>
        keys.record(i % 2 ? key : null, 'auto', { prompt_tokens: 10, completion_tokens: 5, cached_tokens: i % 4 === 0 ? 4 : 0 }, 0.001, served[i % 2])));
      const s = (await store.get<MonthSpend>('spend/2026-11'))!.value;
      expect(s.requests).toBe(200);
      expect(s.usd).toBeCloseTo(0.2, 9);
      expect(s.tokens).toBe(3000);
      expect(s.byProvider!.AzureOpenAI.requests).toBe(100);
      expect(s.byModel!['BytePlus/deepseek-v4-flash-ga-260731']).toMatchObject({ requests: 100, provider: 'BytePlus', model: 'deepseek-v4-flash-ga-260731' });
      expect(s.byModel!['AzureOpenAI/gpt-5.6-luna'].cachedTokens).toBe(200);
      expect(s.byDay!['2026-11-05']['AzureOpenAI/gpt-5.6-luna'].usd).toBeCloseTo(0.1, 9);
      const u = (await store.get<KeyUsage>(`usage/${key.id}/2026-11`))!.value;
      expect(u).toMatchObject({ requests: 100, promptTokens: 1000, completionTokens: 500, days: { '2026-11-05': 100 } });
      expect(u.byModel.auto).toMatchObject({ requests: 100, tokens: 1500 });
      expect(u.usd).toBeCloseTo(0.1, 9);
    });
  }

  it('keeps what it does not count (a price correction already applied stays)', async () => {
    const store = new D1DocStore(sqliteD1() as never);
    await store.put('spend/2026-11', { month: '2026-11', usd: 5, requests: 3, adjustments: [{ id: 'adj_1' }] });
    const keys = new IssuedKeys(store, { now: () => NOW });
    await keys.record(null, 'auto', { prompt_tokens: 1, completion_tokens: 1 }, 1, { provider: 'P', model: 'm.1/x' });
    const s = (await store.get<MonthSpend>('spend/2026-11'))!.value;
    expect(s).toMatchObject({ usd: 6, requests: 4, adjustments: [{ id: 'adj_1' }] });
    expect(s.byModel!['P/m.1/x']).toMatchObject({ requests: 1, provider: 'P', model: 'm.1/x' });
  });
});
