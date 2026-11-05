export type Price = {
  input: number;
  output: number;
  cached?: number;
};

export type SpendLine = {
  usd: number;
  provider?: string;
  model?: string;
};

export type KeySpend = {
  usd: number;
  byModel?: Record<string, { usd?: number; [key: string]: unknown }>;
};

export type RepriceInput = {
  month: string;
  provider: string;
  model: string;
  from: Price;
  to: Price;
  dryRun: boolean;
  now?: Date;
};

export type RepriceDocument = {
  month: string;
  usd: number;
  byProvider?: Record<string, number>;
  byModel?: Record<string, SpendLine>;
  byDay?: Record<string, Record<string, SpendLine>>;
  adjustments?: Array<{ id: string; by: string; at: string; details: unknown }>;
};

export type RepriceResult = {
  ratio: number;
  alreadyApplied: boolean;
  changed: boolean;
  before: RepriceDocument;
  after: RepriceDocument;
  keys: Array<{ id: string; before: KeySpend; after: KeySpend; supported: boolean; reason?: string }>;
};

function priceNumber(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('Prices must be finite non-negative numbers');
  return n;
}

function ratio(from: Price, to: Price): number {
  const pairs = [
    [priceNumber(from.input), priceNumber(to.input)],
    [priceNumber(from.output), priceNumber(to.output)],
    [priceNumber(from.cached ?? from.input * 0.1), priceNumber(to.cached ?? to.input * 0.1)],
  ];
  const ratios = pairs
    .filter(([a]) => a !== 0)
    .map(([a, b]) => b / a);
  if (!ratios.length || ratios.some((r) => !Number.isFinite(r) || r <= 0) || ratios.some((r) => Math.abs(r - ratios[0]) > 1e-12)) {
    throw new Error('from and to prices must have the same input, output, and cached ratio');
  }
  return ratios[0];
}

function matches(line: SpendLine | undefined, provider: string, model: string): boolean {
  return Boolean(line && line.provider === provider && (model.endsWith('*') ? line.model?.startsWith(model.slice(0, -1)) : line.model === model));
}

function scale(value: number, factor: number): number {
  return Math.round(value * factor * 100) / 100;
}

export function calculateReprice(
  input: RepriceInput,
  document: RepriceDocument,
  keys: Array<{ id: string; usage: KeySpend }>,
  actor: string,
): RepriceResult {
  const now = input.now ?? new Date();
  const current = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const previousDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const previous = `${previousDate.getUTCFullYear()}-${String(previousDate.getUTCMonth() + 1).padStart(2, '0')}`;
  if (input.month !== current && input.month !== previous) throw new Error('Only the current and previous month can be repriced');
  const factor = ratio(input.from, input.to);
  const id = `${input.month}:${input.provider}:${input.model}:${factor}`;
  if (document.adjustments?.some((adjustment) => adjustment.id === id)) {
    return { ratio: factor, alreadyApplied: true, changed: false, before: document, after: document, keys: [] };
  }

  const before = structuredClone(document);
  const after = structuredClone(document);
  const matching = Object.entries(after.byModel ?? {}).filter(([, line]) => matches(line, input.provider, input.model));
  const difference = matching.reduce((sum, [, line]) => sum + line.usd - scale(line.usd, factor), 0);
  for (const [key, line] of matching) {
    after.byModel![key] = { ...line, usd: scale(line.usd, factor) };
  }
  after.usd = Math.round((after.usd - difference) * 100) / 100;
  if (after.byProvider?.[input.provider] !== undefined) after.byProvider[input.provider] = Math.round((after.byProvider[input.provider] - difference) * 100) / 100;
  for (const day of Object.values(after.byDay ?? {})) {
    for (const line of Object.values(day)) {
      if (matches(line, input.provider, input.model)) line.usd = scale(line.usd, factor);
    }
  }

  const resultKeys = keys.map(({ id: keyId, usage }) => {
    const keyBefore = structuredClone(usage);
    const keyAfter = structuredClone(usage);
    const modelLines = Object.entries(keyAfter.byModel ?? {}).filter(([model]) => model === input.model || (input.model.endsWith('*') && model.startsWith(input.model.slice(0, -1))));
    if (!modelLines.length) return { id: keyId, before: keyBefore, after: keyAfter, supported: false, reason: 'per-key usage has no matching model split' };
    let keyDifference = 0;
    for (const [, line] of modelLines) {
      const old = line.usd ?? 0;
      line.usd = scale(old, factor);
      keyDifference += old - line.usd;
    }
    keyAfter.usd = Math.round((keyAfter.usd - keyDifference) * 100) / 100;
    return { id: keyId, before: keyBefore, after: keyAfter, supported: true };
  });

  if (!input.dryRun) {
    after.adjustments = [...(after.adjustments ?? []), { id, by: actor, at: now.toISOString(), details: { provider: input.provider, model: input.model, factor } }];
  }
  return { ratio: factor, alreadyApplied: false, changed: difference !== 0, before, after: input.dryRun ? before : after, keys: input.dryRun ? resultKeys.map((key) => ({ ...key, after: key.before })) : resultKeys };
}