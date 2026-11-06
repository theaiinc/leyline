/**
 * Routing strategies for chat: `auto:cheapest`, `auto:best`, `auto:fastest` and `auto:balanced` (or a key's default
 * strategy, applied to plain `auto`). Before routing, a strategy becomes an ordered list of concrete chat models;
 * the router is then asked for the first one as an explicitly named model, and for the next one only when every
 * provider serving the first failed (routeByPlan / streamByPlan). Billing is untouched: the request is priced by the
 * model that answered, exactly as when the client names it (RouteOptions.onServed -> hosted.ts recordUsage).
 *
 * Eligible models: offered here, with a real price, served by an available provider, allowed for the key, and able
 * to read the request's content (a request with images only goes to vision-capable models). How each strategy ranks
 * them (ties: blended price, then the lower output price, then model id):
 *
 * - cheapest: lowest blended price, (3 x input + 1 x output) / 4 US$ per million tokens: chat requests send about
 *   three input tokens for every output token, so that is the weighting a typical request pays.
 * - best: highest quality score (qualityScores: each benchmark rescaled 0-1 across every model it lists, averaged
 *   over the benchmarks that score the model). Models without a score follow, cheapest first; with no scores at all
 *   it is the cheapest order.
 * - fastest: lowest median duration of the model's recent successful requests (the last requests in the request
 *   log, at least MIN_LATENCY_SAMPLES of them). Models without enough data follow, cheapest first; with no data at
 *   all it is the cheapest order.
 * - balanced: 0.5 x price score + 0.5 x quality score, where the price score is 1 for the cheapest eligible model
 *   and 0 for the dearest (linear on blended price in between) and the quality score is the model's quality
 *   rescaled the same way among the eligible models that have one (0 for a model without a score).
 */
import type { CompletionRequest, CompletionResponse, RouteOptions, StreamChunk } from './types';
import type { BenchmarkSnapshot } from './benchmarks';
import { matchBenchmarkModel } from './benchmarks';
import type { LogEntry } from './logger';
import { requestHasNonTextContent } from './content';

export const ROUTING_STRATEGIES = ['cheapest', 'best', 'fastest', 'balanced'] as const;
export type RoutingStrategy = (typeof ROUTING_STRATEGIES)[number];

/** Input tokens weighed against output tokens in the blended price (3:1). */
export const PRICE_WEIGHTS = { input: 3, output: 1 } as const;
/** A model needs at least this many recent successful requests for its median latency to count. */
export const MIN_LATENCY_SAMPLES = 3;
/** Weight of price (the rest: quality) in the balanced strategy. */
export const BALANCED_PRICE_WEIGHT = 0.5;

export function isRoutingStrategy(value: unknown): value is RoutingStrategy {
  return typeof value === 'string' && (ROUTING_STRATEGIES as readonly string[]).includes(value);
}

/** '', `auto`, `auto-vision` and every `auto:<strategy>`: the router (or a strategy) picks the model. */
export function isRouterPick(model: string | undefined | null): boolean {
  const m = (model ?? '').trim().toLowerCase();
  return !m || m === 'auto' || m === 'auto-vision' || m.startsWith('auto:');
}

/** A request for a strategy that doesn't exist (`auto:fanciest`): a 400 naming the ones that do. */
export class UnknownStrategyError extends Error {
  readonly status = 400;
  readonly code = 'unknown_routing_strategy';
  readonly response: { status: number; data: { error: { message: string; type: string; code: string } } };

  constructor(model: string) {
    const message = `Unknown routing strategy "${model}": use ${ROUTING_STRATEGIES.map((s) => `auto:${s}`).join(', ')}, auto, or a model id.`;
    super(message);
    this.name = 'UnknownStrategyError';
    this.response = { status: 400, data: { error: { message, type: 'invalid_request_error', code: this.code } } };
  }
}

/** No model the strategy may use can take this request (none offered and served, or none reads its images). */
export class NoEligibleModelError extends Error {
  readonly status: number;
  readonly code: string;
  readonly response: { status: number; data: { error: { message: string; type: string; code: string } } };

  constructor(strategy: RoutingStrategy, needsVision: boolean) {
    const status = needsVision ? 400 : 503;
    const code = needsVision ? 'unsupported_content' : 'no_model_available';
    const message = needsVision
      ? `The request has images, but no vision-capable model is available for auto:${strategy}. Ask for a vision-capable model.`
      : `No model is available for auto:${strategy} right now; try again, or name a model (see /v1/models).`;
    super(message);
    this.name = 'NoEligibleModelError';
    this.status = status;
    this.code = code;
    this.response = { status, data: { error: { message, type: needsVision ? 'invalid_request_error' : 'service_unavailable', code } } };
  }
}

/** An error from planning a strategy (unknown strategy, no eligible model) as a status and OpenAI-style body. */
export function strategyErrorResponse(err: unknown): { status: number; body: { error: { message: string; type: string; code: string } } } | null {
  if (err instanceof UnknownStrategyError || err instanceof NoEligibleModelError) return { status: err.response.status, body: err.response.data };
  return null;
}

/**
 * The strategy a chat request asks for: `auto:<strategy>` (an unknown one throws UnknownStrategyError), else the
 * key's default for plain `auto`, else null (route as today). The request's alias always wins over the key default.
 */
export function strategyFor(model: string, keyDefault?: RoutingStrategy | null): RoutingStrategy | null {
  const m = (model ?? '').trim().toLowerCase();
  if (m.startsWith('auto:')) {
    const name = m.slice(5);
    if (!isRoutingStrategy(name)) throw new UnknownStrategyError(model);
    return name;
  }
  if (m === 'auto' && isRoutingStrategy(keyDefault)) return keyDefault;
  return null;
}

export type Price = { input: number; output: number };

/** US$ per million tokens, input and output weighed 3:1 (PRICE_WEIGHTS). */
export function blendedPrice(price: Price): number {
  return (PRICE_WEIGHTS.input * price.input + PRICE_WEIGHTS.output * price.output) / (PRICE_WEIGHTS.input + PRICE_WEIGHTS.output);
}

/**
 * Quality per model, 0-1: each benchmark's scores rescaled 0-1 across every model that benchmark lists (so Elo and
 * percentages compare), then averaged over the benchmarks that score the model. Models no benchmark scores are
 * left out. A benchmark listing fewer than two distinct scores can't be rescaled and is skipped.
 */
export function qualityScores(models: string[], snapshot: BenchmarkSnapshot | null | undefined, aliases: Record<string, string[]> = {}): Map<string, number> {
  const sums = new Map<string, { total: number; count: number }>();
  for (const benchmark of snapshot?.benchmarks ?? []) {
    const values = benchmark.scores.map((s) => s.score).filter((v) => Number.isFinite(v));
    if (values.length < 2) continue;
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max === min) continue;
    for (const model of models) {
      // The model's own id or a name the benchmark lists it under (BENCHMARK_ALIASES); several rows: the best.
      const rows = [model, ...(aliases[model] ?? [])].map((name) => matchBenchmarkModel(name, benchmark.scores))
        .filter((row): row is NonNullable<typeof row> => !!row && Number.isFinite(row.score));
      if (!rows.length) continue;
      const score = Math.max(...rows.map((row) => row.score));
      const cur = sums.get(model) ?? { total: 0, count: 0 };
      cur.total += (score - min) / (max - min);
      cur.count += 1;
      sums.set(model, cur);
    }
  }
  return new Map([...sums].map(([model, { total, count }]) => [model, total / count]));
}

/** Median duration (ms) of each model's successful requests in the log, for models with MIN_LATENCY_SAMPLES of them. */
export function medianLatencies(entries: LogEntry[], models: string[], minSamples = MIN_LATENCY_SAMPLES): Map<string, number> {
  const wanted = new Set(models);
  const byModel = new Map<string, number[]>();
  for (const e of entries) {
    if (e.status !== 'success' || !wanted.has(e.model) || typeof e.duration !== 'number' || !Number.isFinite(e.duration)) continue;
    (byModel.get(e.model) ?? byModel.set(e.model, []).get(e.model)!).push(e.duration);
  }
  const out = new Map<string, number>();
  for (const [model, durations] of byModel) {
    if (durations.length < minSamples) continue;
    const sorted = [...durations].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    out.set(model, sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
  }
  return out;
}

export type RankInputs = {
  /** Eligible models with their prices. */
  prices: Map<string, Price>;
  benchmarks?: BenchmarkSnapshot | null;
  /** Other names benchmarks list a model under (model id -> names). */
  benchmarkAliases?: Record<string, string[]>;
  /** Recent request log entries (for fastest). */
  logs?: LogEntry[];
};

export type Ranking = { models: string[]; reason: string };

/** Order eligible models for a strategy, with a short reason for the first pick (for X-Valefront-Route). */
export function rankModels(strategy: RoutingStrategy, inputs: RankInputs): Ranking {
  const ids = [...inputs.prices.keys()];
  const blended = new Map(ids.map((id) => [id, blendedPrice(inputs.prices.get(id)!)]));
  // Compared to a millionth of a dollar (float noise is no difference); a tie goes to the lower output price.
  const micro = (v: number) => Math.round(v * 1e6);
  const byPrice = (a: string, b: string) => micro(blended.get(a)!) - micro(blended.get(b)!)
    || micro(inputs.prices.get(a)!.output) - micro(inputs.prices.get(b)!.output) || a.localeCompare(b);
  const cheapest = [...ids].sort(byPrice);

  if (strategy === 'cheapest') return { models: cheapest, reason: 'lowest-blended-price' };

  if (strategy === 'best') {
    const quality = qualityScores(ids, inputs.benchmarks, inputs.benchmarkAliases);
    if (quality.size === 0) return { models: cheapest, reason: 'no-benchmarks-cheapest' };
    const scored = ids.filter((id) => quality.has(id)).sort((a, b) => quality.get(b)! - quality.get(a)! || byPrice(a, b));
    return { models: [...scored, ...cheapest.filter((id) => !quality.has(id))], reason: 'top-benchmark-score' };
  }

  if (strategy === 'fastest') {
    const latency = medianLatencies(inputs.logs ?? [], ids);
    if (latency.size === 0) return { models: cheapest, reason: 'no-latency-data-cheapest' };
    const timed = ids.filter((id) => latency.has(id)).sort((a, b) => latency.get(a)! - latency.get(b)! || byPrice(a, b));
    return { models: [...timed, ...cheapest.filter((id) => !latency.has(id))], reason: 'lowest-median-latency' };
  }

  // balanced
  const quality = qualityScores(ids, inputs.benchmarks, inputs.benchmarkAliases);
  const rescale = (values: Map<string, number>) => {
    const all = [...values.values()];
    const min = Math.min(...all);
    const max = Math.max(...all);
    return (v: number) => (max === min ? 1 : (v - min) / (max - min));
  };
  const priceScore = rescale(blended);
  const qualityScore = quality.size ? rescale(quality) : () => 0;
  const score = new Map(ids.map((id) => [id,
    BALANCED_PRICE_WEIGHT * (1 - priceScore(blended.get(id)!)) + (1 - BALANCED_PRICE_WEIGHT) * (quality.has(id) ? qualityScore(quality.get(id)!) : 0),
  ]));
  if (quality.size === 0) return { models: cheapest, reason: 'no-benchmarks-cheapest' };
  return { models: [...ids].sort((a, b) => score.get(b)! - score.get(a)! || byPrice(a, b)), reason: 'best-price-quality-mix' };
}

/** What a plan needs to know about this deployment, the key and the request (built in hosted.ts strategyEnv). */
export type StrategyEnv = {
  /** Chat models offered here that this key may use (already without blocked and media models). */
  offered(): Promise<string[]>;
  /** The model's real price (set by hand, or published), or undefined: unpriced models are never picked. */
  price(model: string): Price | undefined;
  /** Some provider that isn't over budget and reports available serves the model. */
  served(model: string): Promise<boolean>;
  /** The model reads images (and other non-text parts). */
  readsImages(model: string): boolean;
  benchmarks?(): Promise<BenchmarkSnapshot | null>;
  /** Other names benchmarks list models under. */
  benchmarkAliases?: Record<string, string[]>;
  recentLogs?(): Promise<LogEntry[]>;
};

export type RoutePlan = { strategy: RoutingStrategy; models: string[]; reason: string };

/** Turn a strategy into an ordered list of concrete chat models for this request. */
export async function planStrategy(strategy: RoutingStrategy, request: CompletionRequest, env: StrategyEnv): Promise<RoutePlan> {
  const needsVision = requestHasNonTextContent(request.messages);
  const prices = new Map<string, Price>();
  for (const model of await env.offered()) {
    if (prices.has(model)) continue;
    const price = env.price(model);
    if (!price || !Number.isFinite(price.input) || !Number.isFinite(price.output)) continue;
    if (needsVision && !env.readsImages(model)) continue;
    if (!(await env.served(model))) continue;
    prices.set(model, price);
  }
  if (prices.size === 0) throw new NoEligibleModelError(strategy, needsVision);
  const needsBenchmarks = strategy === 'best' || strategy === 'balanced';
  const [benchmarks, logs] = await Promise.all([
    needsBenchmarks ? env.benchmarks?.().catch(() => null) ?? null : null,
    strategy === 'fastest' ? env.recentLogs?.().catch(() => []) ?? [] : [],
  ]);
  const ranking = rankModels(strategy, { prices, benchmarks, logs, benchmarkAliases: env.benchmarkAliases });
  return { strategy, ...ranking };
}

/** The X-Valefront-Route header value: `<strategy>; model=<id>; reason=<short>` (reason=fallback after a failure). */
export function routeHeader(plan: RoutePlan, model: string): string {
  const reason = model === plan.models[0] ? plan.reason : 'fallback';
  return `${plan.strategy}; model=${model}; reason=${reason}`;
}

type RouterLike = {
  route(request: CompletionRequest, opts?: RouteOptions): Promise<CompletionResponse>;
  routeStream(request: CompletionRequest, opts?: RouteOptions): AsyncGenerator<StreamChunk, void, unknown>;
};

/**
 * Ask the router for each planned model in turn, as an explicitly named model, until one answers. `onModel` is told
 * which model answered (before the response is returned), for the route header.
 */
export async function routeByPlan(
  router: RouterLike,
  request: CompletionRequest,
  plan: RoutePlan,
  opts: RouteOptions | undefined,
  onModel?: (model: string) => void,
): Promise<CompletionResponse> {
  let lastError: unknown;
  for (const model of plan.models) {
    try {
      const response = await router.route({ ...request, model }, opts);
      onModel?.(model);
      return response;
    } catch (err) {
      lastError = err;
      console.warn(`[strategy] auto:${plan.strategy}: ${model} failed; trying the next model`, err instanceof Error ? err.message : err);
    }
  }
  throw lastError ?? new NoEligibleModelError(plan.strategy, false);
}

/**
 * Streaming counterpart: the next model is tried only when the previous one failed before its first chunk (a stream
 * already under way is never continued by another model). `onModel` runs before the first chunk is yielded.
 */
export async function* streamByPlan(
  router: RouterLike,
  request: CompletionRequest,
  plan: RoutePlan,
  opts: RouteOptions | undefined,
  onModel?: (model: string) => void,
): AsyncGenerator<StreamChunk, void, unknown> {
  let lastError: unknown;
  for (const model of plan.models) {
    let started = false;
    try {
      for await (const chunk of router.routeStream({ ...request, model }, opts)) {
        if (!started) {
          started = true;
          onModel?.(model);
        }
        yield chunk;
      }
      if (!started) onModel?.(model);
      return;
    } catch (err) {
      if (started) throw err;
      lastError = err;
      console.warn(`[strategy] auto:${plan.strategy}: ${model} failed; trying the next model`, err instanceof Error ? err.message : err);
    }
  }
  throw lastError ?? new NoEligibleModelError(plan.strategy, false);
}

/** A value kept for `ttlMs` (benchmarks, the request log), so a strategy doesn't read the store on every request. */
export class Memo<T> {
  private value: { at: number; data: T } | null = null;
  constructor(private readonly ttlMs: number) {}
  async get(load: () => Promise<T>, now = Date.now()): Promise<T> {
    if (this.value && now - this.value.at < this.ttlMs) return this.value.data;
    const data = await load();
    this.value = { at: now, data };
    return data;
  }
  clear(): void { this.value = null; }
}
