import type { Express, NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import type { Router } from './router';
import { AegisAuth, cookie, type AdminUser } from './admin-login';
import { AnthropicStream, anthropicError, anthropicToOpenAI, estimateTokens, openAIToAnthropic, type AnthropicRequest } from './anthropic';
import { IssuedKeys, modelAllowed, type IssuedKey, type KeyCaps } from './issued-keys';
import { adminPage } from './admin-page';

/**
 * Hosted Leyline: an LLM API the owner hands out keys for, so people can plug it into their coding agents.
 *
 * - Requests carry an issued key (`Authorization: Bearer ll_…` or Anthropic's `x-api-key`); its caps (tokens a
 *   month, requests a day and a minute, models) are checked first and its usage counted after.
 * - OpenAI's /v1/chat/completions (server.ts) and Anthropic's /v1/messages (here) both route through Leyline's
 *   router to the owner's provider keys; /v1/models lists what's offered.
 * - The owner manages keys at /admin, signed in with Aegis (emails in LEYLINE_ADMIN_EMAILS), or with
 *   LEYLINE_ADMIN_TOKEN as a bearer token for scripts.
 */

export type HostedOptions = {
  keys: IssuedKeys;
  /** Model ids offered (what /v1/models lists and what keys may ask for, unless a key narrows it). */
  models: string[];
  /** Requested model (exact or with *) -> upstream model, e.g. {"claude-*": "gemini-2.5-pro"} for Claude Code. */
  aliases: Record<string, string>;
  login: AegisAuth | null;
  adminEmails: string[];
  adminToken?: string;
  publicUrl: string;
};

type WithKey = Request & { issuedKey?: IssuedKey; requestedModel?: string };

/** The model to send upstream for what the client asked (an alias, else as asked). */
export function resolveModel(aliases: Record<string, string>, model: string): string {
  if (aliases[model]) return aliases[model];
  for (const [pattern, target] of Object.entries(aliases)) {
    if (pattern.includes('*') && modelAllowed({ models: [pattern] }, model)) return target;
  }
  return model;
}

function presentedKey(req: Request): string {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const x = req.headers['x-api-key'];
  return typeof x === 'string' ? x.trim() : '';
}

/** Checks the issued key and its caps; errors in the shape of the API being called. */
export function requireIssuedKey(opts: HostedOptions, format: 'openai' | 'anthropic') {
  return async (req: Request, res: Response, next: NextFunction) => {
    const fail = (status: number, code: string, message: string) => (format === 'anthropic'
      ? res.status(status).json(anthropicError(status, message))
      : res.status(status).json({ error: { message, type: status === 401 ? 'invalid_request_error' : status === 429 ? 'rate_limit_error' : 'permission_error', code } }));
    const presented = presentedKey(req);
    if (!presented) return fail(401, 'missing_api_key', 'Missing API key: send Authorization: Bearer <key> (or x-api-key).');
    let key: IssuedKey | null;
    try {
      key = await opts.keys.lookup(presented);
    } catch (err) {
      console.error('[hosted] key lookup failed', err);
      return fail(503, 'key_store_unavailable', 'Leyline could not check the API key just now; try again.');
    }
    if (!key) return fail(401, 'invalid_api_key', 'Incorrect API key provided.');
    const requested = typeof req.body?.model === 'string' ? req.body.model : '';
    const offered = !requested || requested === 'auto' || opts.models.length === 0 || opts.models.some((m) => modelAllowed({ models: [m] }, requested)) || !!resolveAlias(opts, requested);
    if (!offered) return fail(404, 'model_not_found', `The model "${requested}" is not offered here; see /v1/models.`);
    const refusal = await opts.keys.admit(key, requested);
    if (refusal) return fail(refusal.status, refusal.code, refusal.message);
    (req as WithKey).issuedKey = key;
    (req as WithKey).requestedModel = requested;
    next();
  };
}

function resolveAlias(opts: HostedOptions, model: string): string | null {
  const target = resolveModel(opts.aliases, model);
  return target !== model ? target : null;
}

/** Count a finished request against its key (never fails the request). */
export function recordUsage(opts: HostedOptions, req: Request, usage?: { prompt_tokens?: number; completion_tokens?: number }): void {
  const r = req as WithKey;
  if (!r.issuedKey) return;
  void opts.keys.record(r.issuedKey, r.requestedModel ?? '', usage).catch((err) => console.error('[hosted] usage record failed', err));
}

function admin(opts: HostedOptions, req: Request): string | null {
  const auth = req.headers.authorization;
  if (opts.adminToken && auth?.startsWith('Bearer ')) {
    const a = Buffer.from(auth.slice(7).trim());
    const b = Buffer.from(opts.adminToken);
    if (a.length === b.length && timingSafeEqual(a, b)) return 'token';
  }
  const s = opts.login?.session(req.headers.cookie);
  return s && opts.adminEmails.includes(s.email) ? s.email : null;
}

function sameOrigin(opts: HostedOptions, req: Request): boolean {
  const o = req.headers.origin;
  return !o || o === opts.publicUrl;
}

/** What a key looks like to the admin page (never the hash). */
function view(k: IssuedKey & { usage?: unknown }) {
  const { hash: _hash, ...rest } = k;
  return rest;
}

export function mountHosted(app: Express, router: Router, opts: HostedOptions): void {
  // ── models ──────────────────────────────────────────────────────────────────────────────────────────
  app.get('/v1/models', requireIssuedKeyNoModel(opts), (req, res) => {
    const key = (req as WithKey).issuedKey!;
    const ids = [...opts.models, ...Object.keys(opts.aliases).filter((a) => !a.includes('*'))].filter((m, i, all) => all.indexOf(m) === i && modelAllowed(key.caps, m));
    res.json({ object: 'list', data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'leyline', type: 'model', display_name: id })) });
  });

  // ── Anthropic Messages (Claude Code: ANTHROPIC_BASE_URL) ───────────────────────────────────────────
  app.post('/v1/messages/count_tokens', requireIssuedKeyNoModel(opts, 'anthropic'), (req, res) => {
    res.json({ input_tokens: estimateTokens(req.body as AnthropicRequest) });
  });

  app.post('/v1/messages', requireIssuedKey(opts, 'anthropic'), async (req, res) => {
    let request;
    try {
      request = anthropicToOpenAI(req.body as AnthropicRequest);
    } catch (err) {
      return res.status(400).json(anthropicError(400, err instanceof Error ? err.message : String(err)));
    }
    const asked = request.model;
    request.model = resolveModel(opts.aliases, asked);
    try {
      if (request.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const out = new AnthropicStream(asked);
        const send = (events: Array<{ event: string; data: unknown }>) => {
          for (const e of events) res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
        };
        try {
          for await (const chunk of await router.routeStream(request)) send(out.push(chunk));
          send(out.end());
        } catch (err) {
          console.error('[hosted] /v1/messages stream failed', err);
          res.write(`event: error\ndata: ${JSON.stringify(anthropicError(502, 'The model provider failed; try again.'))}\n\n`);
        }
        res.end();
        recordUsage(opts, req, out.tokens);
        return;
      }
      const response = await router.route(request);
      res.json(openAIToAnthropic(response, asked));
      recordUsage(opts, req, response.usage);
    } catch (err) {
      console.error('[hosted] /v1/messages failed', err);
      if (!res.headersSent) res.status(502).json(anthropicError(502, 'The model provider failed; try again.'));
    }
  });

  // ── admin sign-in ───────────────────────────────────────────────────────────────────────────────────
  const login = opts.login;
  if (login) {
    app.get('/auth/login', async (req, res) => {
      try {
        const { url, cookie: c } = await login.start(typeof req.query.next === 'string' ? req.query.next : '/admin');
        res.setHeader('Set-Cookie', c);
        res.redirect(302, url);
      } catch (err) {
        res.status(502).send(`Sign-in is unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    app.get('/auth/callback', async (req, res) => {
      try {
        const done = await login.finish(new URLSearchParams(req.url.split('?')[1] ?? ''), req.headers.cookie);
        if (!opts.adminEmails.includes(done.session.email)) {
          res.setHeader('Set-Cookie', cookie('leyline_login', '', 0));
          return res.status(403).send(`${done.session.email} can't manage this Leyline.`);
        }
        res.setHeader('Set-Cookie', [done.cookie, cookie('leyline_login', '', 0)]);
        res.redirect(302, done.next);
      } catch (err) {
        res.status(400).send(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    app.post('/auth/logout', (_req, res) => {
      res.setHeader('Set-Cookie', cookie('leyline_session', '', 0));
      res.status(204).end();
    });
  }

  // ── admin: the page and the key API ─────────────────────────────────────────────────────────────────
  app.get('/admin', (req, res) => {
    const who = admin(opts, req);
    if (!who) return res.redirect(302, login ? '/auth/login?next=/admin' : '/');
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(adminPage({ email: who, publicUrl: opts.publicUrl, models: opts.models, aliases: opts.aliases }));
  });

  const guard = (req: Request, res: Response, next: NextFunction) => {
    const who = admin(opts, req);
    if (!who) return res.status(401).json({ error: 'admin_only' });
    if (req.method !== 'GET' && who !== 'token' && !sameOrigin(opts, req)) return res.status(403).json({ error: 'forbidden' });
    (req as Request & { admin?: string }).admin = who;
    next();
  };
  app.get('/admin/api/keys', guard, async (_req, res) => {
    res.json({ keys: (await opts.keys.list()).map(view) });
  });
  app.post('/admin/api/keys', guard, async (req, res) => {
    try {
      const { key, record } = await opts.keys.create({ name: String(req.body?.name ?? ''), caps: (req.body?.caps ?? {}) as KeyCaps, note: typeof req.body?.note === 'string' ? req.body.note : undefined, by: (req as Request & { admin?: string }).admin! });
      console.log(JSON.stringify({ event: 'key_created', id: record.id, name: record.name, by: record.createdBy, caps: record.caps }));
      res.status(201).json({ key, record: view(record) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.patch('/admin/api/keys/:id', guard, async (req, res) => {
    try {
      const record = await opts.keys.setCaps(String(req.params.id), (req.body?.caps ?? {}) as KeyCaps);
      res.json({ record: view(record) });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.delete('/admin/api/keys/:id', guard, async (req, res) => {
    try {
      const record = await opts.keys.revoke(String(req.params.id));
      console.log(JSON.stringify({ event: 'key_revoked', id: record.id, by: (req as Request & { admin?: string }).admin }));
      res.json({ record: view(record) });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** The key check for endpoints with no model in the body (models list, token counting). */
function requireIssuedKeyNoModel(opts: HostedOptions, format: 'openai' | 'anthropic' = 'openai') {
  const check = requireIssuedKey(opts, format);
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' || !req.body || typeof req.body.model !== 'string') return check(req, res, next);
    const model = req.body.model;
    req.body.model = '';
    return check(req, res, (err?: unknown) => {
      req.body.model = model;
      next(err);
    });
  };
}

export type { AdminUser };
