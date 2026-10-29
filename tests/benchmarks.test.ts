import {
  loadBenchmarks,
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