import type { RouteCandidate, RouteSelection, RoutingStrategy, RoutingWeights } from './types';

export const DEFAULT_ROUTING_WEIGHTS: RoutingWeights = { quality: 0.5, price: 0.25, speed: 0.25 };

function eligible(candidates: RouteCandidate[]): RouteCandidate[] {
  return candidates.filter(candidate => candidate.available && !candidate.breakerPaused);
}

function publishedPrice(candidate: RouteCandidate): number | undefined {
  if (!candidate.price) return undefined;
  const input = Number(candidate.price.input);
  const output = Number(candidate.price.output);
  return Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0
    ? input + output
    : undefined;
}

function description(candidate: RouteCandidate): string {
  return `${candidate.provider} ${candidate.model}`;
}

function rankBy<T>(candidates: RouteCandidate[], score: (candidate: RouteCandidate) => number): RouteCandidate[] {
  return [...candidates].sort((a, b) => score(a) - score(b) || a.order - b.order);
}

export function selectRoute(
  candidates: RouteCandidate[],
  strategy: RoutingStrategy = 'custom',
  weights: RoutingWeights = DEFAULT_ROUTING_WEIGHTS,
): RouteSelection[] {
  const available = eligible(candidates);
  if (!available.length) return [];

  if (strategy === 'custom') {
    return [...available]
      .sort((a, b) => a.order - b.order)
      .map(candidate => ({ candidate, strategy, reason: `custom order: ${description(candidate)}` }));
  }

  if (strategy === 'cheapest') {
    const priced = available.filter(candidate => publishedPrice(candidate) !== undefined);
    const ranked = rankBy(priced, candidate => publishedPrice(candidate)!);
    return ranked.map((candidate, index) => ({
      candidate,
      strategy,
      reason: `cheapest of ${priced.length} available: ${description(candidate)}${index === 0 ? ` ($${publishedPrice(candidate)!.toFixed(2)} combined published price per million tokens)` : ''}`,
    }));
  }

  if (strategy === 'fastest') {
    const measured = available.filter(candidate => candidate.latencyMs !== undefined || candidate.ttftMs !== undefined);
    const ranked = rankBy(
      measured.length ? measured : available,
      candidate => (candidate.latencyMs ?? Number.POSITIVE_INFINITY) + (candidate.ttftMs ?? 0),
    );
    return ranked.map((candidate, index) => ({
      candidate,
      strategy,
      reason: `fastest of ${measured.length || available.length} available: ${description(candidate)}${index === 0 && candidate.latencyMs !== undefined ? ` (${candidate.latencyMs}ms median latency)` : ''}`,
    }));
  }

  if (strategy === 'best') {
    const measured = available.filter(candidate => candidate.qualityScore !== undefined);
    const ranked = [...(measured.length ? measured : available)].sort((a, b) =>
      (b.qualityScore ?? Number.NEGATIVE_INFINITY) - (a.qualityScore ?? Number.NEGATIVE_INFINITY) || a.order - b.order);
    return ranked.map((candidate, index) => ({
      candidate,
      strategy,
      reason: `best of ${measured.length || available.length} available: ${description(candidate)}${index === 0 && candidate.qualityScore !== undefined ? ` (benchmark ${candidate.qualityScore})` : ''}`,
    }));
  }

  const qualityValues = available.map(candidate => candidate.qualityScore ?? 0);
  const priceValues = available
    .map(candidate => publishedPrice(candidate))
    .filter((value): value is number => value !== undefined);
  const speedValues = available
    .map(candidate => {
      const latency = candidate.latencyMs;
      const ttft = candidate.ttftMs;
      return latency !== undefined && Number.isFinite(latency)
        ? latency + (ttft !== undefined && Number.isFinite(ttft) ? ttft : 0)
        : Number.POSITIVE_INFINITY;
    });
  const normalize = (value: number, values: number[], invert = false): number => {
    const finite = values.filter((entry): entry is number => Number.isFinite(entry));
    if (!finite.length || !Number.isFinite(value)) return 0;
    const min = Math.min(...finite);
    const max = Math.max(...finite);
    if (max === min) return 1;
    const normalized = (value - min) / (max - min);
    return invert ? 1 - normalized : normalized;
  };
  const ranked = [...available].sort((a, b) => {
    const score = (candidate: RouteCandidate) =>
      weights.quality * normalize(candidate.qualityScore ?? 0, qualityValues)
      + weights.price * normalize(publishedPrice(candidate) ?? Number.POSITIVE_INFINITY, priceValues, true)
      + weights.speed * normalize(
        (candidate.latencyMs ?? Number.POSITIVE_INFINITY) + (candidate.ttftMs ?? 0),
        speedValues,
        true,
      );
    return score(b) - score(a) || a.order - b.order;
  });

  return ranked.map((candidate, index) => ({
    candidate,
    strategy,
    reason: `balanced (${weights.quality} quality, ${weights.price} price, ${weights.speed} speed): ${description(candidate)}${index === 0 ? ' selected by weighted score' : ''}`,
  }));
}

