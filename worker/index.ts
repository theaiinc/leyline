import { handleAsNodeRequest } from 'cloudflare:node';
import type { Server } from 'node:http';
import { buildRouter, hostedOptions } from '../src/index';
import { createServer } from '../src/server';
import { adminOf, applySettings, type HostedOptions } from '../src/core/hosted';
import { D1ArcanaCloudStore, D1DocStore, D1LogStore, D1SecretStore, type D1Database } from '../src/core/d1-stores';
import { arcanaCloudConfigFromEnv, parseArcanaCloudReferences, type SecretStore } from '../src/core/secret-store';
import { logger } from '../src/core/logger';
import { fetchBenchmarkSnapshot, mapBenchmarkSnapshot, refreshBenchmarks, type BenchmarkCache, type BenchmarkSnapshot } from '../src/core/benchmarks';
import type { ModelListSnapshot } from '../src/core/router';
import type { WorkersAiBinding } from '../src/providers/workers-ai';

/**
 * Hosted Leyline on Cloudflare Workers. The same Express app as the Node server (src/server.ts), in hosted keys
 * mode, reached through workerd's Node HTTP bridge; the dashboard's files come from Workers static assets. State
 * lives in D1, so every instance sees the same keys, usage, provider keys and log.
 *
 * Each instance builds the app once, then checks D1 at most once a minute: when provider keys or routing changed
 * (in another instance), it rebuilds; when the offered models changed, it applies them.
 */

interface Env {
  DB: D1Database;
  /** Cloudflare Email Sending (cost alerts), from LEYLINE_ALERT_FROM on an onboarded domain. */
  EMAIL?: { send(message: { from: string; to: string[]; subject: string; text: string }): Promise<{ messageId: string }> };
  LEYLINE_ALERT_FROM?: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Workers AI ("ai": {"binding": "AI"}): chat, embeddings and audio on @cf/ models, billed to this account. */
  AI?: WorkersAiBinding;
  LEYLINE_STORE_KEY: string;
  /** Git commit injected by the CI deployment workflow. */
  GIT_SHA?: string;
  ARTIFICIAL_ANALYSIS_API_KEY?: string;
  ARTIFICIAL_ANALYSIS_URL?: string;
  EPOCH_BENCHMARKS_URL?: string;
  LM_ARENA_URL?: string;
  /** Optional Veil Presidio analyzer endpoint; regex is used when unset. */
  PRESIDIO_ANALYZER_URL?: string;
}
interface Ctx { waitUntil(p: Promise<unknown>): void }

/** Provider model lists shared by every instance (see build()), for one version of the provider keys. */
type SharedModelLists = { version: string; savedAt: number; lists: ModelListSnapshot };
const MODEL_LISTS_DOC = 'model-lists';
const MODEL_LISTS_REFRESH_MS = 30 * 60_000;
const BENCHMARKS_DOC = 'benchmarks';

function benchmarkCache(docs: D1DocStore, env: Env): BenchmarkCache {
  return {
    get: async () => {
      const record = await docs.get<BenchmarkSnapshot>(BENCHMARKS_DOC);
      return record?.value ?? null;
    },
    put: async (snapshot: BenchmarkSnapshot) => { await docs.put(BENCHMARKS_DOC, snapshot); },
  };
}

function refreshStoredBenchmarks(docs: D1DocStore, env: Env, force = false): Promise<unknown> {
  const cache = benchmarkCache(docs, env);
  return refreshBenchmarks(
    () => fetchBenchmarkSnapshot({
      artificialAnalysisApiKey: env.ARTIFICIAL_ANALYSIS_API_KEY,
      artificialAnalysisUrl: env.ARTIFICIAL_ANALYSIS_URL,
      epochUrl: env.EPOCH_BENCHMARKS_URL ?? 'https://epoch.ai/data/benchmark_data.zip',
      lmarenaUrl: env.LM_ARENA_URL ?? 'https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=text&split=latest',
    }),
    cache,
    force,
  );
}

type Built = { port: number; server: Server; hosted: HostedOptions; version: string; stages: Record<string, number> };

let built: Promise<Built> | null = null;
let checkedAt = 0;
let nextPort = 8080;
let liveCtx: Ctx | null = null;
/** Writes still running after their response (usage, spend, the log); every request keeps them alive too. */
const pending = new Set<Promise<unknown>>();

function keepAlive(work: Promise<unknown>): void {
  pending.add(work);
  void work.finally(() => pending.delete(work));
  try {
    liveCtx?.waitUntil(work);
  } catch {
    // that request already finished; the next one picks the work up from `pending`
  }
}

/**
 * D1 for this instance: a session that reads from the nearest read replica (read replication is on for this
 * database) and writes to the primary in HKG. Every request reads D1 (its key, the month's spend) and every new
 * instance reads it while building; from a US colo each read used to cross the Pacific. Within the session, reads
 * see its own writes; other instances' writes show up after replication (seconds), fine for usage counters and
 * the once-a-minute settings check.
 */
function reads(env: Env): D1Database {
  const withSession = (env.DB as D1Database & { withSession?: (constraint: string) => D1Database }).withSession;
  return withSession ? withSession.call(env.DB, 'first-unconstrained') : env.DB;
}

async function secretsVersion(db: D1Database): Promise<string> {
  const row = await db.prepare('SELECT count(*) AS n, coalesce(max(updated), 0) AS t FROM secrets').first<{ n: number; t: number }>();
  return `${row?.n ?? 0}:${row?.t ?? 0}`;
}

async function build(env: Env): Promise<Built> {
  const started = Date.now();
  const stages: Record<string, number> = {};
  const mark = (stage: string) => { stages[stage] = Date.now() - started; };
  const db = reads(env);
  const d1Secrets = new D1SecretStore(db, env.LEYLINE_STORE_KEY);
  // All secrets in one query: every later lookup during startup is then free (see preload()).
  await d1Secrets.preload();
  mark('preload');
  // With an Arcana Cloud service client configured (LEYLINE_ARCANA_CLOUD_*), providers can take their keys from
  // Arcana references chosen on the dashboard.
  const arcana = arcanaCloudConfigFromEnv();
  const secrets: SecretStore = arcana ? await D1ArcanaCloudStore.open(d1Secrets, arcana, parseArcanaCloudReferences()) : d1Secrets;
  mark('arcana');
  const docs = new D1DocStore(db, env.DB);
  // The log is written on every request: straight to the primary, never through the read session.
  const logs = new D1LogStore(env.DB);
  logger.persistTo((entry) => {
    keepAlive(logs.add(entry).catch((err) => console.error('[Leyline] log write failed', err)));
  }, () => logs.recent());

  const version = await secretsVersion(db);
  mark('version');
  const { router, quotaManager } = await buildRouter(secrets, { workersAi: env.AI });
  // The providers' model lists as another instance last made them (for these same provider keys): listing them
  // all again took ~2.5 s before this instance could answer anything.
  const shared = await docs.get<SharedModelLists>(MODEL_LISTS_DOC).catch(() => null);
  // The lists are for these keys *and* these providers: a deploy that adds one (Anthropic) must list it too, not
  // reuse lists made without it until the half-hourly refresh.
  const listsVersion = `${version}|${router.getProviders().map((p) => p.name).sort().join(',')}`;
  if (shared?.value.version === listsVersion) router.importModelLists(shared.value.lists);
  // The hosted model route falls back to the provider index when no fixed pool is configured.
  // Refresh missing/stale lists during Worker startup so a cold instance can advertise served models.
  await router.reindexStale();
  mark('router');
  const hosted = hostedOptions(docs, { sharedMinute: true, watch: false, benchmarks: async () => {
    const cache = benchmarkCache(docs, env);
    const cached = await cache.get();
    const stale = !cached || Date.now() - cached.fetchedAt >= 24 * 60 * 60 * 1000;
    const mapSnapshot = (snapshot: BenchmarkSnapshot | null) => snapshot ? mapBenchmarkSnapshot(snapshot, router.exportModelLists().flatMap((list) => list.models.map((model) => ({ id: model.id, aliases: model.aliases ?? [] })))) : null;
    if (!stale) return mapSnapshot(cached);
    try {
      // Await the refresh here: a Worker may terminate ordinary background work
      // after the response unless it is reliably attached to waitUntil. Returning
      // the newly written snapshot also makes the first stale request useful.
      return mapSnapshot(await refreshStoredBenchmarks(docs, env, true)) ?? mapSnapshot(cached);
    } catch (error) {
      console.error('[benchmarks] request refresh failed', error instanceof Error ? error.message : error);
      return cached;
    }
  } });
  hosted.background = keepAlive;
  const email = env.EMAIL;
  if (email) {
    const from = env.LEYLINE_ALERT_FROM || 'Leyline <alerts@notify.theaiinc.com>';
    hosted.sendEmail = async (to, subject, text) => {
      await email.send({ from, to, subject, text });
    };
  }
  const saved = await hosted.keys.settings();
  if (saved) applySettings(hosted, saved);
  mark('settings');
  const app = createServer(router, quotaManager, { apiKeyStore: secrets, hosted, enforceExternalSurface: false });
  // Finish startup's D1 reads inside this request: Workers cancels I/O a finished request left running.
  await app.locals.ready;
  mark('ready');
  for (const [k, v] of Object.entries((app.locals.readyStages ?? {}) as Record<string, number>)) stages[`ready-${k}`] = v;
  // Keys still loading from Arcana Cloud: Workers would cancel that I/O once this request is done.
  if (app.locals.background) keepAlive(app.locals.background as Promise<unknown>);
  // Keep the shared lists fresh for the next instance, after this one is already answering: save what this build
  // listed itself, and relist in the background once they're half way to stale.
  const oldest = router.oldestModelList();
  if (!shared || shared.value.version !== listsVersion || (oldest !== null && oldest > shared.value.savedAt)) {
    keepAlive(docs.put(MODEL_LISTS_DOC, { version: listsVersion, savedAt: Date.now(), lists: router.exportModelLists() } satisfies SharedModelLists));
  } else if (oldest !== null && Date.now() - oldest > MODEL_LISTS_REFRESH_MS) {
    keepAlive(router.reindexAll().then(() => docs.put(MODEL_LISTS_DOC, { version: listsVersion, savedAt: Date.now(), lists: router.exportModelLists() } satisfies SharedModelLists)));
  }
  const port = nextPort++;
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(port, () => resolve(s));
  });
  console.log(JSON.stringify({ event: 'leyline_built', ms: Date.now() - started, stages }));
  return { port, server, hosted, version, stages };
}

async function current(env: Env): Promise<Built> {
  if (!built) {
    built = build(env);
    built.catch(() => { built = null; });
    checkedAt = Date.now();
    return built;
  }
  const b = await built;
  if (Date.now() - checkedAt > 60_000) {
    checkedAt = Date.now();
    const [version, saved] = await Promise.all([secretsVersion(reads(env)), b.hosted.keys.settings()]);
    if (saved) applySettings(b.hosted, saved);
    if (version !== b.version) {
      const next = build(env);
      built = next;
      next.then(() => b.server.close(), () => { built = Promise.resolve(b); });
      return next;
    }
  }
  return b;
}

const DASHBOARD_FILES = new Set(['/logo.png', '/icon.svg', '/favicon-32.png', '/favicon.ico', '/apple-touch-icon.png']);

/** The dashboard's own files (built into public/ by vite, base /dashboard/). */
function assetPath(path: string): string | null {
  if (path === '/dashboard' || path === '/dashboard/' || path === '/dashboard/index.html') return '/';
  if (path.startsWith('/dashboard/assets/') || DASHBOARD_FILES.has(path.slice('/dashboard'.length))) return path.slice('/dashboard'.length);
  // Browsers and agents ask the site root for these.
  if (path === '/favicon.ico' || path === '/icon.svg' || path === '/apple-touch-icon.png' || path === '/logo.png') return path;
  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    liveCtx = ctx;
    if (pending.size) ctx.waitUntil(Promise.allSettled([...pending]));
    const url = new URL(request.url);
    if (url.pathname === '/') return Response.redirect(new URL('/dashboard/', url).toString(), 302);

    const asset = assetPath(url.pathname);
    if (asset) {
      if (asset === '/') {
        // The page itself is for the owner; its scripts and styles hold nothing private.
        const b = await current(env);
        const req = { headers: { cookie: request.headers.get('cookie') ?? undefined, authorization: request.headers.get('authorization') ?? undefined } };
        if (!adminOf(b.hosted, req as never)) {
          return b.hosted.login
            ? Response.redirect(new URL('/auth/login?next=/dashboard/', url).toString(), 302)
            : new Response('Sign-in is not configured.', { status: 503 });
        }
        if (url.pathname === '/dashboard') return Response.redirect(new URL('/dashboard/', url).toString(), 302);
      }
      const res = await env.ASSETS.fetch(new Request(new URL(asset, url), request));
      if (asset !== '/') return res;
      const page = new Response(res.body, res);
      page.headers.set('Cache-Control', 'no-store');
      return page;
    }

    if (url.pathname === '/healthz') {
      return Response.json({ status: 'ok', service: 'leyline', ...(env.GIT_SHA ? { commit: env.GIT_SHA } : {}) });
    }

    const t0 = Date.now();
    const b = await current(env);
    if (url.pathname === '/v1/benchmarks/refresh' && request.method === 'POST') {
      const req = { headers: { cookie: request.headers.get('cookie') ?? undefined, authorization: request.headers.get('authorization') ?? undefined } };
      if (!adminOf(b.hosted, req as never)) return new Response('Unauthorized', { status: 401 });
      try {
        const snapshot = await refreshStoredBenchmarks(new D1DocStore(reads(env), env.DB), env, true);
        const benchmarks = snapshot && 'benchmarks' in snapshot ? snapshot.benchmarks.map((benchmark) => ({ id: benchmark.id, rows: benchmark.scores.length })) : [];
        return Response.json({
          ok: true,
          fetchedAt: snapshot && 'fetchedAt' in snapshot ? snapshot.fetchedAt : null,
          rows: benchmarks.reduce((total, benchmark) => total + benchmark.rows, 0),
          benchmarks,
        });
      } catch (error) {
        console.error('[benchmarks] admin refresh failed', error instanceof Error ? error.message : error);
        return Response.json({ ok: false, error: error instanceof Error ? error.message : 'refresh failed' }, { status: 502 });
      }
    }
    const appMs = Date.now() - t0;
    const res = await handleAsNodeRequest(b.port, request, env, ctx as never);
    // Where a request's time to its first byte goes: getting the app (a cold build), then the app itself.
    if (url.pathname.startsWith('/v1/')) console.log(JSON.stringify({ event: 'leyline_request', path: url.pathname, appMs, headersMs: Date.now() - t0 }));
    // Server-Timing for the caller too: getting the app (with its build stages when this request built it), the
    // app's own stages (set by server.ts), and where this instance runs.
    const timing = [`app;dur=${appMs}`, ...(appMs > 200 ? Object.entries(b.stages).map(([k, v]) => `build-${k};dur=${v}`) : []), `colo;desc=${(request as { cf?: { colo?: string } }).cf?.colo ?? '?'}`];
    const out = new Response(res.body, res);
    out.headers.set('Server-Timing', [res.headers.get('Server-Timing'), ...timing].filter(Boolean).join(', '));
    return out;
  },

  /** Daily: refresh benchmark rankings and drop old per-minute counters. */
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const docs = new D1DocStore(env.DB);
    await Promise.all([
      docs.prune(),
      refreshStoredBenchmarks(docs, env, true),
    ]);
  },
};
