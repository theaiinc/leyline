import type { Express, NextFunction, Request, Response } from 'express';
import { ROUTING_STRATEGIES, isRoutingStrategy } from './routing-strategies';
import { cookie } from './admin-login';
import { BillingError, type PaymentMethod } from './billing';
import { receiptHtml } from './billing-documents';
import type { WorkspaceRecord } from './billing-store';
import { isAdminEmail, sameOrigin, sessionOf, type HostedOptions } from './hosted';
import type { AdminUser } from './admin-login';
import { SignupError, TERMS_VERSION, signUp } from './self-serve-workspaces';
import { PII_ADDON_ID, PII_ADDON_NAME, customerPiiModes, piiPricePerMTokens } from './addons';
import type { KeyCaps } from './issued-keys';
import { BYOK_KINDS, WorkspaceProviderError, isMediaKind, wavespeedModelIds, type WorkspaceProvider } from './workspace-providers';
import { mediaModel, MEDIA_PRICING_SOURCES } from './media-catalog';

/**
 * The customer's side of hosted Valefront, for anyone signed in with Aegis: /dashboard/me/… on the dashboard host.
 * Every route is scoped to the signed-in account's own workspace (the Aegis subject is the tenant boundary); ids
 * from another workspace are "not found". Writes need the dashboard's own origin.
 *
 * Also the PayPal webhook (/webhooks/paypal), checked with PayPal's signature verification, and SePay's
 * (/webhooks/sepay), checked with its API key.
 */

type CustomerRequest = Request & { customer?: AdminUser; ws?: WorkspaceRecord; rawBody?: Buffer };

/** Self-serve keys: per-minute abuse limit (the free tier's own limits are in BillingService.admit). */
export const SELF_SERVE_KEY_CAPS = { requestsPerMinute: 60 };
const MAX_KEYS = 20;

export function clientIp(req: Request): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf;
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0]!.trim();
  return req.socket?.remoteAddress ?? '';
}

function errorOut(res: Response, err: unknown): void {
  if (err instanceof BillingError || err instanceof SignupError || err instanceof WorkspaceProviderError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  console.error('[customer] request failed', err);
  res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong; try again.' } });
}

export function mountCustomerRoutes(app: Express, opts: HostedOptions): void {
  const signedIn = (req: Request, res: Response, next: NextFunction) => {
    const who = sessionOf(opts, req);
    if (!who) return res.status(401).json({ error: { code: 'sign_in_required', message: 'Sign in to continue.' } });
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(opts, req)) return res.status(403).json({ error: { code: 'forbidden', message: 'Cross-site request refused.' } });
    (req as CustomerRequest).customer = who;
    next();
  };
  const billingOn = (_req: Request, res: Response, next: NextFunction) => {
    if (!opts.billing) return res.status(503).json({ error: { code: 'billing_unavailable', message: 'Sign-up is not available on this server.' } });
    next();
  };
  const withWorkspace = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ws = await opts.billing!.store.workspaceBySub((req as CustomerRequest).customer!.sub);
      if (!ws) return res.status(409).json({ error: { code: 'workspace_required', message: 'Finish signing up first.' } });
      (req as CustomerRequest).ws = ws;
      next();
    } catch (err) {
      errorOut(res, err);
    }
  };
  const turnstileOk = async (req: Request): Promise<boolean> => {
    const token = typeof req.body?.turnstileToken === 'string' ? req.body.turnstileToken : '';
    return Boolean(opts.turnstile) && (await opts.turnstile!.verify(token, clientIp(req)));
  };
  /** An order for its owner; a SePay one with what has arrived toward it so far. */
  const view = async (order: import('./billing').BillingOrder, approveUrl?: string) =>
    orderView(order, approveUrl, order.method === 'sepay' ? await opts.billing!.store.sepayReceived(order.id) : 0, opts.billing!.opts.now?.() ?? Date.now());
  const me = [signedIn, billingOn];
  const mine = [signedIn, billingOn, withWorkspace];
  const ws = (req: Request) => (req as CustomerRequest).ws!;

  // ── who am I, and where am I in sign-up ───────────────────────────────────────────────────────────────
  app.get('/dashboard/me', ...me, async (req, res) => {
    try {
      const who = (req as CustomerRequest).customer!;
      const billing = opts.billing!;
      const workspace = await billing.store.workspaceBySub(who.sub);
      const free = billing.opts.free;
      const grant = workspace ? await billing.store.grant(workspace.id) : null;
      const keys = workspace ? (await opts.keys.listForWorkspace(workspace.id)).filter((k) => !k.revokedAt) : [];
      const onboarding = !workspace ? (who.emailVerified ? 'terms' : 'email_verification') : keys.length ? 'complete' : 'key';
      const balance = workspace ? await billing.store.balance(workspace.id) : null;
      res.json({
        email: who.email,
        name: who.name ?? null,
        emailVerified: Boolean(who.emailVerified),
        admin: isAdminEmail(opts, who.email),
        onboarding,
        termsVersion: TERMS_VERSION,
        termsUrl: 'https://valefront.com/terms',
        privacyUrl: 'https://valefront.com/privacy',
        privacyContact: 'privacy@valefront.com',
        turnstileSiteKey: opts.turnstile?.siteKey ?? null,
        apiBaseUrl: opts.publicUrl,
        workspace: workspace ? { id: workspace.id, createdAt: workspace.createdAt, suspended: Boolean(workspace.suspendedAt) } : null,
        balanceCents: balance ? Math.floor(balance.availableMicros / 10_000) : null,
        freeTier: {
          tokens: free.tokens,
          bonusTokens: free.bonusTokens ?? 0,
          expiresAfterDays: free.expiresAfterDays,
          models: free.models,
          tokensPerDay: free.tokensPerDay,
          granted: grant ? { tokens: grant.tokens, usedTokens: grant.usedTokens, expiresAt: grant.expiresAt, bonusUnlocked: grant.tokens >= free.tokens + (free.bonusTokens ?? 0) } : null,
        },
      });
    } catch (err) {
      errorOut(res, err);
    }
  });

  /** Terms + verified email + Turnstile -> the workspace (and its free grant) and the first API key, shown once. */
  app.post('/dashboard/me/workspace', ...me, async (req, res) => {
    try {
      const who = (req as CustomerRequest).customer!;
      if (!opts.turnstile) throw new SignupError('turnstile_unavailable', 'Sign-up is paused: the security check is not configured.', 503);
      const result = await signUp(opts.billing!.store, {
        identity: { sub: who.sub, email: who.email, emailVerified: Boolean(who.emailVerified), ...(who.name ? { name: who.name } : {}) },
        acceptTerms: req.body?.acceptTerms === true,
        termsVersion: String(req.body?.termsVersion ?? ''),
        turnstileToken: typeof req.body?.turnstileToken === 'string' ? req.body.turnstileToken : '',
        ip: clientIp(req),
      }, { verifyTurnstile: opts.turnstile.verify, free: opts.billing!.opts.free });
      let key: string | null = null;
      if (result.created) {
        const made = await opts.keys.create({ name: 'Default key', caps: SELF_SERVE_KEY_CAPS, by: who.email, workspaceId: result.workspace.id });
        key = made.key;
        await opts.billing!.store.audit({ type: 'api_key.created', workspaceId: result.workspace.id, meta: { keyId: made.record.id } });
      }
      res.status(result.created ? 201 : 200).json({ workspace: { id: result.workspace.id }, created: result.created, freeGrant: result.granted, key });
    } catch (err) {
      errorOut(res, err);
    }
  });

  // ── API keys ───────────────────────────────────────────────────────────────────────────────────────────
  const keyView = (k: Awaited<ReturnType<HostedOptions['keys']['listForWorkspace']>>[number]) => ({
    id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt, revokedAt: k.revokedAt ?? null, lastUsedAt: k.lastUsedAt ?? null,
    piiProtection: piiModeOf(k.caps),
    routingStrategy: k.caps.routingStrategy ?? null,
    usage: { month: k.usage.month, requests: k.usage.requests, promptTokens: k.usage.promptTokens, completionTokens: k.usage.completionTokens, byModel: k.usage.byModel, addons: k.usage.addons ?? {}, promotions: k.usage.promotions ?? {} },
  });
  /** The PII protection add-on as the dashboard offers it: price and the modes this server has. */
  const piiOffer = () => ({ id: PII_ADDON_ID, name: PII_ADDON_NAME, unit: 'per 1M input tokens', price: piiPricePerMTokens(), currency: 'USD', modes: customerPiiModes() });
  /** A customer's choice -> the mode stored on the key: off, regex, or presidio only where it's offered. */
  const piiChoice = (enabled: unknown, mode: unknown): 'off' | 'regex' | 'presidio' => {
    if (enabled !== true) return 'off';
    if (mode === undefined || mode === null || mode === '' || mode === 'regex') return 'regex';
    if (mode === 'presidio' && customerPiiModes().includes('presidio')) return 'presidio';
    throw new BillingError('pii_mode_unavailable', 'That PII protection mode is not available; use "regex".', 400);
  };
  app.get('/dashboard/me/keys', ...mine, async (req, res) => {
    res.json({ keys: (await opts.keys.listForWorkspace(ws(req).id)).map(keyView), addons: { piiProtection: piiOffer() } });
  });
  app.post('/dashboard/me/keys', ...mine, async (req, res) => {
    try {
      if (ws(req).suspendedAt) throw new BillingError('workspace_suspended', 'This workspace is suspended.', 403);
      if (!(await turnstileOk(req))) throw new SignupError('turnstile_failed', 'The security check did not pass; try it again.', 403);
      const active = (await opts.keys.listForWorkspace(ws(req).id)).filter((k) => !k.revokedAt);
      if (active.length >= MAX_KEYS) throw new BillingError('too_many_keys', `A workspace can have ${MAX_KEYS} active keys; revoke one first.`, 409);
      const name = String(req.body?.name ?? '').trim() || 'API key';
      const pii = piiChoice(req.body?.piiProtection, req.body?.piiMode);
      const caps: KeyCaps = { ...SELF_SERVE_KEY_CAPS, ...(pii !== 'off' ? { piiRedaction: pii } : {}) };
      const { key, record } = await opts.keys.create({ name, caps, by: (req as CustomerRequest).customer!.email, workspaceId: ws(req).id });
      await opts.billing!.store.audit({ type: 'api_key.created', workspaceId: ws(req).id, meta: { keyId: record.id, ...(pii !== 'off' ? { piiProtection: pii } : {}) } });
      res.status(201).json({ key, record: { id: record.id, name: record.name, prefix: record.prefix, createdAt: record.createdAt, piiProtection: piiModeOf(record.caps) } });
    } catch (err) {
      errorOut(res, err);
    }
  });
  /**
   * The chat routing strategy one of your keys uses for `model: "auto"`: { strategy: 'cheapest' | 'best' | 'fastest'
   * | 'balanced' | null } (null: auto routes as before). Only this cap changes. Another workspace's key is "not found".
   */
  app.put('/dashboard/me/keys/:id/routing', ...mine, async (req, res) => {
    try {
      const record = await opts.keys.get(String(req.params.id));
      if (!record || record.workspaceId !== ws(req).id) return res.status(404).json({ error: { code: 'not_found', message: 'Key not found.' } });
      if (record.revokedAt) throw new BillingError('key_revoked', 'This key is revoked.', 409);
      const strategy = req.body?.strategy ?? null;
      if (strategy !== null && !isRoutingStrategy(strategy)) {
        throw new BillingError('unknown_routing_strategy', `Send { "strategy": ${ROUTING_STRATEGIES.map((s) => `"${s}"`).join(' | ')} | null }.`, 400);
      }
      const { routingStrategy: _previous, ...rest } = record.caps;
      const saved = await opts.keys.setCaps(record.id, strategy ? { ...rest, routingStrategy: strategy } : rest);
      await opts.billing!.store.audit({ type: 'api_key.routing_strategy', workspaceId: ws(req).id, meta: { keyId: record.id, strategy } });
      res.json({ id: saved.id, routingStrategy: saved.caps.routingStrategy ?? null });
    } catch (err) {
      errorOut(res, err);
    }
  });
  app.delete('/dashboard/me/keys/:id', ...mine, async (req, res) => {
    const record = await opts.keys.get(String(req.params.id));
    if (!record || record.workspaceId !== ws(req).id) return res.status(404).json({ error: { code: 'not_found', message: 'Key not found.' } });
    await opts.keys.revoke(record.id);
    await opts.billing!.store.audit({ type: 'api_key.revoked', workspaceId: ws(req).id, meta: { keyId: record.id } });
    res.json({ ok: true });
  });

  /**
   * PII protection on one of your own keys: { enabled: boolean, mode?: 'regex' | 'presidio' }. Only the PII mode
   * changes (the key's other caps, and any allowlist the owner set, stay). Another workspace's key is "not found".
   */
  app.put('/dashboard/me/keys/:id/pii', ...mine, async (req, res) => {
    try {
      const record = await opts.keys.get(String(req.params.id));
      if (!record || record.workspaceId !== ws(req).id) return res.status(404).json({ error: { code: 'not_found', message: 'Key not found.' } });
      if (ws(req).suspendedAt) throw new BillingError('workspace_suspended', 'This workspace is suspended.', 403);
      if (record.revokedAt) throw new BillingError('key_revoked', 'This key is revoked.', 409);
      if (typeof req.body?.enabled !== 'boolean') throw new BillingError('invalid_request', 'Send { "enabled": true } or { "enabled": false }.', 400);
      const mode = piiChoice(req.body.enabled, req.body.mode);
      const saved = await opts.keys.setCaps(record.id, { ...record.caps, piiRedaction: mode });
      await opts.billing!.store.audit({ type: mode === 'off' ? 'api_key.pii_protection_off' : 'api_key.pii_protection_on', workspaceId: ws(req).id, meta: { keyId: record.id, mode } });
      res.json({ id: saved.id, piiProtection: piiModeOf(saved.caps), addon: piiOffer() });
    } catch (err) {
      errorOut(res, err);
    }
  });

  app.get('/dashboard/me/usage', ...mine, async (req, res) => {
    const keys = await opts.keys.listForWorkspace(ws(req).id);
    const grant = await opts.billing!.store.grant(ws(req).id);
    res.json({
      month: keys[0]?.usage.month ?? new Date().toISOString().slice(0, 7),
      keys: keys.map(keyView),
      free: grant ? { tokens: grant.tokens, usedTokens: grant.usedTokens, expiresAt: grant.expiresAt } : null,
      addons: { piiProtection: piiOffer() },
    });
  });

  // ── your providers (BYOK: src/core/workspace-providers.ts) ─────────────────────────────────────────────
  // Your own provider accounts (Azure OpenAI, an OpenAI-compatible gateway, Anthropic, WaveSpeed for images and
  // video), used only by your keys for
  // the models you list, billed by that provider. Keys are write-only: sent on add (or to replace), never returned.
  const providersOn = (_req: Request, res: Response, next: NextFunction) => {
    if (!opts.workspaceProviders) return res.status(503).json({ error: { code: 'providers_unavailable', message: 'Your own providers are not available on this server.' } });
    next();
  };
  const theirs = [...mine, providersOn];
  const providerView = (p: WorkspaceProvider) => ({
    id: p.id, kind: p.kind, label: p.label, baseUrl: p.baseUrl, deployment: p.deployment, apiVersion: p.apiVersion, models: p.models,
    enabled: p.enabled, createdAt: p.createdAt, updatedAt: p.updatedAt, spendLine: `BYOK:${p.label}`,
  });
  const notSuspended = (req: Request) => {
    if (ws(req).suspendedAt) throw new BillingError('workspace_suspended', 'This workspace is suspended.', 403);
  };
  app.get('/dashboard/me/providers', ...theirs, async (req, res) => {
    try {
      const providers = await opts.workspaceProviders!.list(ws(req).id);
      // The image and video models the workspace's own media providers serve (for the Playground), billed by them.
      const seen = new Set<string>();
      const mediaModels = providers.filter((p) => p.enabled && isMediaKind(p.kind)).flatMap((p) => p.models.flatMap((id) => {
        const m = mediaModel(id);
        if (!m || seen.has(id)) return [];
        seen.add(id);
        return [{ id: m.id, name: m.name, kind: m.kind, provider: `BYOK:${p.label}`, source: MEDIA_PRICING_SOURCES[m.provider], byok: true }];
      }));
      res.json({ providers: providers.map(providerView), kinds: BYOK_KINDS, wavespeedModels: wavespeedModelIds(), mediaModels });
    } catch (err) {
      errorOut(res, err);
    }
  });
  app.post('/dashboard/me/providers', ...theirs, async (req, res) => {
    try {
      notSuspended(req);
      const b = req.body ?? {};
      const saved = await opts.workspaceProviders!.add(ws(req).id, { kind: b.kind, label: b.label, baseUrl: b.baseUrl, deployment: b.deployment, apiVersion: b.apiVersion, models: b.models, apiKey: b.apiKey, enabled: b.enabled }, (req as CustomerRequest).customer!.email);
      await opts.billing!.store.audit({ type: 'workspace_provider.added', workspaceId: ws(req).id, meta: { id: saved.id, label: saved.label, kind: saved.kind } });
      res.status(201).json({ provider: providerView(saved) });
    } catch (err) {
      errorOut(res, err);
    }
  });
  app.patch('/dashboard/me/providers/:id', ...theirs, async (req, res) => {
    try {
      notSuspended(req);
      const b = req.body ?? {};
      const saved = await opts.workspaceProviders!.update(ws(req).id, String(req.params.id), { kind: b.kind, label: b.label, baseUrl: b.baseUrl, deployment: b.deployment, apiVersion: b.apiVersion, models: b.models, apiKey: b.apiKey, enabled: b.enabled });
      await opts.billing!.store.audit({ type: 'workspace_provider.updated', workspaceId: ws(req).id, meta: { id: saved.id, label: saved.label, keyReplaced: b.apiKey !== undefined } });
      res.json({ provider: providerView(saved) });
    } catch (err) {
      errorOut(res, err);
    }
  });
  app.delete('/dashboard/me/providers/:id', ...theirs, async (req, res) => {
    try {
      const removed = await opts.workspaceProviders!.remove(ws(req).id, String(req.params.id));
      if (!removed) return res.status(404).json({ error: { code: 'not_found', message: 'Provider not found.' } });
      await opts.billing!.store.audit({ type: 'workspace_provider.removed', workspaceId: ws(req).id, meta: { id: String(req.params.id) } });
      res.json({ removed: true });
    } catch (err) {
      errorOut(res, err);
    }
  });
  /** One tiny request through it ("Reply with OK.", 16 tokens max), not counted: { ok, status, model, ms }. */
  app.post('/dashboard/me/providers/:id/test', ...theirs, async (req, res) => {
    try {
      notSuspended(req);
      const model = typeof req.body?.model === 'string' ? req.body.model : undefined;
      res.json(await opts.workspaceProviders!.test(ws(req).id, String(req.params.id), model));
    } catch (err) {
      errorOut(res, err);
    }
  });

  // ── billing ────────────────────────────────────────────────────────────────────────────────────────────
  app.get('/dashboard/me/billing', ...mine, async (req, res) => {
    try {
      res.json({ ...(await opts.billing!.overview(ws(req))), email: ws(req).email });
    } catch (err) {
      errorOut(res, err);
    }
  });
  /** A promo code (campaigns.ts): { code }. The workspace pays the campaign's promo prices until it ends. */
  app.post('/dashboard/me/billing/promo-code', ...mine, async (req, res) => {
    try {
      const result = await opts.billing!.redeemPromoCode(ws(req), req.body?.code);
      res.status(result.already ? 200 : 201).json({ ...result, promotions: await opts.billing!.promotions(ws(req)) });
    } catch (err) {
      errorOut(res, err);
    }
  });
  app.put('/dashboard/me/billing/profile', ...mine, async (req, res) => {
    try {
      res.json({ profile: await opts.billing!.saveProfile(ws(req), req.body) });
    } catch (err) {
      errorOut(res, err);
    }
  });
  app.put('/dashboard/me/billing/vat-invoice', ...mine, async (req, res) => {
    try {
      res.json({ vatInvoice: await opts.billing!.saveVatInvoiceDetails(ws(req), req.body) });
    } catch (err) {
      errorOut(res, err);
    }
  });
  app.post('/dashboard/me/billing/orders', ...mine, async (req, res) => {
    try {
      if (ws(req).suspendedAt) throw new BillingError('workspace_suspended', 'This workspace is suspended.', 403);
      const amountCents = Number(req.body?.amountCents);
      const method = String(req.body?.method ?? '') as PaymentMethod;
      const idempotencyKey = String(req.body?.idempotencyKey ?? '');
      // A retried click (same idempotency key) gets its order back without another security check.
      const replay = idempotencyKey ? await opts.billing!.store.orderByIdempotencyKey(ws(req).id, idempotencyKey) : null;
      if (!replay && !(await turnstileOk(req))) throw new SignupError('turnstile_failed', 'The security check did not pass; try it again.', 403);
      const result = await opts.billing!.createOrder(ws(req), { amountCents, method, idempotencyKey, vatInvoice: req.body?.vatInvoice === true });
      res.status(201).json(await view(result.order, result.approveUrl));
    } catch (err) {
      errorOut(res, err);
    }
  });
  app.get('/dashboard/me/billing/orders/:id', ...mine, async (req, res) => {
    const order = await opts.billing!.store.order(String(req.params.id));
    if (!order || order.workspaceId !== ws(req).id) return res.status(404).json({ error: { code: 'not_found', message: 'Order not found.' } });
    res.json(await view(order));
  });
  /** SePay: "I've paid, check now" (asks SePay at most every 15 s per workspace; sooner returns the order as it is). */
  app.post('/dashboard/me/billing/orders/:id/sepay-check', ...mine, async (req, res) => {
    try {
      const { order, checked } = await opts.billing!.checkSepay(ws(req), String(req.params.id));
      res.json({ ...(await view(order)), checked });
    } catch (err) {
      errorOut(res, err);
    }
  });
  /** SePay: a new VND quote for a pending order whose 30 minutes ran out. */
  app.post('/dashboard/me/billing/orders/:id/sepay-quote', ...mine, async (req, res) => {
    try {
      res.json(await view(await opts.billing!.requoteSepay(ws(req), String(req.params.id))));
    } catch (err) {
      errorOut(res, err);
    }
  });
  app.post('/dashboard/me/billing/orders/:id/cancel', ...mine, async (req, res) => {
    const ok = await opts.billing!.store.cancelOrder(String(req.params.id), ws(req).id);
    if (!ok) return res.status(409).json({ error: { code: 'not_cancellable', message: 'Only a pending order of yours can be cancelled.' } });
    res.json({ ok: true });
  });
  /**
   * Ask for a VAT invoice for a paid order of yours (within 30 days of paying), with your saved VAT invoice details:
   * issued automatically while S-Invoice is set up, else recorded as a request we issue by hand. Asking again returns it.
   */
  app.post('/dashboard/me/billing/orders/:id/vat-invoice', ...mine, async (req, res) => {
    try {
      const e = await opts.billing!.requestVatInvoice(ws(req), String(req.params.id));
      res.json({ einvoice: { id: e.id, orderId: e.orderId, status: e.status === 'issuing' || e.status === 'failed' ? 'pending' : e.status, manual: Boolean(e.manual), invoiceNo: e.record?.invoiceNo ?? null } });
    } catch (err) {
      errorOut(res, err);
    }
  });
  app.post('/dashboard/me/billing/orders/:id/paypal-capture', ...mine, async (req, res) => {
    try {
      const order = await opts.billing!.capturePayPal(ws(req), String(req.params.id));
      res.json(orderView(order));
    } catch (err) {
      errorOut(res, err);
    }
  });

  app.get('/dashboard/me/billing/receipts/:id', ...mine, async (req, res) => {
    try {
      const raw = String(req.params.id);
      const pdf = raw.endsWith('.pdf');
      const id = pdf ? raw.slice(0, -4) : raw;
      const receipt = await opts.billing!.store.receipt(id);
      if (!receipt || receipt.workspaceId !== ws(req).id) return res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } });
      res.setHeader('Cache-Control', 'private, no-store');
      if (!pdf) return res.type('html').send(receiptHtml(receipt, `/dashboard/me/billing/receipts/${receipt.id}.pdf`));
      const bytes = await opts.billing!.pdf('receipt', id);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${receipt.number}.pdf"`);
      return res.end(Buffer.from(bytes!));
    } catch (err) {
      errorOut(res, err);
    }
  });
  /** The VAT e-invoice's PDF, as Viettel S-Invoice rendered it (or as an admin uploaded it for one issued by hand). */
  app.get('/dashboard/me/billing/einvoices/:id', ...mine, async (req, res) => {
    try {
      const id = String(req.params.id).replace(/\.pdf$/, '');
      const e = await opts.billing!.store.einvoice(id);
      if (!e || e.workspaceId !== ws(req).id) return res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } });
      if (e.status !== 'issued' || !e.record) return res.status(409).json({ error: { code: 'einvoice_pending', message: 'Your VAT invoice is being issued.' } });
      const bytes = await opts.billing!.pdf('einvoice', id);
      if (!bytes && e.record.provider === 'manual') return res.status(404).json({ error: { code: 'einvoice_no_file', message: `This invoice has no file here: look it up with its code${e.record.reservationCode ? ` ${e.record.reservationCode}` : ''}${e.record.lookupUrl ? ` at ${e.record.lookupUrl}` : ''}, or see the email we sent.` } });
      if (!bytes) return res.status(503).json({ error: { code: 'einvoice_unavailable', message: 'The invoice file is not available right now; try again later.' } });
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${e.record.invoiceNo.replace(/[^A-Za-z0-9_-]/g, '_')}.pdf"`);
      return res.end(Buffer.from(bytes));
    } catch (err) {
      errorOut(res, err);
    }
  });

  // ── your data (GDPR) ───────────────────────────────────────────────────────────────────────────────────
  app.get('/dashboard/me/export', ...mine, async (req, res) => {
    try {
      const w = ws(req);
      const store = opts.billing!.store;
      const keys = await opts.keys.listForWorkspace(w.id);
      const [grant, profile, ledger, orders, einvoices, receipts, events] = await Promise.all([
        store.grant(w.id), store.profile(w.id), store.ledger(w.id, 100_000), store.orders(w.id), store.einvoices(w.id), store.receipts(w.id), store.auditEvents(w.id),
      ]);
      const usage = await Promise.all(keys.map(async (k) => ({ keyId: k.id, months: await opts.keys.allUsage(k.id) })));
      // Your own providers as configured (never their keys).
      const providers = opts.workspaceProviders ? (await opts.workspaceProviders.list(w.id)).map(providerView) : [];
      const body = {
        exportedAt: new Date().toISOString(),
        controller: 'THE AI TECHNOLOGY COMPANY LIMITED, privacy@valefront.com',
        profile: { email: w.email, name: w.name ?? null, aegisSubject: w.ownerSub, workspaceId: w.id, createdAt: new Date(w.createdAt).toISOString(), termsVersion: w.termsVersion, termsAcceptedAt: new Date(w.termsAcceptedAt).toISOString() },
        billingProfile: profile,
        freeGrant: grant,
        keys: keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt, revokedAt: k.revokedAt ?? null, lastUsedAt: k.lastUsedAt ?? null, caps: k.caps })),
        usage,
        providers,
        ledger,
        orders: orders.map((o) => ({ ...o, account: undefined })),
        receipts,
        vatInvoices: einvoices,
        events,
      };
      res.setHeader('Content-Disposition', `attachment; filename="valefront-data-${w.id}.json"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.type('json').send(JSON.stringify(body, null, 2));
    } catch (err) {
      errorOut(res, err);
    }
  });
  app.delete('/dashboard/me', ...mine, async (req, res) => {
    try {
      const w = ws(req);
      if (String(req.body?.confirm ?? '').trim().toLowerCase() !== w.email) {
        throw new BillingError('confirmation_required', 'Type your email address to confirm.', 400);
      }
      const keys = await opts.keys.deleteWorkspaceKeys(w.id);
      // Your own providers' keys go with the workspace.
      if (opts.workspaceProviders) await opts.workspaceProviders.removeAll(w.id);
      await opts.billing!.store.deleteWorkspace(w.id);
      console.log(JSON.stringify({ event: 'workspace_deleted', workspaceId: w.id, keys }));
      res.setHeader('Set-Cookie', [cookie('leyline_session', '', 0), cookie('leyline_refresh', '', 0)]);
      res.json({ deleted: true, kept: 'Receipts, VAT invoices, payments and the credit ledger are kept for 10 years for accounting, then deleted.' });
    } catch (err) {
      errorOut(res, err);
    }
  });

  // ── PayPal webhook ─────────────────────────────────────────────────────────────────────────────────────
  app.post('/webhooks/paypal', async (req, res) => {
    if (!opts.billing) return res.status(404).end();
    const raw = (req as CustomerRequest).rawBody?.toString('utf8') ?? '';
    try {
      const out = await opts.billing.handlePayPalWebhook(req.headers, raw);
      res.status(out.status).json(out.body);
    } catch (err) {
      // 5xx: PayPal retries later.
      console.error('[paypal] webhook failed', err);
      res.status(500).json({ error: 'retry' });
    }
  });

  // ── SePay webhook ──────────────────────────────────────────────────────────────────────────────────────
  app.post('/webhooks/sepay', async (req, res) => {
    if (!opts.billing) return res.status(404).end();
    try {
      const out = await opts.billing.handleSepayWebhook(req.headers, req.body);
      res.status(out.status).json(out.body);
    } catch (err) {
      // 5xx: SePay retries (its transaction id keeps a retry from counting twice).
      console.error('[sepay] webhook failed', err instanceof Error ? err.message : err);
      res.status(500).json({ success: false, error: 'retry' });
    }
  });
}

/** A key's PII protection as customers see it: 'off', or the mode it runs in. */
function piiModeOf(caps: KeyCaps): 'off' | 'regex' | 'presidio' {
  return caps.piiRedaction === 'regex' || caps.piiRedaction === 'presidio' ? caps.piiRedaction : 'off';
}

function orderView(order: import('./billing').BillingOrder, approveUrl?: string, receivedVnd = 0, now = Date.now()) {
  const q = order.quote;
  // After a part payment, the QR asks for what is left.
  const leftVnd = q ? Math.max(0, q.vndAmount - receivedVnd) : 0;
  const qrUrl = q && receivedVnd > 0 ? (() => { const u = new URL(q.qrUrl); u.searchParams.set('amount', String(leftVnd)); return u.toString(); })() : q?.qrUrl;
  return {
    id: order.id,
    method: order.method,
    status: order.status,
    amountCents: order.amountCents,
    vatRateBp: order.vatRateBp,
    vatCents: order.vatCents,
    totalCents: order.totalCents,
    currency: order.currency,
    reference: order.reference,
    vatInvoice: Boolean(order.einvoiceRequest),
    createdAt: order.createdAt,
    paidAt: order.paidAt ?? null,
    ...(order.method === 'worldfirst' && order.status === 'pending' && order.account ? {
      bankTransfer: {
        account: order.account,
        amount: order.totalCents,
        reference: order.reference,
        instructions: [
          `Send exactly ${(order.totalCents / 100).toFixed(2)} USD to the account below.`,
          `Put the reference ${order.reference} in the transfer's message or reference field, so we can match it.`,
          'Pay any bank fees on your side (choose "OUR" for the charges) so the full amount arrives.',
          'Your credit is added when the transfer arrives, usually in 1–3 business days. You get a receipt by email.',
        ],
      },
    } : {}),
    ...(order.method === 'sepay' && q ? {
      sepay: {
        qrUrl,
        bankName: q.bank.bankName,
        bankId: q.bank.bankId,
        accountNumber: q.bank.accountNumber,
        accountName: q.bank.accountName,
        amountVnd: q.vndAmount,
        receivedVnd,
        leftVnd,
        transferContent: q.transferContent,
        vndPerUsd: q.vndPerUsd,
        rateDate: q.rateDate,
        expiresAt: q.expiresAt,
        expired: now > q.expiresAt,
      },
    } : {}),
    ...(approveUrl ? { approveUrl } : {}),
  };
}

