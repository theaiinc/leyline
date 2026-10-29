export type BenchmarkId =
  | 'hle'
  | 'gpqa-diamond'
  | 'swe-bench-verified'
  | 'livecodebench'
  | 'aime'
  | 'lmarena-text-elo'
  | 'intelligence-index';

export type BenchmarkScore = {
  model: string;
  score: number;
  source: string;
  asOf: string;
};

export type Benchmark = {
  id: BenchmarkId;
  name: string;
  scores: BenchmarkScore[];
  source?: string;
  asOf?: string;
};

export type BenchmarkSnapshot = {
  fetchedAt: number;
  benchmarks: Benchmark[];
};

export type BenchmarkFetcher = () => Promise<BenchmarkSnapshot>;

export type BenchmarkCache = {
  get(): Promise<BenchmarkSnapshot | null>;
  put(snapshot: BenchmarkSnapshot): Promise<void>;
};

const BENCHMARK_NAMES: Record<BenchmarkId, string> = {
  hle: "Humanity's Last Exam",
  'gpqa-diamond': 'GPQA Diamond',
  'swe-bench-verified': 'SWE-bench Verified',
  livecodebench: 'LiveCodeBench',
  aime: 'AIME',
  'lmarena-text-elo': 'LMArena text Elo',
  'intelligence-index': 'Composite intelligence index',
};

const MODEL_ALIASES: Record<string, string> = {
  'claude-opus-5-5': 'claude-opus-5.5',
  'claude-sonnet-5-5': 'claude-sonnet-5.5',
  'gpt-4o-latest': 'gpt-4o',
  'gemini-2.5-pro-latest': 'gemini-2.5-pro',
};

export function normalizeModelId(id: string): string {
  let normalized = id.trim().toLowerCase()
    .replace(/^[^/:]+[/:]/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-latest$/, '')
    .replace(/[\s_]+/g, '-');
  return MODEL_ALIASES[normalized] ?? normalized;
}

export function modelAlias(id: string): string | undefined {
  return MODEL_ALIASES[normalizeModelId(id)];
}

export function matchBenchmarkModel(modelId: string, scores: BenchmarkScore[]): BenchmarkScore | undefined {
  const wanted = normalizeModelId(modelId);
  return scores.find((score) => normalizeModelId(score.model) === wanted);
}

export function rankBenchmarks(models: string[], snapshot: BenchmarkSnapshot): Array<{
  id: string;
  benchmarks: Record<BenchmarkId, BenchmarkScore | null>;
}> {
  return models.map((id) => {
    const benchmarks = {} as Record<BenchmarkId, BenchmarkScore | null>;
    for (const benchmark of snapshot.benchmarks) {
      benchmarks[benchmark.id] = matchBenchmarkModel(id, benchmark.scores) ?? null;
    }
    return { id, benchmarks };
  }).sort((a, b) => {
    const bestScore = (row: { benchmarks: Record<BenchmarkId, BenchmarkScore | null> }) =>
      Math.max(...Object.values(row.benchmarks).flatMap((score) => score ? [score.score] : []), -Infinity);
    const left = bestScore(a);
    const right = bestScore(b);
    if (left !== right) return right - left;
    return a.id.localeCompare(b.id);
  });
}

export function benchmarkCatalog(): Array<{ id: BenchmarkId; name: string }> {
  return (Object.keys(BENCHMARK_NAMES) as BenchmarkId[]).map((id) => ({ id, name: BENCHMARK_NAMES[id] }));
}

export async function loadBenchmarks(
  fetcher: BenchmarkFetcher,
  cache: BenchmarkCache,
  now = Date.now(),
  maxAgeMs = 24 * 60 * 60 * 1000,
): Promise<BenchmarkSnapshot | null> {
  const cached = await cache.get();
  if (cached && now - cached.fetchedAt < maxAgeMs) return cached;
  try {
    const fresh = await fetcher();
    await cache.put(fresh);
    return fresh;
  } catch (error) {
    console.error('[benchmarks] refresh failed; using last good snapshot', error instanceof Error ? error.message : 'unknown error');
    return cached;
  }
}

let benchmarkRefresh: Promise<BenchmarkSnapshot | null> | null = null;

/** Refresh only an empty cache; callers can schedule this without delaying their response. */
export function refreshEmptyBenchmarks(
  fetcher: BenchmarkFetcher,
  cache: BenchmarkCache,
): Promise<BenchmarkSnapshot | null> {
  if (benchmarkRefresh) return benchmarkRefresh;
  benchmarkRefresh = (async () => {
    const cached = await cache.get();
    if (cached && cached.benchmarks.some((benchmark) => benchmark.scores.length > 0)) return cached;
    return loadBenchmarks(fetcher, cache);
  })().catch((error) => {
    console.error('[benchmarks] background refresh failed', error instanceof Error ? error.message : 'unknown error');
    return null;
  }).finally(() => {
    benchmarkRefresh = null;
  });
  return benchmarkRefresh;
}

export type BenchmarkSource = {
  name: string;
  attribution: string;
  fetch(): Promise<BenchmarkSnapshot>;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function rowsFromPayload(payload: unknown): Array<{ model: string; score: number; benchmark: string; asOf?: string }> {
  const root = asRecord(payload);
  const rows = Array.isArray(payload) ? payload : root && (Array.isArray(root.data) ? root.data : root.results);
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const item = asRecord(row);
    if (!item) return [];
    const model = asString(item.model ?? item.model_id ?? item.name);
    const score = asNumber(item.score ?? item.value ?? item.elo ?? item.rating);
    const benchmark = asString(item.benchmark ?? item.metric ?? item.task);
    if (!model || score === null || !benchmark) return [];
    return [{ model, score, benchmark, asOf: asString(item.as_of ?? item.date ?? item.updated_at) ?? undefined }];
  });
}

function snapshotFromRows(rows: Array<{ model: string; score: number; benchmark: string; asOf?: string }>, source: string, fetchedAt: number): BenchmarkSnapshot {
  const byBenchmark = new Map<string, BenchmarkScore[]>();
  for (const row of rows) {
    const id = row.benchmark.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const scores = byBenchmark.get(id) ?? [];
    scores.push({ model: row.model, score: row.score, source, asOf: row.asOf ?? new Date(fetchedAt).toISOString().slice(0, 10) });
    byBenchmark.set(id, scores);
  }
  const benchmarks = benchmarkCatalog().map(({ id, name }) => ({
    id,
    name,
    scores: byBenchmark.get(id) ?? [],
    source,
    asOf: new Date(fetchedAt).toISOString().slice(0, 10),
  }));
  return { fetchedAt, benchmarks };
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

export function benchmarkSources(env: {
  artificialAnalysisApiKey?: string;
  artificialAnalysisUrl?: string;
  epochUrl?: string;
  lmarenaUrl?: string;
}): BenchmarkSource[] {
  const sources: BenchmarkSource[] = [];
  if (env.artificialAnalysisApiKey) {
    sources.push({
      name: 'Artificial Analysis',
      attribution: 'Data by Artificial Analysis',
      fetch: async () => snapshotFromRows(
        rowsFromPayload(await fetchJson(env.artificialAnalysisUrl ?? 'https://artificialanalysis.ai/api/v2/benchmarks', {
          Authorization: `Bearer ${env.artificialAnalysisApiKey}`,
          Accept: 'application/json',
        })),
        'Artificial Analysis',
        Date.now(),
      ),
    });
  }
  sources.push({
    name: 'Epoch AI Benchmarking Hub',
    attribution: 'Data by Epoch AI',
    fetch: async () => snapshotFromRows(
      rowsFromPayload(await fetchJson(env.epochUrl ?? 'https://epoch.ai/data/benchmarks.json')),
      'Epoch AI Benchmarking Hub',
      Date.now(),
    ),
  });
  sources.push({
    name: 'LMArena',
    attribution: 'Data by LMArena',
    fetch: async () => snapshotFromRows(
      rowsFromPayload(await fetchJson(env.lmarenaUrl ?? 'https://lmarena.ai/leaderboard.json')),
      'LMArena',
      Date.now(),
    ),
  });
  return sources;
}

export async function fetchBenchmarkSnapshot(env: Parameters<typeof benchmarkSources>[0]): Promise<BenchmarkSnapshot> {
  const sources = benchmarkSources(env);
  const snapshots: BenchmarkSnapshot[] = [];
  for (const source of sources) {
    try {
      const snapshot = await source.fetch();
      const rows = snapshot.benchmarks.reduce((count, benchmark) => count + benchmark.scores.length, 0);
      console.log(JSON.stringify({ event: 'benchmark_source', source: source.name, rowsMatched: rows }));
      if (rows > 0) snapshots.push(snapshot);
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'benchmark_source',
        source: source.name,
        rowsMatched: 0,
        error: error instanceof Error ? error.message : 'unknown error',
      }));
    }
  }
  if (!snapshots.length) throw new Error('No benchmark source available');
  const merged = new Map<BenchmarkId, Benchmark>();
  for (const snapshot of snapshots) {
    for (const benchmark of snapshot.benchmarks) {
      const current = merged.get(benchmark.id);
      if (!current || current.scores.length === 0) merged.set(benchmark.id, benchmark);
      else {
        const known = new Set(current.scores.map((score) => normalizeModelId(score.model)));
        current.scores.push(...benchmark.scores.filter((score) => !known.has(normalizeModelId(score.model))));
      }
    }
  }
  return { fetchedAt: Date.now(), benchmarks: [...merged.values()] };
}