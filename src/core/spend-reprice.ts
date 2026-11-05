import { createHash } from 'crypto';
import { update, type DocStore, type KeyUsage, type MonthSpend, type Price, type SpendAdjustment, type SpendLine } from './issued-keys';

/**
 * Correcting recorded spend when requests were costed at the wrong price (a model with no price set falls back to
 * the deliberately high default). The log keeps only the last 200 requests, so requests can't be re-costed one by
 * one; but when the wrong and the right price differ by the same factor for input, output and cached input, every
 * recorded dollar for that model differs by exactly that factor. So a correction multiplies the matching lines of
 * the month's spend by it and takes the exact difference off the provider's line and the month's total.
 *
 * Per-key usage (usage/<keyId>/<month>) is kept by the model a key asked for (often "auto"), not the one that
 * served it, so it can't be split exactly: it's left as it is and the result says so per key.
 */

export type RepriceRequest = {
  month: string;
  provider: string;
  /** Exact served model id, or a prefix ending in "*". */
  model: string;
  from: Price;
  to: Price;
  /** Only these UTC dates (yyyy-mm-dd) were costed at `from`; unset: the whole month. */
  days?: string[];
  dryRun?: boolean;
};

export type RepriceLineChange = {
  /** "total", "byProvider/<provider>", "byModel/<provider>/<model>", or "byDay/<date>/<provider>/<model>". */
  line: string;
  before: number;
  after: number;
  requests?: number;
  tokens?: number;
  /** Dollars per million tokens before, to see which days were costed at which price. */
  usdPerMTokensBefore?: number;
};

export type RepriceResult = {
  adjustmentId: string;
  month: string;
  provider: string;
  model: string;
  ratio: number;
  dryRun: boolean;
  /** This exact correction was applied before: nothing changed. */
  alreadyApplied: boolean;
  usdDelta: number;
  lines: RepriceLineChange[];
  /** Per-key usage is left unchanged (it's recorded by the requested model). */
  keyUsage: Array<{ keyId: string; usd: number; note: 'not split by served model' }>;
};

export class RepriceRefused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const MONTH = /^\d{4}-\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Ratios this close (relative) are the same factor: 0.2×0.1 / (10×0.1) is 0.020000000000000004, not 0.02. */
const SAME = 1e-9;

function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

function price(p: unknown, name: string): Price {
  const o = p && typeof p === 'object' ? (p as Record<string, unknown>) : null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : NaN);
  const input = n(o?.input);
  const output = n(o?.output);
  if (!o || Number.isNaN(input) || Number.isNaN(output)) throw new RepriceRefused(400, `${name} must be a price: {"input": number, "output": number}`);
  const out: Price = { input, output };
  if (o.cachedInput !== undefined) {
    const c = n(o.cachedInput);
    if (Number.isNaN(c)) throw new RepriceRefused(400, `${name}.cachedInput must be a non-negative number`);
    out.cachedInput = c;
  }
  if (o.cacheCreationInput !== undefined) {
    const c = n(o.cacheCreationInput);
    if (Number.isNaN(c)) throw new RepriceRefused(400, `${name}.cacheCreationInput must be a non-negative number`);
    out.cacheCreationInput = c;
  }
  return out;
}

/** The one factor every component of the price changed by (defaults as costUsd applies them), or a refusal. */
export function priceRatio(from: Price, to: Price): number {
  const parts: Array<[string, number, number]> = [
    ['input', from.input, to.input],
    ['output', from.output, to.output],
    ['cachedInput', from.cachedInput ?? from.input * 0.1, to.cachedInput ?? to.input * 0.1],
    ['cacheCreationInput', from.cacheCreationInput ?? from.input * 1.25, to.cacheCreationInput ?? to.input * 1.25],
  ];
  let ratio: number | null = null;
  for (const [name, a, b] of parts) {
    if (a === 0) {
      if (b !== 0) throw new RepriceRefused(400, `from.${name} is 0 but to.${name} is not: recorded dollars can't be rescaled by one factor`);
      continue;
    }
    const r = b / a;
    if (ratio === null) ratio = r;
    else if (Math.abs(r - ratio) > SAME * Math.max(Math.abs(r), Math.abs(ratio))) {
      throw new RepriceRefused(400, `The prices aren't proportional (input ×${ratio}, ${name} ×${r}): recorded dollars can't be split by token type, so this can't be corrected exactly`);
    }
  }
  if (ratio === null) throw new RepriceRefused(400, 'from is all zeros: nothing to rescale');
  return ratio;
}

function matcher(model: string): (m: string) => boolean {
  const star = model.indexOf('*');
  if (star === -1) return (m) => m === model;
  if (star !== model.length - 1) throw new RepriceRefused(400, 'model must be an exact id or a prefix ending in "*"');
  const prefix = model.slice(0, -1);
  return (m) => m.startsWith(prefix);
}

type Plan = { req: Required<Omit<RepriceRequest, 'days' | 'dryRun'>> & { days?: string[] }; ratio: number; id: string };

/** Checks a request and works out its factor and its id (the same request always has the same id). */
export function planReprice(input: unknown, now: number): Plan {
  const b = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const month = typeof b.month === 'string' ? b.month : '';
  if (!MONTH.test(month)) throw new RepriceRefused(400, 'month must be yyyy-mm');
  const current = new Date(now).toISOString().slice(0, 7);
  if (month !== current && month !== previousMonth(current)) throw new RepriceRefused(400, `Only this month (${current}) or last month (${previousMonth(current)}) can be corrected`);
  const provider = typeof b.provider === 'string' ? b.provider.trim() : '';
  const model = typeof b.model === 'string' ? b.model.trim() : '';
  if (!provider) throw new RepriceRefused(400, 'provider is required');
  if (!model || model === '*') throw new RepriceRefused(400, 'model is required (an exact id or a prefix ending in "*")');
  matcher(model);
  const from = price(b.from, 'from');
  const to = price(b.to, 'to');
  let days: string[] | undefined;
  if (b.days !== undefined) {
    if (!Array.isArray(b.days) || b.days.length === 0 || !b.days.every((d) => typeof d === 'string' && DAY.test(d) && d.startsWith(`${month}-`))) {
      throw new RepriceRefused(400, `days must be a non-empty list of dates in ${month} (yyyy-mm-dd)`);
    }
    days = [...new Set(b.days as string[])].sort();
  }
  const ratio = priceRatio(from, to);
  const id = `adj_${createHash('sha256').update(JSON.stringify({ month, provider, model, from, to, days: days ?? null })).digest('hex').slice(0, 16)}`;
  return { req: { month, provider, model, from, to, ...(days ? { days } : {}) }, ratio, id };
}

const perM = (l: SpendLine) => (l.tokens > 0 ? (l.usd / l.tokens) * 1_000_000 : undefined);

/**
 * The month after the correction (a new object; `cur` is not changed), the lines it changes and the dollars it
 * takes off. Throws when an overlapping correction was already applied.
 */
export function applyReprice(cur: MonthSpend, plan: Plan, by: string, at: number): { next: MonthSpend; lines: RepriceLineChange[]; usdDelta: number; alreadyApplied: boolean } {
  const { req, ratio, id } = plan;
  if (cur.adjustments?.some((a) => a.id === id)) return { next: cur, lines: [], usdDelta: 0, alreadyApplied: true };
  const matches = matcher(req.model);
  const keys = Object.entries(cur.byModel ?? {}).filter(([, l]) => l.provider === req.provider && matches(l.model)).map(([k]) => k);
  if (keys.length === 0) throw new RepriceRefused(404, `No spend for ${req.provider}/${req.model} in ${req.month}`);
  for (const a of cur.adjustments ?? []) {
    const shared = a.lines.some((l) => keys.includes(l));
    const sameDays = !a.days || !req.days || a.days.some((d) => req.days!.includes(d));
    if (shared && sameDays) throw new RepriceRefused(409, `${a.id} already corrected these lines (${a.from.input}/${a.from.output} → ${a.to.input}/${a.to.output}); this would correct them twice`);
  }

  const lines: RepriceLineChange[] = [];
  const byModel = { ...(cur.byModel ?? {}) };
  const byDay = { ...(cur.byDay ?? {}) };
  let delta = 0;
  for (const key of keys) {
    let lineDelta = 0;
    for (const day of Object.keys(byDay).sort()) {
      const l = byDay[day]?.[key];
      if (!l || (req.days && !req.days.includes(day))) continue;
      const after = l.usd * ratio;
      byDay[day] = { ...byDay[day], [key]: { ...l, usd: after } };
      lines.push({ line: `byDay/${day}/${key}`, before: l.usd, after, requests: l.requests, tokens: l.tokens, usdPerMTokensBefore: perM(l) });
      lineDelta += l.usd - after;
    }
    const m = byModel[key];
    // The whole month: the model's line itself scales (older days may predate byDay). Some days: what those days lose.
    const after = req.days ? m.usd - lineDelta : m.usd * ratio;
    if (!req.days) lineDelta = m.usd - after;
    byModel[key] = { ...m, usd: after };
    lines.push({ line: `byModel/${key}`, before: m.usd, after, requests: m.requests, tokens: m.tokens, usdPerMTokensBefore: perM(m) });
    delta += lineDelta;
  }
  if (req.days && delta === 0) throw new RepriceRefused(404, `No spend for ${req.provider}/${req.model} on ${req.days.join(', ')}`);

  const byProvider = { ...(cur.byProvider ?? {}) };
  const p = byProvider[req.provider];
  if (p) {
    byProvider[req.provider] = { ...p, usd: p.usd - delta };
    lines.push({ line: `byProvider/${req.provider}`, before: p.usd, after: p.usd - delta });
  }
  lines.push({ line: 'total', before: cur.usd, after: cur.usd - delta });
  const adjustment: SpendAdjustment = {
    id, at, by, provider: req.provider, model: req.model, from: req.from, to: req.to, ratio, lines: keys,
    ...(req.days ? { days: req.days } : {}), usdDelta: delta,
  };
  const next: MonthSpend = { ...cur, usd: cur.usd - delta, byProvider, byModel, byDay, adjustments: [...(cur.adjustments ?? []), adjustment] };
  return { next, lines, usdDelta: delta, alreadyApplied: false };
}

/** Per-key usage this month: reported, not changed. */
async function keyUsage(store: DocStore, month: string): Promise<RepriceResult['keyUsage']> {
  const docs = (await store.list('usage/')).filter((k) => k.endsWith(`/${month}`));
  const out = await Promise.all(docs.map(async (k) => {
    const u = (await store.get<KeyUsage>(k))?.value;
    return u && (u.usd ?? 0) > 0 ? { keyId: k.slice('usage/'.length, -(month.length + 1)), usd: u.usd ?? 0, note: 'not split by served model' as const } : null;
  }));
  return out.filter((x): x is NonNullable<typeof x> => !!x);
}

/** Dry run: what would change. Otherwise: apply it to the month (read-modify-write) and record it, once. */
export async function repriceSpend(store: DocStore, input: unknown, opts: { by: string; now?: number }): Promise<RepriceResult> {
  const now = opts.now ?? Date.now();
  const plan = planReprice(input, now);
  const dryRun = (input as { dryRun?: unknown })?.dryRun !== false;
  const docKey = `spend/${plan.req.month}`;
  let outcome: ReturnType<typeof applyReprice>;
  if (dryRun) {
    const cur = (await store.get<MonthSpend>(docKey))?.value;
    if (!cur) throw new RepriceRefused(404, `No spend recorded for ${plan.req.month}`);
    outcome = applyReprice(cur, plan, opts.by, now);
  } else {
    let last: ReturnType<typeof applyReprice> | null = null;
    await update<MonthSpend>(store, docKey, (cur) => {
      if (!cur) throw new RepriceRefused(404, `No spend recorded for ${plan.req.month}`);
      last = applyReprice(cur, plan, opts.by, now);
      return last.next;
    });
    outcome = last!;
  }
  return {
    adjustmentId: plan.id,
    month: plan.req.month,
    provider: plan.req.provider,
    model: plan.req.model,
    ratio: plan.ratio,
    dryRun,
    alreadyApplied: outcome.alreadyApplied,
    usdDelta: outcome.usdDelta,
    lines: outcome.lines,
    keyUsage: await keyUsage(store, plan.req.month),
  };
}
