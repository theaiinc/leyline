import { webcrypto } from 'node:crypto';
import { D1SecretStore, type D1Database } from '../src/core/d1-stores';

if (!globalThis.crypto) (globalThis as { crypto?: unknown }).crypto = webcrypto;

/** Just enough of D1 for the secrets table, counting the queries it answers. */
function fakeD1() {
  const rows = new Map<string, { iv: string; data: string }>();
  let queries = 0;
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async first() {
          queries++;
          return rows.get(String(args[0])) ?? null;
        },
        async all() {
          queries++;
          if (sql.startsWith('SELECT account, iv, data')) return { results: [...rows].map(([account, r]) => ({ account, ...r })) };
          const prefix = String(args[1] ?? '');
          return { results: [...rows.keys()].filter((a) => a.startsWith(prefix)).map((account) => ({ account })) };
        },
        async run() {
          queries++;
          if (sql.startsWith('INSERT')) rows.set(String(args[0]), { iv: String(args[1]), data: String(args[2]) });
          if (sql.startsWith('DELETE')) rows.delete(String(args[0]));
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return { db: db as unknown as D1Database, queries: () => queries };
}

const storeKey = Buffer.alloc(32, 7).toString('base64');

describe('D1SecretStore preload', () => {
  it('answers every later lookup, set or not, without another query', async () => {
    const d1 = fakeD1();
    await new D1SecretStore(d1.db, storeKey).set('api-key:LLM API', 'sk-1');
    await new D1SecretStore(d1.db, storeKey).set('arcana-reference:api-key:Azure', 'arcana://x/y');

    const store = new D1SecretStore(d1.db, storeKey);
    const before = d1.queries();
    await store.preload();
    expect(d1.queries() - before).toBe(1);

    const after = d1.queries();
    await expect(store.get('api-key:LLM API')).resolves.toBe('sk-1');
    await expect(store.get('api-key:Gemini')).resolves.toBeUndefined(); // unset: no query either
    await expect(store.accounts('arcana-reference:')).resolves.toEqual(['arcana-reference:api-key:Azure']);
    expect(d1.queries()).toBe(after);
  });

  it('stays correct after writes, and queries again once told to forget', async () => {
    const d1 = fakeD1();
    const store = new D1SecretStore(d1.db, storeKey);
    await store.preload();
    await store.set('api-key:OpenAI', 'sk-2');
    await expect(store.get('api-key:OpenAI')).resolves.toBe('sk-2');
    await store.delete('api-key:OpenAI');
    await expect(store.get('api-key:OpenAI')).resolves.toBeUndefined();

    store.forget();
    const before = d1.queries();
    await store.get('api-key:OpenAI');
    expect(d1.queries()).toBe(before + 1);
  });
});
