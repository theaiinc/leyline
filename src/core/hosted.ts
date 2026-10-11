import type { Express, NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import type { Router } from './router';
import { AegisAuth, cookie, type AdminUser } from './admin-login';
import { AnthropicStream, anthropicError, anthropicToOpenAI, estimateTokens, openAIToAnthropic, type AnthropicRequest } from './anthropic';
import { DEFAULT_PRICE, IssuedKeys, costUsd, modelAllowed, priceOf, type HostedSettings, type IssuedKey, type KeyCaps, type Price } from './issued-keys';

/**
 * Hosted Leyline: an LLM API the owner hands out keys for, so people can plug it into their coding agents.
 *
 * - Requests carry an issued key (`Authorization: Bearer ll_…` or Anthropic's `x-api-key`); its caps (tokens a
 *   month, requests a day and a minute, models) are checked first and its usage counted after.
 * - OpenAI's /v1/chat/completions (server.ts) and Anthropic's /v1/messages (here) both route through Leyline's
 *   router to the owner's provider keys; /v1/models lists what's offered.
 * - The owner manages everything on the dashboard (/dashboard: provider keys, routing, these keys, the models
 *   offered), signed in with Aegis (emails in LEYLINE_ADMIN_EMAILS), or with LEYLINE_ADMIN_TOKEN as a bearer token
 *   for scripts. The models offered and aliases start from env and, once saved on the dashboard, come from the store.
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
  /** Models turned off for every key (ids or patterns with *). */
  blockedModels?: string[];
  /** The most all keys together may spend a month (US dollars); null: no limit. */
  monthlyBudgetUsd?: number | null;
  /** US dollars per million tokens by model (or pattern), and the price for models without one. */
  prices?: Record<string, Price>;
  defaultPrice?: Price;
  /** Price models without a manual price at what their provider publishes (default on). */
  usePublishedPrices?: boolean;
  /** The serving provider's published price for a model (the router's model lists; set by mountHosted). */
  publishedPrice?: (provider: string, model: string) => Price | undefined;
  publishedPriceCounts?: () => Record<string, number>;
  /** When the settings were last saved on the dashboard (null: env defaults). */
  settingsSaved?: { at: number; by: string } | null;
  /**
   * Keeps work that finishes after the response alive (usage, spend). The Worker passes its waitUntil: Workers
   * cancels anything a finished request left running.
   */
  background?: (work: Promise<unknown>) => void;
};

type WithKey = Request & { issuedKey?: IssuedKey; requestedModel?: string; ownerRequest?: boolean; served?: { provider: string; model: string } };

/** Route option that remembers which provider and model served this request (for spend by provider and model). */
export function servedBy(req: Request): (provider: string, model: string) => void {
  return (provider, model) => {
    (req as WithKey).served = { provider, model };
  };
}

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
    // The owner, signed in on the dashboard (its playground): no key, no caps, not counted.
    if (!presented && adminOf(opts, req) && sameOrigin(opts, req)) {
      (req as WithKey).requestedModel = typeof req.body?.model === 'string' ? req.body.model : '';
      (req as WithKey).ownerRequest = true;
      return next();
    }
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
    if (requested && isBlocked(opts, requested)) {
      return fail(403, 'model_disabled', `The model "${requested}" is turned off here; see /v1/models for what you can use.`);
    }
    const refusal = await opts.keys.admit(key, requested, opts.monthlyBudgetUsd ?? null);
    if (refusal) return fail(refusal.status, refusal.code, refusal.message);
    (req as WithKey).issuedKey = key;
    (req as WithKey).requestedModel = requested;
    next();
  };
}

/** Turned off: the model asked for, or the one an alias maps it to, matches the blocked list. */
export function isBlocked(opts: HostedOptions, model: string): boolean {
  const blocked = opts.blockedModels ?? [];
  if (!blocked.length) return false;
  const matches = (m: string) => modelAllowed({ models: blocked }, m);
  return matches(model) || matches(resolveModel(opts.aliases, model));
}

function resolveAlias(opts: HostedOptions, model: string): string | null {
  const target = resolveModel(opts.aliases, model);
  return target !== model ? target : null;
}

/**
 * Count a finished request against its key and the monthly spend (never fails the request). The cost uses the price
 * of the model actually used. Without usage from the provider it's estimated (four characters a token): the request
 * body for input, outChars for output.
 */
export function recordUsage(opts: HostedOptions, req: Request, usage?: { prompt_tokens?: number; completion_tokens?: number }, outChars = 0): void {
  const r = req as WithKey;
  if (!r.issuedKey && !r.ownerRequest) return;
  const counted = usage && ((usage.prompt_tokens ?? 0) > 0 || (usage.completion_tokens ?? 0) > 0)
    ? usage
    : { prompt_tokens: Math.ceil(JSON.stringify(req.body ?? {}).length / 4), completion_tokens: Math.ceil(outChars / 4) };
  const model = r.requestedModel ?? '';
  // Priced by the model that actually answered (after aliases and routing), credited to the provider that served it.
  const used = r.served?.model || resolveModel(opts.aliases, model);
  const published = opts.usePublishedPrices !== false && r.served ? opts.publishedPrice?.(r.served.provider, used) : undefined;
  const usd = costUsd(priceOf({ prices: opts.prices ?? {}, defaultPrice: opts.defaultPrice ?? DEFAULT_PRICE }, used, published), counted);
  const work = opts.keys.record(r.issuedKey ?? null, model, counted, usd, { provider: r.served?.provider ?? 'unknown', model: used })
    .catch((err) => console.error('[hosted] usage record failed', err));
  opts.background?.(work);
}

/** Who is managing this Leyline: their email (Aegis session), 'token' (LEYLINE_ADMIN_TOKEN), or null. */
export function adminOf(opts: HostedOptions, req: Request): string | null {
  const auth = req.headers.authorization;
  if (opts.adminToken && auth?.startsWith('Bearer ')) {
    const a = Buffer.from(auth.slice(7).trim());
    const b = Buffer.from(opts.adminToken);
    if (a.length === b.length && timingSafeEqual(a, b)) return 'token';
  }
  const s = opts.login?.session(req.headers.cookie);
  return s && opts.adminEmails.includes(s.email.toLowerCase()) ? s.email : null;
}

export function sameOrigin(opts: HostedOptions, req: Request): boolean {
  const o = req.headers.origin;
  return !o || o === opts.publicUrl;
}

/** What a key looks like to the admin page (never the hash). */
function view(k: IssuedKey & { usage?: unknown }) {
  const { hash: _hash, ...rest } = k;
  return rest;
}

export function applySettings(opts: HostedOptions, s: HostedSettings): void {
  opts.models = s.models;
  opts.aliases = s.aliases;
  // Settings saved before the spending limit existed keep the configured limit.
  if ('monthlyBudgetUsd' in s) opts.monthlyBudgetUsd = s.monthlyBudgetUsd;
  opts.blockedModels = s.blockedModels ?? opts.blockedModels ?? [];
  opts.prices = s.prices ?? opts.prices ?? {};
  opts.defaultPrice = s.defaultPrice ?? opts.defaultPrice ?? DEFAULT_PRICE;
  opts.usePublishedPrices = s.usePublishedPrices ?? opts.usePublishedPrices ?? true;
  opts.settingsSaved = s.updatedAt ? { at: s.updatedAt, by: s.updatedBy ?? '' } : null;
}

async function settingsView(opts: HostedOptions) {
  return {
    models: opts.models,
    aliases: opts.aliases,
    blockedModels: opts.blockedModels ?? [],
    monthlyBudgetUsd: opts.monthlyBudgetUsd ?? null,
    prices: opts.prices ?? {},
    defaultPrice: opts.defaultPrice ?? DEFAULT_PRICE,
    usePublishedPrices: opts.usePublishedPrices !== false,
    publishedPrices: opts.publishedPriceCounts?.() ?? {},
    spend: await opts.keys.spend(),
    saved: opts.settingsSaved ?? null,
    publicUrl: opts.publicUrl,
  };
}

/** Load the dashboard-saved models/aliases now and every minute (other instances may change them). */
export function watchSettings(opts: HostedOptions, everyMs = 60_000): () => void {
  const load = () => opts.keys.settings().then((s) => { if (s) applySettings(opts, s); }).catch((err) => console.error('[hosted] settings load failed', err));
  void load();
  const t = setInterval(load, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}

export function mountHosted(app: Express, router: Router, opts: HostedOptions): void {
  opts.publishedPrice ??= (provider, model) => router.publishedPrice(provider, model);
  opts.publishedPriceCounts ??= () => router.publishedPriceCounts();
  // ── models ──────────────────────────────────────────────────────────────────────────────────────────
  app.get('/v1/models', requireIssuedKeyNoModel(opts), (req, res) => {
    const key = (req as WithKey).issuedKey!;
    const ids = [...opts.models, ...Object.keys(opts.aliases).filter((a) => !a.includes('*'))].filter((m, i, all) => all.indexOf(m) === i && modelAllowed(key.caps, m) && !isBlocked(opts, m));
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
          for await (const chunk of await router.routeStream(request, { onServed: servedBy(req) })) send(out.push(chunk));
          send(out.end());
        } catch (err) {
          console.error('[hosted] /v1/messages stream failed', err);
          res.write(`event: error\ndata: ${JSON.stringify(anthropicError(502, 'The model provider failed; try again.'))}\n\n`);
        }
        res.end();
        recordUsage(opts, req, out.tokens, out.chars);
        return;
      }
      const response = await router.route(request, { onServed: servedBy(req) });
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
        const { url, cookie: c } = await login.start(typeof req.query.next === 'string' ? req.query.next : '/dashboard/', { switchAccount: req.query.switch === '1' });
        res.setHeader('Set-Cookie', c);
        res.redirect(302, url);
      } catch (err) {
        res.status(502).send(`Sign-in is unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    app.get('/auth/callback', async (req, res) => {
      try {
        const done = await login.finish(new URLSearchParams(req.url.split('?')[1] ?? ''), req.headers.cookie);
        if (!opts.adminEmails.includes(done.session.email.toLowerCase())) {
          res.setHeader('Set-Cookie', cookie('leyline_login', '', 0));
          return res.status(403).type('html').send(refusedPage(done.session.email));
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
  app.get('/admin', (_req, res) => res.redirect(302, '/dashboard/#/keys'));

  const guard = (req: Request, res: Response, next: NextFunction) => {
    const who = adminOf(opts, req);
    if (!who) return res.status(401).json({ error: 'admin_only' });
    if (req.method !== 'GET' && who !== 'token' && !sameOrigin(opts, req)) return res.status(403).json({ error: 'forbidden' });
    (req as Request & { admin?: string }).admin = who;
    next();
  };
  app.get('/admin/api/settings', guard, async (_req, res) => {
    res.json(await settingsView(opts));
  });
  app.put('/admin/api/settings', guard, async (req, res) => {
    try {
      // A save changes only what it names; the rest stays as it is.
      const current = { models: opts.models, aliases: opts.aliases, blockedModels: opts.blockedModels ?? [], monthlyBudgetUsd: opts.monthlyBudgetUsd ?? null, prices: opts.prices ?? {}, defaultPrice: opts.defaultPrice ?? DEFAULT_PRICE, usePublishedPrices: opts.usePublishedPrices !== false };
      const saved = await opts.keys.saveSettings({ ...current, ...(req.body as Partial<HostedSettings>) }, (req as Request & { admin?: string }).admin!);
      applySettings(opts, saved);
      console.log(JSON.stringify({ event: 'settings_saved', by: saved.updatedBy, models: saved.models, aliases: saved.aliases, monthlyBudgetUsd: saved.monthlyBudgetUsd }));
      res.json(await settingsView(opts));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  // Spend by provider and model for a month (default: this one), and which months have any.
  app.get('/admin/api/spend', guard, async (req, res) => {
    const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : undefined;
    const [spend, months] = await Promise.all([opts.keys.spend(month), opts.keys.spendMonths()]);
    res.json({ spend, months, monthlyBudgetUsd: opts.monthlyBudgetUsd ?? null });
  });
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

/** Signed in, but not one of the owners: say so, and offer another account. */
function refusedPage(email: string): string {
  const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Leyline</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;background:#0b0d12;color:#eef1f7}
@media (prefers-color-scheme: light){body{background:#f6f7fb;color:#141824}}main{max-width:420px;padding:24px;text-align:center}
a{display:inline-block;margin-top:16px;padding:9px 16px;border-radius:9px;background:#3557e8;color:#fff;text-decoration:none}</style></head>
<body><main><h1 style="font-size:20px">Not an owner of this Leyline</h1><p>You signed in as <strong>${esc(email)}</strong>, which can't manage it.</p>
<a href="/auth/login?next=/dashboard/&amp;switch=1">Use a different account</a></main></body></html>`;
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
