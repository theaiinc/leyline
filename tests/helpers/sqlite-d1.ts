import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { D1PreparedStatement, D1Result } from '../../src/core/d1-stores';
import type { D1BatchDatabase } from '../../src/core/billing-store';

/**
 * D1's API over a real SQLite database (node:sqlite), with the Worker's migrations applied, so the billing SQL is
 * tested as written. batch() is a transaction, like D1's.
 */
export function sqliteD1(): D1BatchDatabase & { sqlite: DatabaseSync; statements: () => number } {
  const sqlite = new DatabaseSync(':memory:');
  const dir = join(__dirname, '../../worker/migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(join(dir, file), 'utf8'));
  let count = 0;
  const norm = (args: unknown[]) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a)) as never[];
  type Stmt = D1PreparedStatement & { exec(): D1Result };
  const prepare = (sql: string): Stmt => {
    let args: unknown[] = [];
    const stmt: Stmt = {
      bind(...a: unknown[]) { args = a; return stmt; },
      async first<T>() { count++; return ((sqlite.prepare(sql).get(...norm(args)) as T | undefined) ?? null); },
      async all<T>() { count++; return { results: sqlite.prepare(sql).all(...norm(args)) as T[], meta: {} }; },
      async run() { return stmt.exec(); },
      exec() {
        count++;
        const r = sqlite.prepare(sql).run(...norm(args));
        return { meta: { changes: Number(r.changes) } };
      },
    };
    return stmt;
  };
  return {
    sqlite,
    statements: () => count,
    prepare,
    async batch(statements: D1PreparedStatement[]) {
      sqlite.exec('BEGIN');
      try {
        const out = statements.map((s) => (s as Stmt).exec());
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

/** D1's API for the docs table only (issued keys), on the same database. */
export { sqliteD1 as default };
