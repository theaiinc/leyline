import { createHash, randomBytes } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { GcpToken } from './gcp';
import { cleanAlertSettings, type AlertSettings } from './alerts';

/**
 * API keys handed out to people for their coding agents (hosted Leyline). The owner creates each key with its caps
 * on the admin page; only a hash of the key is kept, so a key is shown once, when it's made.
 *
 * Caps (any may be unset = no limit): tokens a month (prompt + completion, calendar month UTC), requests a day,
 * requests a minute, and which models the key may ask for. Usage per key and month is stored next to the keys, so
 * caps hold across restarts and instances; the per-minute window is per instance (in memory).
 *
 * Store layout (JSON documents): keys/{id}, hashes/{sha256} -> id, usage/{id}/{yyyy-mm}.
 */

export type KeyCaps = {
  tokensPerMonth?: number | null;
  requestsPerDay?: number | null;
  requestsPerMinute?: number | null;
  /** US dollars a month this key may spend (at the prices set on the dashboard). */
  usdPerMonth?: number | null;
  /** Model ids (or glob patterns like "gemini-*") this key may use; unset: every model offered. */
  models?: string[] | null;
  /** Request-scoped PII handling; omitted means disabled for existing keys. */
  piiRedaction?: 'off' | 'regex' | 'presidio';
  /** Regexes whose matches must remain usable by operational tools. */
  piiAllowlist?: string[] | null;
};

export type IssuedKey = {
  id: string;
  name: string;
  /** The first characters, to tell keys apart in the list (ll_ab12…). */
  prefix: string;
  hash: string;
  caps: KeyCaps;
  note?: string;
  createdAt: number;
  createdBy: string;
  revokedAt?: number | null;
  lastUsedAt?: number | null;
};

export type KeyUsage = {
  month: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  /** What it cost, in US dollars, at the prices set at the time. */
  usd?: number;
  /** Requests per day (yyyy-mm-dd), for the daily cap. */
  days: Record<string, number>;
  byModel: Record<string, { requests: number; tokens: number; usd?: number }>;
};

/** Spend, requests and tokens for one provider or model. */
export type SpendLine = { usd: number; requests: number; tokens: number; cachedTokens?: number };

/** Everything spent this month, across keys (and the owner's playground), by provider and by model. */
export type MonthSpend = {
  month: string;
  usd: number;
  requests: number;
  tokens?: number;
  byProvider?: Record<string, SpendLine>;
  /** Keyed "provider/model": the model that answered and the provider that served it. */
  byModel?: Record<string, SpendLine & { provider: string; model: string }>;
  /** Daily spend keyed by UTC date, then by provider/model. Older months may not have this field. */
  byDay?: Record<string, Record<string, SpendLine>>;
};

export interface DocStore {
  get<T>(key: string): Promise<{ value: T; gen: string } | null>;
  /** The current version, where get() may read a replica that lags (for compare-and-set). */
  getPrimary?<T>(key: string): Promise<{ value: T; gen: string } | null>;
  /** Write; with ifGen, only if the document is at that generation ('0': must not exist). */
  put(key: string, value: unknown, ifGen?: string): Promise<string>;
  list(prefix: string): Promise<string[]>;
}

export class Conflict extends Error {}

export class MemoryDocStore implements DocStore {
  private readonly docs = new Map<string, { value: string; gen: number }>();
  private seq = 0;
  async get<T>(key: string) {
    const d = this.docs.get(key);
    return d ? { value: JSON.parse(d.value) as T, gen: String(d.gen) } : null;
  }
  async put(key: string, value: unknown, ifGen?: string) {
    const cur = this.docs.get(key);
    if (ifGen !== undefined && (cur ? String(cur.gen) : '0') !== ifGen) throw new Conflict(key);
    const gen = ++this.seq;
    this.docs.set(key, { value: JSON.stringify(value), gen });
    return String(gen);
  }
  async list(prefix: string) {
    return [...this.docs.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

/** A directory of JSON files (local development). Generations are a counter in the file. */
export class FileDocStore implements DocStore {
  constructor(private readonly dir: string) {}
  private path(key: string) {
    return join(this.dir, `${key}.json`);
  }
  async get<T>(key: string) {
    try {
      const d = JSON.parse(await readFile(this.path(key), 'utf8')) as { value: T; gen: number };
      return { value: d.value, gen: String(d.gen) };
    } catch {
      return null;
    }
  }
  async put(key: string, value: unknown, ifGen?: string) {
    const cur = await this.get(key);
    if (ifGen !== undefined && (cur?.gen ?? '0') !== ifGen) throw new Conflict(key);
    const gen = Number(cur?.gen ?? 0) + 1;
    await mkdir(dirname(this.path(key)), { recursive: true });
    await writeFile(this.path(key), JSON.stringify({ value, gen }));
    return String(gen);
  }
  async list(prefix: string) {
    const { readdir } = await import('fs/promises');
    const out: string[] = [];
    const walk = async (rel: string) => {
      let entries: Array<{ name: string; isDirectory(): boolean }> = [];
      try {
        entries = await readdir(join(this.dir, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(r);
        else if (r.endsWith('.json')) out.push(r.slice(0, -5));
      }
    };
    await walk('');
    return out.filter((k) => k.startsWith(prefix)).sort();
  }
}

/** Cloud Storage, with generation preconditions; the token comes from the Cloud Run metadata server. */
export class GcsDocStore implements DocStore {
  private readonly token: GcpToken;
  constructor(private readonly bucket: string, private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {
    this.token = new GcpToken(fetchImpl);
  }

  private auth(): Promise<string> {
    return this.token.get();
  }

  private name(key: string) {
    return encodeURIComponent(`${key}.json`);
  }

  async get<T>(key: string) {
    const res = await this.fetchImpl(`https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/${this.name(key)}?alt=media`, { headers: { Authorization: `Bearer ${await this.auth()}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`gcs get ${key}: ${res.status}`);
    return { value: (await res.json()) as T, gen: res.headers.get('x-goog-generation') ?? '1' };
  }

  async put(key: string, value: unknown, ifGen?: string) {
    const q = new URLSearchParams({ uploadType: 'media', name: `${key}.json`, ...(ifGen !== undefined ? { ifGenerationMatch: ifGen } : {}) });
    const res = await this.fetchImpl(`https://storage.googleapis.com/upload/storage/v1/b/${this.bucket}/o?${q}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.auth()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    if (res.status === 412) throw new Conflict(key);
    if (!res.ok) throw new Error(`gcs put ${key}: ${res.status}`);
    return String(((await res.json()) as { generation?: string }).generation ?? '1');
  }

  async list(prefix: string) {
    const out: string[] = [];
    let page: string | undefined;
    do {
      const q = new URLSearchParams({ prefix, fields: 'items(name),nextPageToken', ...(page ? { pageToken: page } : {}) });
      const res = await this.fetchImpl(`https://storage.googleapis.com/storage/v1/b/${this.bucket}/o?${q}`, { headers: { Authorization: `Bearer ${await this.auth()}` } });
      if (!res.ok) throw new Error(`gcs list ${prefix}: ${res.status}`);
      const body = (await res.json()) as { items?: Array<{ name: string }>; nextPageToken?: string };
      for (const i of body.items ?? []) out.push(i.name.replace(/\.json$/, ''));
      page = body.nextPageToken;
    } while (page);
    return out;
  }
}

/** Read-modify-write a document, retrying when someone else wrote it in between. */
export async function update<T>(store: DocStore, key: string, fn: (cur: T | null) => T, tries = 5): Promise<T> {
  for (let i = 0; ; i++) {
    const cur = await (store.getPrimary ? store.getPrimary<T>(key) : store.get<T>(key));
    const next = fn(cur ? cur.value : null);
    try {
      await store.put(key, next, cur ? cur.gen : '0');
      return next;
    } catch (err) {
      if (!(err instanceof Conflict) || i >= tries) throw err;
    }
  }
}

export type HostedSettings = {
  /** Model ids (or patterns with *) offered; empty: whatever the router can serve. */
  models: string[];
  /** Requested model (exact or pattern with *) -> the model actually used. */
  aliases: Record<string, string>;
  /** Turned off for every key: model ids or patterns with * (checked on the model asked for and the one it maps to). */
  blockedModels?: string[];
  /** The most all keys together may spend a month, in US dollars; null: no limit. */
  monthlyBudgetUsd: number | null;
  /**
   * The most one provider may be paid a month, in US dollars, by provider name ("Anthropic": 100). A provider
   * at its limit gets no more requests this month: they go to another provider serving the model, or are
   * refused when there's none.
   */
  providerBudgetsUsd?: Record<string, number>;
  /** US dollars per million tokens, by model id or pattern with * (the model actually used). */
  prices: Record<string, Price>;
  /** For models with no price: deliberately high, so a limit errs on the safe side. */
  defaultPrice: Price;
  /** Use the prices providers publish (llmapi.ai, OpenRouter) for models without one set here. Default on. */
  usePublishedPrices?: boolean;
  /** Cost alerts: thresholds and where they go (src/core/alerts.ts). */
  alerts?: AlertSettings;
  updatedAt?: number;
  updatedBy?: string;
};

export type Price = { input: number; output: number; cachedInput?: number; cacheCreationInput?: number };
export const DEFAULT_PRICE: Price = { input: 10, output: 40 };

function cleanPrice(p: unknown): Price | null {
  const o = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
  const input = Number(o.input);
  const output = Number(o.output);
  return Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0 ? { input, output } : null;
}

export function cleanSettings(input: Partial<HostedSettings> | null | undefined): HostedSettings {
  const models = Array.isArray(input?.models) ? [...new Set(input!.models.map((m) => String(m).trim()).filter(Boolean))].slice(0, 200) : [];
  const aliases: Record<string, string> = {};
  for (const [from, to] of Object.entries(input?.aliases && typeof input.aliases === 'object' ? input.aliases : {})) {
    const a = String(from).trim();
    const b = typeof to === 'string' ? to.trim() : '';
    if (a && b) aliases[a] = b;
  }
  const prices: Record<string, Price> = {};
  for (const [m, p] of Object.entries(input?.prices && typeof input.prices === 'object' ? input.prices : {})) {
    const price = cleanPrice(p);
    if (m.trim() && price) prices[m.trim()] = price;
  }
  const budget = Number(input?.monthlyBudgetUsd);
  const providerBudgetsUsd: Record<string, number> = {};
  for (const [name, limit] of Object.entries(input?.providerBudgetsUsd && typeof input.providerBudgetsUsd === 'object' ? input.providerBudgetsUsd : {})) {
    const usd = Number(limit);
    if (String(name).trim() && Number.isFinite(usd) && usd > 0) providerBudgetsUsd[String(name).trim()] = Math.round(usd * 100) / 100;
  }
  const blockedModels = Array.isArray(input?.blockedModels)
    ? [...new Set(input!.blockedModels.map((m) => String(m).trim()).filter(Boolean))].slice(0, 200)
    : [];
  return {
    models,
    aliases,
    blockedModels,
    monthlyBudgetUsd: input?.monthlyBudgetUsd === null || input?.monthlyBudgetUsd === undefined || !Number.isFinite(budget) || budget <= 0 ? null : Math.round(budget * 100) / 100,
    providerBudgetsUsd,
    prices,
    defaultPrice: cleanPrice(input?.defaultPrice) ?? DEFAULT_PRICE,
    usePublishedPrices: input?.usePublishedPrices !== false,
    alerts: cleanAlertSettings(input?.alerts),
  };
}

/** A price set by hand for a model: exact id, else the first matching pattern. */
export function manualPriceOf(prices: Record<string, Price>, model: string): Price | undefined {
  if (prices[model]) return prices[model];
  for (const [p, price] of Object.entries(prices)) {
    if (p.includes('*') && modelAllowed({ models: [p] }, model)) return price;
  }
  return undefined;
}

/** The price for a model: set by hand, else what the serving provider publishes, else the default. */
export function priceOf(settings: Pick<HostedSettings, 'prices' | 'defaultPrice'>, model: string, published?: Price): Price {
  return manualPriceOf(settings.prices, model) ?? published ?? settings.defaultPrice;
}

export function costUsd(price: Price, usage: { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number; cache_creation_input_tokens?: number } | undefined): number {
  const prompt = Math.max(0, usage?.prompt_tokens ?? 0);
  const cached = Math.min(prompt, Math.max(0, usage?.cached_tokens ?? 0));
  const cacheCreation = Math.max(0, usage?.cache_creation_input_tokens ?? 0);
  const cachedInput = price.cachedInput ?? price.input * 0.1;
  const cacheCreationInput = price.cacheCreationInput ?? price.input * 1.25;
  return (((prompt - cached) * price.input) + (cached * cachedInput) + (cacheCreation * cacheCreationInput) + ((usage?.completion_tokens ?? 0) * price.output)) / 1_000_000;
}

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');
const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Whether a model id matches a cap's list (exact, or a pattern with *). */
export function modelAllowed(caps: KeyCaps, model: string): boolean {
  if (!caps.models || caps.models.length === 0) return true;
  return caps.models.some((p) => (p.includes('*') ? new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(model) : p.toLowerCase() === model.toLowerCase()));
}

export type Refusal = { status: number; code: string; message: string };

export class IssuedKeys {
  private readonly cache = new Map<string, { key: IssuedKey | null; at: number }>();
  private readonly minute = new Map<string, number[]>();
  private readonly now: () => number;

  private readonly sharedMinute: boolean;

  /**
   * sharedMinute: count requests a minute in the store (a fixed one-minute window) instead of in memory, for
   * hosts that run many short-lived instances (Cloudflare Workers).
   */
  constructor(private readonly store: DocStore, opts: { now?: () => number; sharedMinute?: boolean } = {}) {
    this.now = opts.now ?? Date.now;
    this.sharedMinute = opts.sharedMinute ?? false;
  }

  /** The store keys live in (cost alerts keep their state next to them). */
  get docs(): DocStore {
    return this.store;
  }

  /** What hosted Leyline offers (set on the dashboard; null until first saved, then env defaults apply). */
  async settings(): Promise<HostedSettings | null> {
    return (await this.store.get<HostedSettings>('settings/hosted'))?.value ?? null;
  }

  async saveSettings(input: HostedSettings, by: string): Promise<HostedSettings> {
    const clean = cleanSettings(input);
    const saved = { ...clean, updatedAt: this.now(), updatedBy: by };
    await update<HostedSettings>(this.store, 'settings/hosted', () => saved);
    return saved;
  }

  /** Make a key: returns the key itself (shown once) and its record. */
  async create(input: { name: string; caps?: KeyCaps; note?: string; by: string }): Promise<{ key: string; record: IssuedKey }> {
    const name = input.name.trim().slice(0, 80);
    if (!name) throw new Error('a name is required');
    const key = `ll_${randomBytes(24).toString('base64url')}`;
    const record: IssuedKey = {
      id: `key_${randomBytes(8).toString('hex')}`,
      name,
      prefix: key.slice(0, 7),
      hash: hashKey(key),
      caps: cleanCaps(input.caps ?? {}),
      ...(input.note ? { note: input.note.slice(0, 300) } : {}),
      createdAt: this.now(),
      createdBy: input.by,
      revokedAt: null,
      lastUsedAt: null,
    };
    await this.store.put(`hashes/${record.hash}`, { id: record.id }, '0');
    await this.store.put(`keys/${record.id}`, record, '0');
    return { key, record };
  }

  async list(): Promise<Array<IssuedKey & { usage: KeyUsage }>> {
    const ids = (await this.store.list('keys/')).map((k) => k.slice('keys/'.length));
    const out = await Promise.all(ids.map(async (id) => {
      const record = (await this.store.get<IssuedKey>(`keys/${id}`))?.value;
      return record ? { ...record, usage: await this.usage(id) } : null;
    }));
    return out.filter((x): x is IssuedKey & { usage: KeyUsage } => !!x).sort((a, b) => b.createdAt - a.createdAt);
  }

  async get(id: string): Promise<IssuedKey | null> {
    return (await this.store.get<IssuedKey>(`keys/${id}`))?.value ?? null;
  }

  async setCaps(id: string, caps: KeyCaps): Promise<IssuedKey> {
    const out = await update<IssuedKey>(this.store, `keys/${id}`, (cur) => {
      if (!cur) throw new Error(`no key ${id}`);
      return { ...cur, caps: cleanCaps(caps) };
    });
    this.cache.clear();
    return out;
  }

  async revoke(id: string): Promise<IssuedKey> {
    const out = await update<IssuedKey>(this.store, `keys/${id}`, (cur) => {
      if (!cur) throw new Error(`no key ${id}`);
      return { ...cur, revokedAt: cur.revokedAt ?? this.now() };
    });
    this.cache.clear();
    return out;
  }

  async usage(id: string, month = monthOf(this.now())): Promise<KeyUsage> {
    return (await this.store.get<KeyUsage>(`usage/${id}/${month}`))?.value ?? emptyUsage(month);
  }

  /** The key a request presented (cached briefly), or null. */
  async lookup(presented: string): Promise<IssuedKey | null> {
    if (!presented.startsWith('ll_')) return null;
    const h = hashKey(presented);
    const hit = this.cache.get(h);
    if (hit && this.now() - hit.at < 30_000) return hit.key;
    const ref = (await this.store.get<{ id: string }>(`hashes/${h}`))?.value;
    const key = ref ? await this.get(ref.id) : null;
    this.cache.set(h, { key, at: this.now() });
    return key;
  }

  /** Whether this key may make a request for `model` now (and counts it against the per-minute window). */
  /** This month's spend across keys. */
  async spend(month = monthOf(this.now())): Promise<MonthSpend> {
    return (await this.store.get<MonthSpend>(`spend/${month}`))?.value ?? { month, usd: 0, requests: 0 };
  }

  /** Months with recorded spend, newest first. */
  async spendMonths(): Promise<string[]> {
    return (await this.store.list('spend/')).map((k) => k.slice('spend/'.length)).sort().reverse();
  }

  async admit(key: IssuedKey, model: string, budgetUsd: number | null = null): Promise<Refusal | null> {
    if (key.revokedAt) return { status: 401, code: 'key_revoked', message: 'This API key has been revoked.' };
    if (model && model !== 'auto' && model !== 'auto-vision' && !modelAllowed(key.caps, model)) {
      return { status: 403, code: 'model_not_allowed', message: `This key may not use the model "${model}".` };
    }
    const now = this.now();
    // The reads below don't depend on each other: start them together (each is a D1 round trip when hosted).
    const spending = budgetUsd !== null ? this.spend() : null;
    const using = key.caps.tokensPerMonth || key.caps.requestsPerDay || key.caps.usdPerMonth ? this.usage(key.id) : null;
    spending?.catch(() => undefined);
    using?.catch(() => undefined);
    if (key.caps.requestsPerMinute && this.sharedMinute) {
      const limit = key.caps.requestsPerMinute;
      let over = false;
      await update<{ n: number }>(this.store, `rpm/${key.id}/${new Date(now).toISOString().slice(0, 16)}`, (cur) => {
        over = (cur?.n ?? 0) >= limit;
        return { n: (cur?.n ?? 0) + (over ? 0 : 1) };
      });
      if (over) return { status: 429, code: 'rate_limited', message: `This key is limited to ${limit} requests a minute.` };
    } else if (key.caps.requestsPerMinute) {
      const window = (this.minute.get(key.id) ?? []).filter((t) => now - t < 60_000);
      if (window.length >= key.caps.requestsPerMinute) {
        this.minute.set(key.id, window);
        return { status: 429, code: 'rate_limited', message: `This key is limited to ${key.caps.requestsPerMinute} requests a minute.` };
      }
      window.push(now);
      this.minute.set(key.id, window);
    }
    if (spending && (await spending).usd >= budgetUsd!) {
      return { status: 429, code: 'budget_exhausted', message: 'This service has reached its spending limit for the month; it resets on the 1st (UTC).' };
    }
    if (key.caps.tokensPerMonth || key.caps.requestsPerDay || key.caps.usdPerMonth) {
      const u = await using!;
      if (key.caps.usdPerMonth && (u.usd ?? 0) >= key.caps.usdPerMonth) {
        return { status: 429, code: 'monthly_spend_exhausted', message: `This key has used its $${key.caps.usdPerMonth} for this month.` };
      }
      if (key.caps.tokensPerMonth && u.promptTokens + u.completionTokens >= key.caps.tokensPerMonth) {
        return { status: 429, code: 'monthly_tokens_exhausted', message: `This key has used its ${key.caps.tokensPerMonth.toLocaleString('en-US')} tokens for this month.` };
      }
      if (key.caps.requestsPerDay && (u.days[dayOf(now)] ?? 0) >= key.caps.requestsPerDay) {
        return { status: 429, code: 'daily_requests_exhausted', message: `This key is limited to ${key.caps.requestsPerDay} requests a day.` };
      }
    }
    return null;
  }

  /** Count a finished request against the key. */
  async record(
    key: IssuedKey | null,
    model: string,
    usage?: { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number },
    usd = 0,
    served: { provider: string; model: string } = { provider: 'unknown', model },
  ): Promise<void> {
    const now = this.now();
    const month = monthOf(now);
    const prompt = Math.max(0, Math.round(usage?.prompt_tokens ?? 0));
    const completion = Math.max(0, Math.round(usage?.completion_tokens ?? 0));
    const cached = Math.min(prompt, Math.max(0, Math.round(usage?.cached_tokens ?? 0)));
    const tokens = prompt + completion;
    const add = (line: SpendLine | undefined): SpendLine => ({
      usd: (line?.usd ?? 0) + usd,
      requests: (line?.requests ?? 0) + 1,
      tokens: (line?.tokens ?? 0) + tokens,
      ...(cached || line?.cachedTokens ? { cachedTokens: (line?.cachedTokens ?? 0) + cached } : {}),
    });
    await update<MonthSpend>(this.store, `spend/${month}`, (cur) => {
      const s = cur ?? { month, usd: 0, requests: 0 };
      const byProvider = { ...(s.byProvider ?? {}) };
      byProvider[served.provider] = add(byProvider[served.provider]);
      const byModel = { ...(s.byModel ?? {}) };
      const id = `${served.provider}/${served.model || 'unknown'}`;
      byModel[id] = { ...add(byModel[id]), provider: served.provider, model: served.model || 'unknown' };
      const byDay = { ...(s.byDay ?? {}) };
      const day = dayOf(now);
      byDay[day] = { ...(byDay[day] ?? {}) };
      byDay[day][id] = add(byDay[day][id]);
      return { month, usd: s.usd + usd, requests: s.requests + 1, tokens: (s.tokens ?? 0) + tokens, byProvider, byModel, byDay };
    });
    if (!key) return;
    await update<KeyUsage>(this.store, `usage/${key.id}/${month}`, (cur) => {
      const u = cur ?? emptyUsage(month);
      u.requests++;
      u.promptTokens += prompt;
      u.completionTokens += completion;
      u.usd = (u.usd ?? 0) + usd;
      const d = dayOf(now);
      u.days[d] = (u.days[d] ?? 0) + 1;
      const m = (u.byModel[model || 'unknown'] ??= { requests: 0, tokens: 0 });
      m.requests++;
      m.tokens += prompt + completion;
      m.usd = (m.usd ?? 0) + usd;
      return u;
    });
    // Last used: at most once a minute per key, to keep writes down.
    if (!key.lastUsedAt || now - key.lastUsedAt > 60_000) {
      key.lastUsedAt = now;
      await update<IssuedKey>(this.store, `keys/${key.id}`, (cur) => {
        if (!cur) throw new Error('key gone');
        return { ...cur, lastUsedAt: now };
      }).catch(() => undefined);
    }
  }
}

function emptyUsage(month: string): KeyUsage {
  return { month, requests: 0, promptTokens: 0, completionTokens: 0, days: {}, byModel: {} };
}

function positive(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function dollars(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

export function cleanCaps(c: KeyCaps): KeyCaps {
  const models = Array.isArray(c.models) ? c.models.map((m) => String(m).trim()).filter(Boolean).slice(0, 50) : null;
  const piiRedaction = c.piiRedaction === 'regex' || c.piiRedaction === 'presidio' || c.piiRedaction === 'off'
    ? c.piiRedaction
    : undefined;
  const piiAllowlist = Array.isArray(c.piiAllowlist)
    ? c.piiAllowlist.map((p) => String(p).trim()).filter(Boolean).slice(0, 50)
    : null;
  return {
    tokensPerMonth: positive(c.tokensPerMonth),
    requestsPerDay: positive(c.requestsPerDay),
    requestsPerMinute: positive(c.requestsPerMinute),
    usdPerMonth: dollars(c.usdPerMonth),
    models: models && models.length ? models : null,
    ...(piiRedaction ? { piiRedaction } : {}),
    piiAllowlist,
  };
}
