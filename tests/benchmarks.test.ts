import { zipSync, strToU8 } from 'fflate';
import {
  fetchBenchmarkSnapshot,
  fetchEpochSnapshot,
  loadBenchmarks,
  refreshBenchmarks,
  matchBenchmarkModel,
  rankBenchmarks,
  type BenchmarkCache,
  type BenchmarkSnapshot,
} from '../src/core/benchmarks';

const snapshot: BenchmarkSnapshot = {
  fetchedAt: 1,
  benchmarks: [
    {
      id: 'gpqa-diamond',
      name: 'GPQA Diamond',
      scores: [
        { model: 'gpt-4o', score: 70, source: 'test', asOf: '2026-01-01' },
        { model: 'claude-opus-5.5', score: 80, source: 'test', asOf: '2026-01-01' },
      ],
    },
    {
      id: 'hle',
      name: "Humanity's Last Exam",
      scores: [
        { model: 'gpt-4o', score: 40, source: 'test', asOf: '2026-01-01' },
      ],
    },
  ],
};

describe('benchmark matching and ranking', () => {
  it('matches normalized provider prefixes, dates, latest aliases, and case exactly', () => {
    expect(matchBenchmarkModel('OpenAI/gpt-4o-2025-01-01', snapshot.benchmarks[0]!.scores)?.model).toBe('gpt-4o');
    expect(matchBenchmarkModel('GPT-4O-latest', snapshot.benchmarks[0]!.scores)?.model).toBe('gpt-4o');
    expect(matchBenchmarkModel('gpt-4o-mini', snapshot.benchmarks[0]!.scores)).toBeUndefined();
  });

  it('ranks scored models first and keeps missing scores unbenchmarked', () => {
    const ranked = rankBenchmarks(['gpt-4o-mini', 'gpt-4o', 'claude-opus-5-5'], snapshot);
    expect(ranked.map((row) => row.id)).toEqual(['claude-opus-5-5', 'gpt-4o', 'gpt-4o-mini']);
    expect(ranked.find((row) => row.id === 'gpt-4o-mini')?.benchmarks['gpqa-diamond']).toBeNull();
  });

  it('parses LMArena datasets-server rows and keeps the best normalized model score', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({ rows: [
      { row: { model_name: 'Gemini 4 Argon (High)', rating: 1500, category: 'overall', leaderboard_publish_date: '2026-10-28' } },
      { row: { model_name: 'Gemini 4 Argon (Low)', rating: 1490, category: 'overall', leaderboard_publish_date: '2026-10-28' } },
    ] }), { status: 200 });
    const result = await fetchBenchmarkSnapshot({ epochUrl: 'https://example.test/epoch.zip', lmarenaUrl: 'https://example.test/rows' });
    global.fetch = originalFetch;
    const scores = result.benchmarks.find((benchmark) => benchmark.id === 'lmarena-text-elo')?.scores ?? [];
    expect(scores).toEqual(expect.arrayContaining([expect.objectContaining({ model: 'gemini-4-argon', score: 1500 })]));
    expect(scores.filter((score) => score.model === 'gemini-4-argon')).toHaveLength(1);
  });
});

describe('Epoch benchmark ZIP parsing', () => {
  it('maps per-file score columns, normalizes effort suffixes, and preserves quoted newlines', async () => {
    const zip = zipSync({
      'gpqa_diamond.csv': strToU8('Model version,mean_score,Release date\ngpt-6.1-terra_max,0.943,2026-10-26\n'),
      'hle_external.csv': strToU8('Model version,Accuracy,Notes\nClaude Opus 5.5 (High),0.812,"line one\nline two"\n'),
    });
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(zip, { status: 200 });
    const snapshot = await fetchEpochSnapshot('https://example.test/benchmark_data.zip');
    global.fetch = originalFetch;
    expect(snapshot.benchmarks.find((benchmark: BenchmarkSnapshot['benchmarks'][number]) => benchmark.id === 'gpqa-diamond')?.scores[0]).toMatchObject({ model: 'gpt-6.1-terra', score: 0.943 });
    expect(snapshot.benchmarks.find((benchmark: BenchmarkSnapshot['benchmarks'][number]) => benchmark.id === 'hle')?.scores[0]).toMatchObject({ model: 'claude-opus-5.5', score: 0.812 });
  });

  it('parses LMArena datasets-server rows and keeps the best normalized model score', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({ rows: [
      { row: { model_name: 'Gemini 4 Argon (High)', rating: 1500, category: 'overall', leaderboard_publish_date: '2026-10-28' } },
      { row: { model_name: 'Gemini 4 Argon (Low)', rating: 1490, category: 'overall', leaderboard_publish_date: '2026-10-28' } },
    ] }), { status: 200 });
    const result = await fetchBenchmarkSnapshot({ epochUrl: 'https://example.test/epoch.zip', lmarenaUrl: 'https://example.test/rows' });
    global.fetch = originalFetch;
    const scores = result.benchmarks.find((benchmark) => benchmark.id === 'lmarena-text-elo')?.scores ?? [];
    expect(scores).toEqual(expect.arrayContaining([expect.objectContaining({ model: 'gemini-4-argon', score: 1500 })]));
    expect(scores.filter((score) => score.model === 'gemini-4-argon')).toHaveLength(1);
  });
});

describe('benchmark refresh behavior', () => {
  it('returns an empty cache immediately while refreshing it in the background', async () => {
    let stored: BenchmarkSnapshot | null = null;
    let resolveFetch!: (value: BenchmarkSnapshot) => void;
    const fetchPromise = new Promise<BenchmarkSnapshot>((resolve) => { resolveFetch = resolve; });
    const cache: BenchmarkCache = {
      get: async () => stored,
      put: async (value) => { stored = value; },
    };
    const refresh = refreshBenchmarks(() => fetchPromise, cache);
    expect(await cache.get()).toBeNull();
    resolveFetch(snapshot);
    await refresh;
    expect(stored).toBe(snapshot);
  });

  it('keeps successful source rows when another source fails', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async (input) => {
      const url = String(input);
      if (url.includes('benchmark_data.zip')) {
        const zip = zipSync({ 'gpqa_diamond.csv': strToU8('Model version,mean_score,Release date\ngpt-6.1-terra,0.9,2026-10-26\n') });
        return new Response(zip, { status: 200 });
      }
      calls += 1;
      return new Response('upstream unavailable', { status: 502 });
    };
    const result = await fetchBenchmarkSnapshot({ epochUrl: 'https://example.test/benchmark_data.zip', lmarenaUrl: 'https://example.test/rows' });
    global.fetch = originalFetch;
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(result.benchmarks.find((benchmark) => benchmark.id === 'gpqa-diamond')?.scores).toHaveLength(1);
  });

  it('parses LMArena datasets-server rows and keeps the best normalized model score', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({ rows: [
      { row: { model_name: 'Gemini 4 Argon (High)', rating: 1500, category: 'overall', leaderboard_publish_date: '2026-10-28' } },
      { row: { model_name: 'Gemini 4 Argon (Low)', rating: 1490, category: 'overall', leaderboard_publish_date: '2026-10-28' } },
    ] }), { status: 200 });
    const result = await fetchBenchmarkSnapshot({ epochUrl: 'https://example.test/epoch.zip', lmarenaUrl: 'https://example.test/rows' });
    global.fetch = originalFetch;
    const scores = result.benchmarks.find((benchmark) => benchmark.id === 'lmarena-text-elo')?.scores ?? [];
    expect(scores).toEqual(expect.arrayContaining([expect.objectContaining({ model: 'gemini-4-argon', score: 1500 })]));
    expect(scores.filter((score) => score.model === 'gemini-4-argon')).toHaveLength(1);
  });
});
describe('benchmark cache fallback', () => {
  it('returns cached data when refresh fails', async () => {
    const cache: BenchmarkCache = {
      get: async () => snapshot,
      put: async () => { throw new Error('should not write'); },
    };
    await expect(loadBenchmarks(async () => { throw new Error('offline'); }, cache, 2, 0)).resolves.toBe(snapshot);
  });

  it('writes and returns a fresh snapshot', async () => {
    let stored: BenchmarkSnapshot | null = null;
    const fresh = { ...snapshot, fetchedAt: 10 };
    const cache: BenchmarkCache = {
      get: async () => null,
      put: async (value) => { stored = value; },
    };
    await expect(loadBenchmarks(async () => fresh, cache, 10)).resolves.toBe(fresh);
    expect(stored).toBe(fresh);
  });
}); 