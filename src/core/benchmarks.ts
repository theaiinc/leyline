export type BenchmarkId =
  | 'hle'
  | 'gpqa-diamond'
  | 'swe-bench-verified'
  | 'livecodebench'
  | 'aime'
  | 'lmarena-text-elo'
  | 'intelligence-index'
  | 'livebench'
  | 'terminal-bench';

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
  livebench: 'LiveBench',
  'terminal-bench': 'Terminal-Bench',
};

const MODEL_ALIASES: Record<string, string> = {
  'claude-opus-5-5': 'claude-opus-5.5',
  'claude-sonnet-5-5': 'claude-sonnet-5.5',
  'gpt-4o-latest': 'gpt-4o',
  'gemini-2.5-pro-latest': 'gemini-2.5-pro',
};

export function normalizeModelId(id: string): string {
  let normalized = id.trim().toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/^[^/:]+[/:]/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-latest$/, '')
    .replace(/(?:[_-](?:max|high|low|medium|thinking|reasoning))$/, '')
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

/** Schedule one refresh without allowing concurrent requests to stampede the sources. */
export function refreshBenchmarks(
  fetcher: BenchmarkFetcher,
  cache: BenchmarkCache,
  force = false,
): Promise<BenchmarkSnapshot | null> {
  if (benchmarkRefresh) return benchmarkRefresh;
  benchmarkRefresh = (async () => {
    const cached = await cache.get();
    if (!force && cached && cached.benchmarks.some((benchmark) => benchmark.scores.length > 0)) return cached;
    return loadBenchmarks(fetcher, cache, Date.now(), force ? 0 : undefined);
  })().catch((error) => {
    console.error('[benchmarks] background refresh failed', error instanceof Error ? error.message : 'unknown error');
    return null;
  }).finally(() => {
    benchmarkRefresh = null;
  });
  return benchmarkRefresh;
}
/** Refresh only an empty cache; callers can schedule this without delaying their response. */
export function refreshEmptyBenchmarks(
  fetcher: BenchmarkFetcher,
  cache: BenchmarkCache,
): Promise<BenchmarkSnapshot | null> {
  return refreshBenchmarks(fetcher, cache);
}

import { unzipSync, strFromU8 } from 'fflate';

export type BenchmarkSource = {
  name: string;
  attribution: string;
  fetch(): Promise<BenchmarkSnapshot>;
};

type UnknownRecord = Record<string, unknown>;
type BenchmarkRow = { model: string; score: number; benchmark: string; asOf?: string };

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function benchmarkId(value: string): BenchmarkId | null {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const aliases: Record<string, BenchmarkId> = {
    gpqa: 'gpqa-diamond', 'gpqa-diamond': 'gpqa-diamond',
    'swe-bench-verified': 'swe-bench-verified', 'swebench-verified': 'swe-bench-verified',
    livecodebench: 'livecodebench', livebench: 'livebench',
    'terminal-bench': 'terminal-bench', terminalbench: 'terminal-bench',
    aime: 'aime', 'aime-2024': 'aime',
    'humanitys-last-exam': 'hle', hle: 'hle',
    'lmarena-text-elo': 'lmarena-text-elo',
  };
  return aliases[normalized] ?? null;
}

export function rowsFromPayload(payload: unknown): BenchmarkRow[] {
  const root = asRecord(payload);
  const rows = Array.isArray(payload) ? payload : root && (Array.isArray(root.rows) ? root.rows : Array.isArray(root.data) ? root.data : root.results);
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const outer = asRecord(row);
    const item = asRecord(outer?.row) ?? asRecord(outer?.data) ?? outer;
    if (!item) return [];
    const model = asString(item.model ?? item.model_id ?? item.model_name ?? item.model_slug);
    const score = asNumber(item.score ?? item.value ?? item.elo ?? item.rating);
    const benchmark = asString(item.benchmark ?? item.metric ?? item.task ?? item.benchmark_id ?? item.category);
    if (!model || score === null || !benchmark) return [];
    return [{ model, score, benchmark, asOf: asString(item.as_of ?? item.date ?? item.updated_at ?? item.leaderboard_publish_date) ?? undefined }];
  });
}

function snapshotFromRows(rows: BenchmarkRow[], source: string, fetchedAt: number): BenchmarkSnapshot {
  const best = new Map<string, BenchmarkScore>();
  for (const row of rows) {
    const id = benchmarkId(row.benchmark);
    if (!id) continue;
    const key = `${id}:${normalizeModelId(row.model)}`;
    const score = { model: row.model, score: row.score, source, asOf: row.asOf ?? new Date(fetchedAt).toISOString().slice(0, 10) };
    if (!best.has(key) || best.get(key)!.score < score.score) best.set(key, score);
  }
  return {
    fetchedAt,
    benchmarks: benchmarkCatalog().map(({ id, name }) => ({
      id, name,
      scores: [...best.entries()].filter(([key]) => key.startsWith(`${id}:`)).map(([, score]) => score),
      source,
      asOf: new Date(fetchedAt).toISOString().slice(0, 10),
    })),
  };
}

async function fetchResponse(url: string, headers: Record<string, string> = {}, retries = 0): Promise<Response> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    if (response.status >= 500 && response.status < 600 && retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return fetchResponse(url, headers, retries - 1);
    }
    throw new Error(`${new URL(url).hostname} returned ${response.status}`);
  }
  return response;
}

async function fetchJson(url: string, headers: Record<string, string> = {}, retries = 0): Promise<unknown> {
  const response = await fetchResponse(url, headers, retries);
  return response.json();
}

function parseCsv(csv: string, benchmark: string, scoreColumn: string): BenchmarkRow[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') { field += '"'; i += 1; } else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      record.push(field); field = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && csv[i + 1] === '\n') i += 1;
      record.push(field); field = '';
      if (record.some((value) => value.trim())) records.push(record);
      record = [];
    } else field += char;
  }
  if (field || record.length) { record.push(field); records.push(record); }
  if (records.length < 2) return [];
  const headers = records[0].map((header) => header.replace(/^\uFEFF/, '').trim());
  const index = (name: string) => headers.findIndex((header) => header.toLowerCase() === name.toLowerCase());
  const modelIndex = index('Model version');
  const scoreIndex = index(scoreColumn);
  const dateIndex = index('Release date');
  return records.slice(1).flatMap((fields) => {
    const model = asString(fields[modelIndex]);
    const score = Number(fields[scoreIndex]);
    if (!model || !Number.isFinite(score)) return [];
    return [{ model, score, benchmark, asOf: asString(fields[dateIndex]) ?? undefined }];
  });
}

export async function fetchEpochSnapshot(url: string): Promise<BenchmarkSnapshot> {
  const response = await fetchResponse(url);
  const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const rows = Object.entries(archive).flatMap(([name, data]) => {
    const file = name.split('/').pop()?.toLowerCase() ?? '';
    const mapped: Record<string, { benchmark: BenchmarkId; scoreColumn: string }> = {
      gpqa_diamond: { benchmark: 'gpqa-diamond', scoreColumn: 'mean_score' },
      swe_bench_verified: { benchmark: 'swe-bench-verified', scoreColumn: 'mean_score' },
      otis_mock_aime_2024_2025: { benchmark: 'aime', scoreColumn: 'mean_score' },
      hle_external: { benchmark: 'hle', scoreColumn: 'Accuracy' },
      live_bench_external: { benchmark: 'livebench', scoreColumn: 'Global average' },
      terminalbench_external: { benchmark: 'terminal-bench', scoreColumn: 'Accuracy mean' },
    };
    const stem = file.replace(/\.csv$/, '').replace(/-/g, '_');
    const mapping = mapped[stem];
    return mapping ? parseCsv(strFromU8(data), mapping.benchmark, mapping.scoreColumn) : [];
  });
  return snapshotFromRows(rows, 'Epoch AI Benchmarking Hub', Date.now());
}

async function fetchLMArena(url: string): Promise<BenchmarkSnapshot> {
  const rows: BenchmarkRow[] = [];
  for (let offset = 0; offset < 12000; offset += 100) {
    const payload = await fetchJson(`${url}${url.includes('?') ? '&' : '?'}offset=${offset}&length=100`, {}, 2);
    const page = rowsFromPayload(payload).filter((row) => row.benchmark.toLowerCase() === 'overall');
    rows.push(...page.map((row) => ({ ...row, benchmark: 'lmarena-text-elo' })));
    const root = asRecord(payload);
    const pageRows = root && Array.isArray(root.rows) ? root.rows : Array.isArray(payload) ? payload : [];
    if (pageRows.length < 100) break;
  }
  return snapshotFromRows(rows, 'LMArena', Date.now());
}

export function benchmarkSources(env: {
  artificialAnalysisApiKey?: string;
  artificialAnalysisUrl?: string;
  epochUrl?: string;
  lmarenaUrl?: string;
}): BenchmarkSource[] {
  const sources: BenchmarkSource[] = [];
  const epochUrl = env.epochUrl ?? 'https://epoch.ai/data/benchmark_data.zip';
  const lmarenaUrl = env.lmarenaUrl ?? 'https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=text&split=latest';
  sources.push({
    name: 'epoch',
    attribution: 'Epoch AI Benchmarking Hub',
    fetch: () => fetchEpochSnapshot(epochUrl),
  });
  sources.push({
    name: 'lmarena',
    attribution: 'LMArena',
    fetch: () => fetchLMArena(lmarenaUrl),
  });
  if (env.artificialAnalysisApiKey && env.artificialAnalysisUrl) {
    sources.push({
      name: 'artificial-analysis',
      attribution: 'Artificial Analysis',
      fetch: () => fetchJson(env.artificialAnalysisUrl!, { Authorization: `Bearer ${env.artificialAnalysisApiKey}` }).then((payload) => snapshotFromRows(rowsFromPayload(payload), 'Artificial Analysis', Date.now())),
    });
  }
  return sources;
}

export async function fetchBenchmarkSnapshot(env: {
  artificialAnalysisApiKey?: string;
  artificialAnalysisUrl?: string;
  epochUrl?: string;
  lmarenaUrl?: string;
}): Promise<BenchmarkSnapshot> {
  const sources = benchmarkSources(env);
  const results = await Promise.allSettled(sources.map((source) => source.fetch()));
  const snapshots = results.flatMap((result, index) => {
    if (result.status === 'fulfilled') return [result.value];
    const source = sources[index];
    console.error(`[benchmarks] ${source?.name ?? 'unknown'} refresh failed`, result.reason instanceof Error ? result.reason.message : result.reason);
    return [];
  });
  if (snapshots.length === 0) throw new Error('all benchmark sources failed');
  const benchmarks = benchmarkCatalog().map(({ id, name }) => {
    const scores = snapshots.flatMap((snapshot) => snapshot.benchmarks.find((benchmark) => benchmark.id === id)?.scores ?? []);
    const best = new Map<string, BenchmarkScore>();
    for (const score of scores) {
      const key = normalizeModelId(score.model);
      if (!best.has(key) || best.get(key)!.score < score.score) best.set(key, score);
    }
    return { id, name, scores: [...best.values()] };
  });
  return { fetchedAt: Date.now(), benchmarks };
}
