import { handleAsNodeRequest } from 'cloudflare:node';
import type { Server } from 'node:http';
import { buildRouter, hostedOptions } from '../src/index';
import { createServer } from '../src/server';
import { adminOf, applySettings, type HostedOptions } from '../src/core/hosted';
import { D1ArcanaCloudStore, D1DocStore, D1LogStore, D1SecretStore, type D1Database } from '../src/core/d1-stores';
import { arcanaCloudConfigFromEnv, parseArcanaCloudReferences, type SecretStore } from '../src/core/secret-store';
import { logger } from '../src/core/logger';

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
  ASSETS: { fetch(request: Request): Promise<Response> };
  LEYLINE_STORE_KEY: string;
}
interface Ctx { waitUntil(p: Promise<unknown>): void }

type Built = { port: number; server: Server; hosted: HostedOptions; version: string };

let built: Promise<Built> | null = null;
let checkedAt = 0;
let nextPort = 8080;
let liveCtx: Ctx | null = null;

async function secretsVersion(db: D1Database): Promise<string> {
  const row = await db.prepare('SELECT count(*) AS n, coalesce(max(updated), 0) AS t FROM secrets').first<{ n: number; t: number }>();
  return `${row?.n ?? 0}:${row?.t ?? 0}`;
}

async function build(env: Env): Promise<Built> {
  const d1Secrets = new D1SecretStore(env.DB, env.LEYLINE_STORE_KEY);
  // With an Arcana Cloud service client configured (LEYLINE_ARCANA_CLOUD_*), providers can take their keys from
  // Arcana references chosen on the dashboard.
  const arcana = arcanaCloudConfigFromEnv();
  const secrets: SecretStore = arcana ? await D1ArcanaCloudStore.open(d1Secrets, arcana, parseArcanaCloudReferences()) : d1Secrets;
  const docs = new D1DocStore(env.DB);
  const logs = new D1LogStore(env.DB);
  logger.persistTo((entry) => {
    const write = logs.add(entry).catch((err) => console.error('[Leyline] log write failed', err));
    liveCtx?.waitUntil(write);
  }, () => logs.recent());

  const version = await secretsVersion(env.DB);
  const { router, quotaManager } = await buildRouter(secrets);
  const hosted = hostedOptions(docs, { sharedMinute: true, watch: false });
  const saved = await hosted.keys.settings();
  if (saved) applySettings(hosted, saved);
  const app = createServer(router, quotaManager, { apiKeyStore: secrets, hosted, enforceExternalSurface: false });
  // Finish startup's D1 reads inside this request: Workers cancels I/O a finished request left running.
  await app.locals.ready;
  const port = nextPort++;
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(port, () => resolve(s));
  });
  return { port, server, hosted, version };
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
    const [version, saved] = await Promise.all([secretsVersion(env.DB), b.hosted.keys.settings()]);
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

/** The dashboard's own files (built into public/ by vite, base /dashboard/). */
function assetPath(path: string): string | null {
  if (path === '/dashboard' || path === '/dashboard/' || path === '/dashboard/index.html') return '/';
  if (path.startsWith('/dashboard/assets/') || path === '/dashboard/logo.png') return path.slice('/dashboard'.length);
  if (path === '/logo.png' || path === '/favicon.ico') return '/logo.png';
  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    liveCtx = ctx;
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

    const b = await current(env);
    return handleAsNodeRequest(b.port, request, env, ctx as never);
  },

  /** Daily: drop old per-minute counters. */
  async scheduled(_event: unknown, env: Env): Promise<void> {
    await new D1DocStore(env.DB).prune();
  },
};
