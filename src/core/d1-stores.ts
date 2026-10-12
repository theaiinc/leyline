import { Conflict, type DocStore } from './issued-keys';
import type { LogEntry } from './logger';
import { ArcanaCloudFallbackSecretStore, ArcanaCloudSecretStore, type ApiKeySource, type ArcanaCloudConfig, type SecretStore, type SecretStoreStatus } from './secret-store';

/**
 * Storage for Leyline on Cloudflare Workers, in one D1 database (migrations in worker/migrations):
 * - D1DocStore: issued keys, usage, offered models (the DocStore the key store expects, with generations).
 * - D1SecretStore: provider keys and dashboard settings, encrypted with AES-GCM under LEYLINE_STORE_KEY.
 * - D1LogStore: the recent request log the dashboard's Activity page shows.
 * Only the slice of D1's API used here is typed, so this compiles without the Workers types.
 */
export interface D1Result<T = unknown> { results?: T[]; meta: { changes?: number } }
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
export interface D1Database { prepare(query: string): D1PreparedStatement }

export class D1DocStore implements DocStore {
  constructor(private readonly db: D1Database) {}

  async get<T>(key: string) {
    const row = await this.db.prepare('SELECT value, gen FROM docs WHERE key = ?').bind(key).first<{ value: string; gen: number }>();
    return row ? { value: JSON.parse(row.value) as T, gen: String(row.gen) } : null;
  }

  async put(key: string, value: unknown, ifGen?: string) {
    const json = JSON.stringify(value);
    const now = Date.now();
    if (ifGen === '0') {
      const r = await this.db.prepare('INSERT INTO docs (key, value, gen, updated) VALUES (?, ?, 1, ?) ON CONFLICT(key) DO NOTHING').bind(key, json, now).run();
      if (!r.meta.changes) throw new Conflict(key);
      return '1';
    }
    if (ifGen !== undefined) {
      const r = await this.db.prepare('UPDATE docs SET value = ?, gen = gen + 1, updated = ? WHERE key = ? AND gen = ?').bind(json, now, key, Number(ifGen)).run();
      if (!r.meta.changes) throw new Conflict(key);
      return String(Number(ifGen) + 1);
    }
    const row = await this.db.prepare('INSERT INTO docs (key, value, gen, updated) VALUES (?, ?, 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, gen = docs.gen + 1, updated = excluded.updated RETURNING gen')
      .bind(key, json, now).first<{ gen: number }>();
    return String(row?.gen ?? 1);
  }

  async list(prefix: string) {
    const { results = [] } = await this.db.prepare('SELECT key FROM docs WHERE substr(key, 1, ?) = ? ORDER BY key').bind(prefix.length, prefix).all<{ key: string }>();
    return results.map((r) => r.key);
  }

  /** Drop per-minute counters older than a day (they're only read during their minute). */
  async prune(now = Date.now()): Promise<number> {
    const r = await this.db.prepare("DELETE FROM docs WHERE key LIKE 'rpm/%' AND updated < ?").bind(now - 86_400_000).run();
    return r.meta.changes ?? 0;
  }
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

export class D1SecretStore implements SecretStore {
  private key: Promise<CryptoKey> | null = null;
  private readonly cache = new Map<string, string | undefined>();
  /** After preload(): the cache holds every secret, so an account missing from it has none. */
  private complete = false;

  /** storeKey: 32 random bytes, base64 (a Worker secret). */
  constructor(private readonly db: D1Database, private readonly storeKey: string) {}

  private cryptoKey(): Promise<CryptoKey> {
    if (!this.key) {
      const raw = unb64(this.storeKey);
      if (raw.length !== 32) throw new Error('LEYLINE_STORE_KEY must be 32 bytes, base64');
      this.key = crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    }
    return this.key;
  }

  /**
   * Every secret in one query. D1 has a single primary (this one is in APAC), and startup looks up dozens of
   * accounts, most of them unset, one round trip each: an instance in a US colo took 5-8 s to build before it
   * could answer. After this, lookups (found or not) need no query until forget().
   */
  async preload(): Promise<void> {
    const { results = [] } = await this.db.prepare('SELECT account, iv, data FROM secrets').all<{ account: string; iv: string; data: string }>();
    const values = await Promise.all(results.map(async (row) => [row.account, await this.decrypt(row.account, row)] as const));
    this.cache.clear();
    for (const [account, value] of values) this.cache.set(account, value);
    this.complete = true;
  }

  async get(account: string): Promise<string | undefined> {
    if (this.cache.has(account) || this.complete) return this.cache.get(account);
    const row = await this.db.prepare('SELECT iv, data FROM secrets WHERE account = ?').bind(account).first<{ iv: string; data: string }>();
    const value = row ? await this.decrypt(account, row) : undefined;
    this.cache.set(account, value);
    return value;
  }

  private async decrypt(account: string, row: { iv: string; data: string }): Promise<string> {
    // The account is the additional data, so a value can't be moved to another account.
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(row.iv), additionalData: new TextEncoder().encode(account) }, await this.cryptoKey(), unb64(row.data));
    return new TextDecoder().decode(plain);
  }

  async set(account: string, secret: string): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(account) }, await this.cryptoKey(), new TextEncoder().encode(secret));
    await this.db.prepare('INSERT INTO secrets (account, iv, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT(account) DO UPDATE SET iv = excluded.iv, data = excluded.data, updated = excluded.updated')
      .bind(account, b64(iv), b64(new Uint8Array(data)), Date.now()).run();
    this.cache.set(account, secret);
  }

  async delete(account: string): Promise<void> {
    await this.db.prepare('DELETE FROM secrets WHERE account = ?').bind(account).run();
    this.cache.set(account, undefined);
  }

  /** Accounts stored under a prefix. */
  async accounts(prefix: string): Promise<string[]> {
    if (this.complete) return [...this.cache].filter(([account, value]) => value !== undefined && account.startsWith(prefix)).map(([account]) => account);
    const { results = [] } = await this.db.prepare('SELECT account FROM secrets WHERE substr(account, 1, ?) = ?').bind(prefix.length, prefix).all<{ account: string }>();
    return results.map((r) => r.account);
  }

  /** Forget cached values (another instance may have changed them). */
  forget(): void {
    this.cache.clear();
    this.complete = false;
  }

  status(): SecretStoreStatus {
    return { mode: 'keychain', available: true, service: 'Cloudflare D1', label: 'Cloudflare (encrypted)' };
  }

  async getSource(account: string): Promise<ApiKeySource> {
    return (await this.get(account)) ? 'keychain' : 'none';
  }
}

const REF_PREFIX = 'arcana-reference:';

/**
 * Provider keys from Arcana Cloud when the dashboard names a reference for them, else the encrypted D1 store. The
 * references chosen on the dashboard are saved (encrypted) in D1 too, so every instance and restart uses them.
 * Saving a key directly, or clearing it, drops the provider's reference.
 */
export class D1ArcanaCloudStore extends ArcanaCloudFallbackSecretStore {
  private pending: Promise<unknown> = Promise.resolve();

  private constructor(private readonly d1: D1SecretStore, cloud: ArcanaCloudSecretStore) {
    super(cloud, d1);
  }

  static async open(d1: D1SecretStore, config: ArcanaCloudConfig, envReferences: Record<string, string>): Promise<D1ArcanaCloudStore> {
    const references = { ...envReferences };
    for (const key of await d1.accounts(REF_PREFIX)) {
      const reference = await d1.get(key);
      if (reference) references[key.slice(REF_PREFIX.length)] = reference;
    }
    return new D1ArcanaCloudStore(d1, new ArcanaCloudSecretStore(references, config));
  }

  private later(work: () => Promise<unknown>): void {
    this.pending = this.pending.then(work).catch((err) => console.error('[Leyline] saving an Arcana reference failed', err));
  }

  async get(account: string): Promise<string | undefined> {
    await this.pending;
    return super.get(account);
  }

  setArcanaReference(account: string, reference: string): void {
    super.setArcanaReference(account, reference);
    this.later(() => this.d1.set(REF_PREFIX + account, reference));
  }

  async set(account: string, secret: string): Promise<void> {
    await this.pending;
    await this.d1.delete(REF_PREFIX + account);
    return super.set(account, secret);
  }

  async delete(account: string): Promise<void> {
    await this.pending;
    await this.d1.delete(REF_PREFIX + account);
    return super.delete(account);
  }

  status(): SecretStoreStatus {
    return this.d1.status();
  }
}

export class D1LogStore {
  constructor(private readonly db: D1Database, private readonly keep = 200) {}

  async add(entry: LogEntry): Promise<void> {
    await this.db.prepare('INSERT INTO logs (id, at, entry) VALUES (?, ?, ?)').bind(entry.id, Date.parse(entry.timestamp) || Date.now(), JSON.stringify(entry)).run();
    if (Math.random() < 0.05) {
      await this.db.prepare('DELETE FROM logs WHERE at < (SELECT at FROM logs ORDER BY at DESC LIMIT 1 OFFSET ?)').bind(this.keep).run();
    }
  }

  async recent(limit = 100): Promise<LogEntry[]> {
    const { results = [] } = await this.db.prepare('SELECT entry FROM logs ORDER BY at DESC LIMIT ?').bind(limit).all<{ entry: string }>();
    return results.map((r) => JSON.parse(r.entry) as LogEntry);
  }
}
