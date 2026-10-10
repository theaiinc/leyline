import { createHash, randomBytes } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

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
  /** Model ids (or glob patterns like "gemini-*") this key may use; unset: every model offered. */
  models?: string[] | null;
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
  /** Requests per day (yyyy-mm-dd), for the daily cap. */
  days: Record<string, number>;
  byModel: Record<string, { requests: number; tokens: number }>;
};

export interface DocStore {
  get<T>(key: string): Promise<{ value: T; gen: string } | null>;
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
  private token: { value: string; until: number } | null = null;
  constructor(private readonly bucket: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async auth(): Promise<string> {
    if (this.token && Date.now() < this.token.until) return this.token.value;
    const res = await this.fetchImpl('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
    if (!res.ok) throw new Error(`metadata token: ${res.status}`);
    const t = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: t.access_token, until: Date.now() + (t.expires_in - 60) * 1000 };
    return t.access_token;
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
    const cur = await store.get<T>(key);
    const next = fn(cur ? cur.value : null);
    try {
      await store.put(key, next, cur ? cur.gen : '0');
      return next;
    } catch (err) {
      if (!(err instanceof Conflict) || i >= tries) throw err;
    }
  }
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

  constructor(private readonly store: DocStore, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
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
  async admit(key: IssuedKey, model: string): Promise<Refusal | null> {
    if (key.revokedAt) return { status: 401, code: 'key_revoked', message: 'This API key has been revoked.' };
    if (model && model !== 'auto' && !modelAllowed(key.caps, model)) {
      return { status: 403, code: 'model_not_allowed', message: `This key may not use the model "${model}".` };
    }
    const now = this.now();
    if (key.caps.requestsPerMinute) {
      const window = (this.minute.get(key.id) ?? []).filter((t) => now - t < 60_000);
      if (window.length >= key.caps.requestsPerMinute) {
        this.minute.set(key.id, window);
        return { status: 429, code: 'rate_limited', message: `This key is limited to ${key.caps.requestsPerMinute} requests a minute.` };
      }
      window.push(now);
      this.minute.set(key.id, window);
    }
    if (key.caps.tokensPerMonth || key.caps.requestsPerDay) {
      const u = await this.usage(key.id);
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
  async record(key: IssuedKey, model: string, usage?: { prompt_tokens?: number; completion_tokens?: number }): Promise<void> {
    const now = this.now();
    const month = monthOf(now);
    const prompt = Math.max(0, Math.round(usage?.prompt_tokens ?? 0));
    const completion = Math.max(0, Math.round(usage?.completion_tokens ?? 0));
    await update<KeyUsage>(this.store, `usage/${key.id}/${month}`, (cur) => {
      const u = cur ?? emptyUsage(month);
      u.requests++;
      u.promptTokens += prompt;
      u.completionTokens += completion;
      const d = dayOf(now);
      u.days[d] = (u.days[d] ?? 0) + 1;
      const m = (u.byModel[model || 'unknown'] ??= { requests: 0, tokens: 0 });
      m.requests++;
      m.tokens += prompt + completion;
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

export function cleanCaps(c: KeyCaps): KeyCaps {
  const models = Array.isArray(c.models) ? c.models.map((m) => String(m).trim()).filter(Boolean).slice(0, 50) : null;
  return {
    tokensPerMonth: positive(c.tokensPerMonth),
    requestsPerDay: positive(c.requestsPerDay),
    requestsPerMinute: positive(c.requestsPerMinute),
    models: models && models.length ? models : null,
  };
}
