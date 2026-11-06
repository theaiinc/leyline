import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { BillingError, METHOD_LABELS, cleanAccount, cleanLegal, cleanVat, cleanVatInvoiceDetails, decimalToCents, formatUsd, vatLabel, type BillingOrder, type EInvoice } from './billing';
import { SETTINGS, type ExchangeRateSetting } from './billing-service';
import { accessAdmin } from './cloudflare-access';
import { ModeChangeError, PROVIDERS, providerStatus, setMode, type ProviderId } from './provider-modes';
import type { HostedOptions } from './hosted';

/**
 * The platform admin host (adm.valefront.com), behind a Cloudflare Access application, plus this app's own check
 * of the Access token (cloudflare-access.ts) on every request for that host (adminHostGate). dash.valefront.com is
 * the customers' dashboard; the owner's dashboard (providers, routing, offered models, spending...) is served here,
 * and customer billing is administered under /billing:
 *
 *   GET  /billing/                  orders, settings, PayPal mode
 *   GET  /api/orders?status=        orders as JSON (automation, with an Access service token)
 *   POST /orders/:id/mark-paid      WorldFirst transfer arrived (or a SePay one to settle by hand): credit, invoice, receipt, email (once)
 *   POST /sepay/poll                ask SePay for its latest transactions now (what the 15-minute cron does)
 *   POST /orders/:id/resend-email   send the receipt email again
 *   POST /settings/worldfirst | /settings/legal | /settings/vat | /settings/exchange-rate
 *   POST /providers/:id/mode         Sandbox | Live for PayPal or Viettel S-Invoice (live: type LIVE)
 *   POST /einvoices/process          run the e-invoice retry job now
 *   POST /einvoices/:id/retry        retry a failed VAT e-invoice
 *   POST /einvoices/:id/cancel       cancel an issued e-invoice at Viettel (with the agreement's description)
 *   POST /einvoices/:id/replace      issue a replacement e-invoice with corrected buyer details
 *
 * Partner inquiries (the valefront.com form) are administered under /partners (partner-inquiries.ts).
 */
type AdminRequest = Request & { billingAdmin?: string; accessAdmin?: string };

/** Every request for the admin host: a platform admin through Cloudflare Access (or an Access service token), or 403. */
export function adminHostGate(opts: HostedOptions) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!isAdminHost(opts, req)) return next();
    const who = await accessAdmin(typeof req.headers['cf-access-jwt-assertion'] === 'string' ? req.headers['cf-access-jwt-assertion'] : undefined, opts.access, opts.adminEmails);
    if (!who) {
      res.status(opts.access ? 403 : 503).type('text').send(opts.access ? 'Not allowed.' : 'The admin host is not configured (CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD).');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      const origin = req.headers.origin;
      if (origin ? origin !== `https://${opts.adminHost}` : !who.startsWith('service:')) {
        res.status(403).type('text').send('Cross-site request refused.');
        return;
      }
    }
    (req as AdminRequest).accessAdmin = who;
    next();
  };
}

/** The platform admin this request was let through as (adminHostGate), if any. */
export function accessAdminOf(req: Request): string | null {
  return (req as AdminRequest).accessAdmin ?? null;
}

const esc = (t: unknown) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The admin host's server pages share this header: Billing · Partners (and the owner dashboard). */
export function adminNav(current: 'billing' | 'partners'): string {
  const link = (id: 'billing' | 'partners', href: string, label: string) => (id === current ? `<strong>${label}</strong>` : `<a href="${href}">${label}</a>`);
  return `<nav class="adminnav">${link('billing', '/billing/', 'Billing')} · ${link('partners', '/partners/', 'Partners')} · <a href="/">Dashboard</a></nav>`;
}

export function isAdminHost(opts: HostedOptions, req: Request): boolean {
  const host = String(req.headers.host ?? '').toLowerCase().split(':')[0];
  return Boolean(opts.adminHost) && host === opts.adminHost!.toLowerCase();
}

export function mountAdminBilling(app: Express, opts: HostedOptions): void {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '64kb' }));
  router.use((req: Request, res: Response, next: NextFunction) => {
    // adminHostGate already checked Cloudflare Access and the request's origin.
    const who = accessAdminOf(req);
    if (!who) return res.status(403).type('text').send('Not allowed.');
    if (!opts.billing) return res.status(503).type('text').send('Billing is not configured on this server.');
    (req as AdminRequest).billingAdmin = who;
    next();
  });

  const back = (res: Response, note: string) => res.redirect(303, `/billing/?note=${encodeURIComponent(note)}`);
  const fail = (req: Request, res: Response, err: unknown) => {
    const message = err instanceof BillingError ? err.message : 'Failed; see the Worker logs.';
    if (!(err instanceof BillingError)) console.error('[admin-billing]', err);
    if (req.path.startsWith('/api/') || req.headers.accept?.includes('application/json')) return res.status(err instanceof BillingError ? err.status : 500).json({ error: message });
    return back(res, `Error: ${message}`);
  };

  router.get('/api/orders', async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    res.json({ orders: await opts.billing!.store.allOrders(status) });
  });

  router.post('/orders/:id/mark-paid', async (req, res) => {
    try {
      const billing = opts.billing!;
      const order = await billing.store.order(String(req.params.id));
      if (!order) throw new BillingError('order_not_found', 'Order not found.', 404);
      // SePay credits itself; by hand only for what it can't settle (an underpayment the admin accepts, a mangled reference).
      if (order.method !== 'worldfirst' && order.method !== 'sepay') throw new BillingError('not_manual', 'Only bank-transfer orders are marked paid by hand; PayPal credits itself.', 409);
      const bankReference = String(req.body?.bankReference ?? '').trim().slice(0, 100) || null;
      const received = typeof req.body?.receivedUsd === 'string' && req.body.receivedUsd.trim() ? decimalToCents(req.body.receivedUsd) : order.totalCents;
      if (received !== order.totalCents) throw new BillingError('amount_mismatch', `The order is for ${formatUsd(order.totalCents)}; received ${received === null ? 'an invalid amount' : formatUsd(received)}. Not marked paid.`, 409);
      const { transitioned } = await billing.markPaid(order.id, { by: (req as AdminRequest).billingAdmin!, captureId: bankReference });
      if (req.headers.accept?.includes('application/json')) return res.json({ transitioned });
      back(res, transitioned ? `Order ${order.reference} marked paid; credit, invoice and receipt issued.` : `Order ${order.reference} was already paid; nothing changed.`);
    } catch (err) {
      fail(req, res, err);
    }
  });

  router.post('/orders/:id/resend-email', async (req, res) => {
    try {
      const sent = await opts.billing!.resendEmail(String(req.params.id));
      back(res, sent ? 'Receipt email sent.' : 'The email was not sent (no receipt yet, or sending failed: see logs).');
    } catch (err) {
      fail(req, res, err);
    }
  });

  const saver = (key: string, clean: (body: Record<string, unknown>) => unknown) => async (req: Request, res: Response) => {
    try {
      await opts.billing!.store.saveSetting(key, clean(req.body ?? {}), (req as AdminRequest).billingAdmin!);
      back(res, 'Saved.');
    } catch (err) {
      fail(req, res, err);
    }
  };
  router.post('/settings/worldfirst', saver(SETTINGS.account, (b) => cleanAccount(b)));
  router.post('/settings/legal', saver(SETTINGS.legal, (b) => cleanLegal(b)));
  router.post('/settings/vat', saver(SETTINGS.vat, (b) => {
    const byCountry: Record<string, unknown> = {};
    for (const line of String(b.byCountry ?? '').split(/[\n,]+/)) {
      const [country, rate] = line.split(/[=:]/).map((x) => x?.trim());
      if (country) byCountry[country] = Number(rate);
    }
    return cleanVat({ defaultBp: Number(b.defaultBp ?? 0), byCountry });
  }));

  router.post('/settings/exchange-rate', async (req, res) => {
    try {
      const vndPerUsd = Number(String(req.body?.vndPerUsd ?? '').replace(/[,\s]/g, ''));
      if (!Number.isFinite(vndPerUsd) || vndPerUsd < 1000 || vndPerUsd > 100_000) throw new BillingError('fx_invalid', 'Enter VND per 1 USD, e.g. 25450.');
      const date = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
      await opts.billing!.store.saveSetting(SETTINGS.exchangeRate, { vndPerUsd, date } satisfies ExchangeRateSetting, (req as AdminRequest).billingAdmin!);
      const issued = await opts.billing!.processPendingEinvoices();
      back(res, `Saved. ${issued} pending VAT invoice(s) issued.`);
    } catch (err) {
      fail(req, res, err);
    }
  });

  router.post('/providers/:id/mode', async (req, res) => {
    try {
      const id = String(req.params.id) as ProviderId;
      if (!(id in PROVIDERS)) throw new BillingError('unknown_provider', 'Unknown provider.', 404);
      const mode = req.body?.mode === 'live' ? 'live' : 'sandbox';
      const who = (req as AdminRequest).billingAdmin!;
      await setMode(opts.billing!.store, id, mode, {
        by: who,
        confirm: typeof req.body?.confirm === 'string' ? req.body.confirm : '',
        audit: (e) => opts.billing!.store.audit({ type: e.type, meta: e.meta }),
      });
      let check = '';
      if (id === 'sinvoice') {
        check = await sinvoiceCheck(mode);
        await opts.billing!.processPendingEinvoices();
      }
      back(res, `${PROVIDERS[id].label} is now in ${mode.toUpperCase()} mode.${check ? ` ${check}` : ''}`);
    } catch (err) {
      if (err instanceof ModeChangeError) return fail(req, res, new BillingError('mode_change_refused', err.message));
      fail(req, res, err);
    }
  });

  /** S-Invoice in a mode: are its template and series on the account? (A message for the admin.) */
  const sinvoiceCheck = async (mode: 'sandbox' | 'live'): Promise<string> => {
    const provider = opts.billing!.opts.einvoice?.(mode);
    if (!provider?.checkSettings) return `S-Invoice (${mode}) has no credentials yet.`;
    try {
      const r = await provider.checkSettings(true);
      return r.ok ? r.message : `Problem: ${r.message}`;
    } catch (err) {
      return `Problem: could not check S-Invoice (${err instanceof Error ? err.message : String(err)}).`;
    }
  };
  router.post('/providers/sinvoice/check', async (req, res) => {
    try {
      const mode = req.body?.mode === 'live' ? 'live' : 'sandbox';
      back(res, `S-Invoice (${mode}): ${await sinvoiceCheck(mode)}`);
    } catch (err) {
      fail(req, res, err);
    }
  });

  router.post('/sepay/poll', async (req, res) => {
    try {
      const { credited, seen } = await opts.billing!.pollSepay();
      back(res, `SePay: ${seen} recent transaction(s) read, ${credited} order(s) credited.`);
    } catch (err) {
      fail(req, res, err);
    }
  });

  router.post('/einvoices/process', async (req, res) => {
    try {
      const issued = await opts.billing!.processPendingEinvoices();
      back(res, `${issued} VAT invoice(s) issued.`);
    } catch (err) {
      fail(req, res, err);
    }
  });

  router.post('/einvoices/:id/retry', async (req, res) => {
    try {
      const id = String(req.params.id);
      await opts.billing!.store.einvoiceRetry(id);
      const e = await opts.billing!.processEinvoice(id);
      back(res, e?.status === 'issued' ? `Issued ${e.record?.invoiceNo}.` : `Still ${e?.status ?? 'missing'}: ${e?.lastError ?? ''}`);
    } catch (err) {
      fail(req, res, err);
    }
  });

  router.post('/einvoices/:id/cancel', async (req, res) => {
    try {
      const billing = opts.billing!;
      const e = await billing.store.einvoice(String(req.params.id));
      if (!e?.record || e.status !== 'issued') throw new BillingError('not_issued', 'Only an issued e-invoice can be cancelled.', 409);
      const provider = billing.opts.einvoice?.(e.mode);
      if (!provider) throw new BillingError('einvoice_unavailable', `Viettel S-Invoice (${e.mode}) is not configured.`, 409);
      const description = String(req.body?.description ?? '').trim();
      if (!description) throw new BillingError('reason_required', 'Describe the cancellation agreement with the buyer.');
      await provider.cancel(e.record, { description, at: Date.now() });
      await billing.store.einvoiceSetStatus(e.id, 'cancelled');
      await billing.store.audit({ type: 'billing.einvoice_cancelled', workspaceId: e.workspaceId, meta: { invoiceNo: e.record.invoiceNo, by: (req as AdminRequest).billingAdmin!, description } });
      back(res, `Cancelled ${e.record.invoiceNo} at Viettel.`);
    } catch (err) {
      fail(req, res, err);
    }
  });

  router.post('/einvoices/:id/replace', async (req, res) => {
    try {
      const billing = opts.billing!;
      const e = await billing.store.einvoice(String(req.params.id));
      if (!e?.record || e.status !== 'issued') throw new BillingError('not_issued', 'Only an issued e-invoice can be replaced.', 409);
      const provider = billing.opts.einvoice?.(e.mode);
      if (!provider) throw new BillingError('einvoice_unavailable', `Viettel S-Invoice (${e.mode}) is not configured.`, 409);
      const fx = (await billing.store.setting<ExchangeRateSetting>(SETTINGS.exchangeRate))?.value;
      if (!fx) throw new BillingError('fx_missing', 'Set the exchange rate first.', 409);
      const reason = String(req.body?.reason ?? '').trim();
      if (!reason) throw new BillingError('reason_required', 'Give the reason for the replacement.');
      const details = cleanVatInvoiceDetails(req.body);
      const updated: EInvoice = { ...e, details };
      const record = await provider.replace(e.record, updated, { seller: await billing.seller(), exchangeRate: fx.vndPerUsd, reason, transactionUuid: randomUUID() });
      await billing.store.replaceEinvoice(e.id, details, record);
      await billing.store.audit({ type: 'billing.einvoice_replaced', workspaceId: e.workspaceId, meta: { original: e.record, replacement: record.invoiceNo, by: (req as AdminRequest).billingAdmin!, reason } });
      await billing.processEinvoice(e.id);
      back(res, `Replaced ${e.record.invoiceNo} with ${record.invoiceNo}.`);
    } catch (err) {
      fail(req, res, err);
    }
  });

  router.get('/', async (req, res) => {
    const billing = opts.billing!;
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
    const [orders, account, seller, vat, methods, einvoices, fx] = await Promise.all([billing.store.allOrders(status), billing.account(), billing.seller(), billing.vat(), billing.methods(), billing.store.allEinvoices(), billing.store.setting<ExchangeRateSetting>(SETTINGS.exchangeRate)]);
    const receipts = await Promise.all(orders.filter((o) => o.status === 'paid').map(async (o) => [o.id, await billing.store.receiptForOrder(o.id)] as const));
    const receiptOf = new Map(receipts);
    const note = typeof req.query.note === 'string' ? req.query.note : '';
    res.setHeader('Cache-Control', 'no-store');
    const providers = await providerStatus(billing.store, opts.providerEnv ?? {});
    const sepay = billing.opts.sepay ? {
      ...billing.opts.sepay.status,
      account: await billing.opts.sepay.account().catch(() => null),
      method: methods.sepay,
      lastWebhookAt: await billing.store.lastSepayWebhookAt(),
    } : null;
    res.type('html').send(adminPage({ who: (req as AdminRequest).billingAdmin!, note, status, orders, receiptOf, account, seller, vat, einvoices, fx: fx?.value ?? null, providers, sepay }));
  });

  app.use('/billing', (req, res, next) => (isAdminHost(opts, req) ? router(req, res, next) : next()));
}

function sepaySection(s: Parameters<typeof adminPage>[0]['sepay']): string {
  const yes = (b: boolean) => (b ? '<strong style="color:#147a3d">yes</strong>' : '<strong style="color:#b42318">no</strong>');
  if (!s) return '<p>Not configured (set SEPAY_API_TOKEN and/or SEPAY_BANK_ACCOUNT + SEPAY_BANK_BIN, SEPAY_ACCOUNT_NAME, SEPAY_WEBHOOK_KEY). Live only: SePay has no sandbox for bank accounts.</p>';
  const a = s.account;
  return `<p>Offered to customers: ${yes(s.method.enabled)}. Account: <strong>${a ? `${esc(a.bankName)} ${esc(a.accountNumber)} (${esc(a.accountName || 'no name')}, bank id ${esc(a.bankId)})` : 'unknown'}</strong>${a ? (s.accountFromEnv ? ' from env' : ' from the SePay API') : ''}.
API token: ${yes(s.apiToken)} (polling, "check now") · webhook key: ${yes(s.webhookKey)} · last webhook seen: <strong>${s.lastWebhookAt ? esc(new Date(s.lastWebhookAt).toISOString().slice(0, 16).replace('T', ' ')) + ' UTC' : 'never'}</strong> · rate: <strong>${s.method.vndPerUsd ? `${esc(s.method.vndPerUsd)} VND/USD (${esc(s.method.rateDate)})` : 'none'}</strong>.<br>
<small>Point SePay's webhook (my.sepay.vn &gt; WebHooks) at https://llm.valefront.com/webhooks/sepay, authentication "API Key" with SEPAY_WEBHOOK_KEY, content type JSON. Underpaid, overpaid and late payments are noted on the order below.</small></p>
<form method="post" action="/billing/sepay/poll" style="margin:8px 0"><button>Check SePay transactions now</button></form>`;
}

function field(name: string, label: string, value: unknown, extra = ''): string {
  return `<label>${esc(label)}<input name="${name}" value="${esc(value)}" ${extra}></label>`;
}

function adminPage(p: {
  who: string; note: string; status?: string; orders: BillingOrder[]; receiptOf: Map<string, import('./billing').Receipt | null>;
  account: import('./billing').BillingAccount | null; seller: import('./billing').LegalSettings; vat: import('./billing').VatSettings;
  einvoices: EInvoice[]; fx: ExchangeRateSetting | null; providers: Awaited<ReturnType<typeof providerStatus>>;
  sepay: { apiToken: boolean; webhookKey: boolean; accountFromEnv: boolean; account: import('./billing').VndBankAccount | null; method: { enabled: boolean; vndPerUsd: number | null; rateDate: string | null }; lastWebhookAt: number | null } | null;
}): string {
  const yes = (b: boolean) => (b ? '<strong style="color:#147a3d">yes</strong>' : '<strong style="color:#b42318">no</strong>');
  const prows = p.providers.map((pr) => {
    const creds = (m: 'sandbox' | 'live') => `${yes(pr[m].ready)}<br><small>${pr[m].secrets.map((x) => `${esc(x.name)}${x.optional ? ' (optional)' : ''}: ${x.set ? 'set' : 'missing'}`).join('<br>')}</small>`;
    const to = pr.mode === 'live' ? 'sandbox' : 'live';
    const form = `<form method="post" action="/billing/providers/${esc(pr.id)}/mode"${to === 'live' ? ` onsubmit="return this.confirm.value==='LIVE' || (alert('Type LIVE to switch to live.'), false)"` : ''}><input type="hidden" name="mode" value="${to}">${to === 'live' ? '<input name="confirm" placeholder="Type LIVE" size="9" autocomplete="off">' : ''}<button>Switch to ${to}</button></form>`;
    const check = pr.id === 'sinvoice' ? (['sandbox', 'live'] as const).map((m) => `<form method="post" action="/billing/providers/sinvoice/check"><input type="hidden" name="mode" value="${m}"><button>Check ${m} template/series</button></form>`).join('') : '';
    return `<tr><td data-label="Provider"><strong>${esc(pr.label)}</strong></td><td data-label="Mode"><strong>${pr.mode === 'live' ? 'LIVE' : 'SANDBOX'}</strong></td><td data-label="Sandbox credentials">${creds('sandbox')}</td><td data-label="Live credentials">${creds('live')}</td><td data-label="Switch">${form}${check}</td></tr>`;
  }).join('');
  const erows = p.einvoices.map((e) => {
    const actions = e.status === 'failed' ? `<form method="post" action="/billing/einvoices/${esc(e.id)}/retry"><button>Retry</button></form>`
      : e.status === 'issued' ? `<details><summary>Cancel / replace</summary>
<form method="post" action="/billing/einvoices/${esc(e.id)}/cancel" onsubmit="return confirm('Cancel this e-invoice at Viettel?')"><input name="description" placeholder="Cancellation agreement" required><button>Cancel at Viettel</button></form>
<form method="post" action="/billing/einvoices/${esc(e.id)}/replace">${field('companyName', 'Company', e.details.companyName, 'required')}${field('taxCode', 'MST', e.details.taxCode, 'required')}${field('address', 'Address', e.details.address, 'required')}${field('email', 'Email', e.details.email, 'required')}${field('reason', 'Reason', '', 'required')}<button>Issue replacement</button></form></details>` : '';
    return `<tr><td>${esc(new Date(e.createdAt).toISOString().slice(0, 10))}</td><td>${esc(e.details.companyName)}<br><small>MST ${esc(e.details.taxCode)} · ${esc(e.details.email)}</small></td><td class="n">${esc(formatUsd(e.totalCents))}</td>
<td>${e.mode === 'sandbox' ? '<strong>SANDBOX</strong> ' : ''}${esc(e.status)}${e.record ? `<br><small>${esc(e.record.invoiceNo)}${e.record.codeOfTax ? ` · CQT ${esc(e.record.codeOfTax)}` : ''} · email ${esc(e.emailStatus ?? 'not sent')}</small>` : ''}${e.lastError ? `<br><small>${esc(e.lastError)} (${e.attempts} attempts)</small>` : ''}</td><td>${actions}</td></tr>`;
  }).join('');
  const rows = p.orders.map((o) => {
    const r = p.receiptOf.get(o.id);
    const action = o.status === 'pending' && (o.method === 'worldfirst' || o.method === 'sepay')
      ? `<form method="post" action="/billing/orders/${esc(o.id)}/mark-paid" onsubmit="return confirm('Mark ${esc(o.reference)} paid (${esc(formatUsd(o.totalCents))})?')">
<input name="receivedUsd" placeholder="Received USD" value="${esc((o.totalCents / 100).toFixed(2))}" size="8"><input name="bankReference" placeholder="Bank transaction ref" size="14"><button>Mark paid</button></form>`
      : r ? `${esc(r.number)} · email ${esc(r.emailStatus ?? 'not sent')} <form method="post" action="/billing/orders/${esc(o.id)}/resend-email" style="display:inline"><button>Resend email</button></form>` : '';
    return `<tr><td>${esc(new Date(o.createdAt).toISOString().slice(0, 16).replace('T', ' '))}</td><td><code>${esc(o.reference)}</code></td><td>${esc(o.buyer.company || o.buyer.name)}<br><small>${esc(o.buyer.email)} · ${esc(o.buyer.country)}</small></td>
<td>${esc(METHOD_LABELS[o.method])}${o.mode === 'sandbox' ? ' <strong>SANDBOX</strong>' : ''}${o.einvoiceRequest ? '<br><small>VAT invoice requested</small>' : ''}${o.quote ? `<br><small>${esc(o.quote.vndAmount.toLocaleString('en-US'))} VND at ${esc(o.quote.vndPerUsd)} (${esc(o.quote.rateDate)}), content ${esc(o.quote.transferContent)}</small>` : ''}${o.paymentNote ? `<br><small style="white-space:pre-wrap;color:#8a4b00">${esc(o.paymentNote)}</small>` : ''}</td><td class="n">${esc(formatUsd(o.amountCents))}<br><small>+VAT ${esc(vatLabel(o.vatRateBp))} = ${esc(formatUsd(o.totalCents))}</small></td><td>${esc(o.status)}${o.paidBy ? `<br><small>${esc(o.paidBy)}</small>` : ''}</td><td>${action}</td></tr>`;
  }).join('');
  const a = p.account;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Valefront billing admin</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:0;color:#14161b;background:#f7f8fa}main{max-width:1200px;margin:0 auto;padding:20px}h1{font-size:20px}h2{font-size:16px;margin-top:28px}
table{width:100%;border-collapse:collapse;background:#fff}td,th{padding:6px;border-bottom:1px solid #e3e5ea;text-align:left;vertical-align:top}.n{text-align:right}
form.settings{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px;background:#fff;padding:12px;border:1px solid #e3e5ea;border-radius:8px}
label{display:flex;flex-direction:column;font-size:12px;color:#555}input,textarea{font:inherit;padding:5px;border:1px solid #ccd;border-radius:6px}button{font:inherit;padding:5px 10px;border-radius:6px;border:1px solid #889;background:#eef;cursor:pointer}
.note{padding:8px 12px;background:#fff6d6;border:1px solid #e8d48a;border-radius:8px}.wrap{overflow-x:auto}.adminnav{margin-bottom:8px}@media (max-width:720px){main{padding:12px}table.stack,table.stack tbody,table.stack tr,table.stack td{display:block;width:auto}table.stack thead{display:none}table.stack tr{background:#fff;border:1px solid #e3e5ea;border-radius:8px;margin:0 0 10px;padding:6px 2px}table.stack td{border:0;padding:4px 10px;text-align:left}table.stack td[data-label]::before{content:attr(data-label);display:block;font-size:11px;font-weight:600;color:#667;text-transform:uppercase;letter-spacing:.02em}form.settings{grid-template-columns:1fr}input,button{font-size:16px}}small{overflow-wrap:anywhere}</style></head><body><main>
${adminNav('billing')}
<h1>Valefront billing admin</h1><p>Signed in through Cloudflare Access as <strong>${esc(p.who)}</strong>. WorldFirst bank transfer: <strong>${a ? 'configured' : 'not configured'}</strong> (no sandbox). Every payment gets a receipt; VAT e-invoices only for buyers in Vietnam who ask.</p>
${p.note ? `<p class="note">${esc(p.note)}</p>` : ''}
<h2>Providers: sandbox or live</h2><p><small>Secrets are Worker secrets (wrangler secret put); this page shows only whether they're set. In sandbox, PayPal is offered to admin workspaces only, and its receipts are marked SANDBOX and numbered apart. A VAT invoice is issued only through S-Invoice in its payment's mode. Every switch is audit-logged with who made it.</small></p>
<div class="wrap"><table class="stack"><thead><tr><th>Provider</th><th>Mode</th><th>Sandbox credentials</th><th>Live credentials</th><th></th></tr></thead><tbody>${prows}</tbody></table></div>
<h2>SePay (Vietnamese bank QR, VND)</h2>${sepaySection(p.sepay)}
<h2>Orders</h2><p><a href="/billing/">All</a> · <a href="/billing/?status=pending">Pending</a> · <a href="/billing/?status=paid">Paid</a> · <a href="/billing/?status=cancelled">Cancelled</a></p>
<div class="wrap"><table class="stack"><thead><tr><th>Created (UTC)</th><th>Reference</th><th>Buyer</th><th>Method</th><th class="n">Credit / total</th><th>Status</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7">No orders.</td></tr>'}</tbody></table></div>
<h2>Vietnamese VAT e-invoices (Viettel S-Invoice)</h2><p>Requested invoices wait as pending until S-Invoice is configured in their payment's mode. Exchange rate: <strong>${p.fx ? `${esc(p.fx.vndPerUsd)} VND/USD, set ${esc(p.fx.date)}` : 'not set'}</strong>.</p>
<form class="settings" method="post" action="/billing/settings/exchange-rate">${field('vndPerUsd', 'VND per 1 USD (for invoices issued from now)', p.fx?.vndPerUsd ?? '', 'required')}<div><button>Save rate and issue pending</button></div></form>
<form method="post" action="/billing/einvoices/process" style="margin:8px 0"><button>Run the retry job now</button></form>
<div class="wrap"><table class="stack"><thead><tr><th>Paid</th><th>Buyer</th><th class="n">Total</th><th>Status</th><th></th></tr></thead><tbody>${erows || '<tr><td colspan="5">No VAT invoices requested.</td></tr>'}</tbody></table></div>
<h2>WorldFirst receiving account (USD)</h2><form class="settings" method="post" action="/billing/settings/worldfirst">
${field('accountName', 'Account name', a?.accountName, 'required')}${field('accountNumber', 'Account number', a?.accountNumber, 'required')}${field('bankName', 'Bank name', a?.bankName, 'required')}
${field('swiftCode', 'SWIFT/BIC', a?.swiftCode, 'required')}${field('routingNumber', 'Routing number (ACH/ABA)', a?.routingNumber)}${field('bankAddress', 'Bank address', a?.bankAddress)}
<label>Instructions<textarea name="instructions">${esc(a?.instructions)}</textarea></label><div><button>Save account</button></div></form>
<h2>Seller (legal) details on invoices and receipts</h2><form class="settings" method="post" action="/billing/settings/legal">
${field('companyName', 'Company name', p.seller.companyName, 'required')}${field('localName', 'Registered Vietnamese name', p.seller.localName)}${field('taxCode', 'Enterprise / tax code (MST)', p.seller.taxCode, 'required')}
${field('address', 'Address', p.seller.address, 'required')}${field('email', 'Email', p.seller.email, 'required')}<div><button>Save legal details</button></div></form>
<h2>VAT by buyer country</h2><form class="settings" method="post" action="/billing/settings/vat">
${field('defaultBp', 'Default rate, basis points (0 = export of services)', p.vat.defaultBp, 'required')}
<label>Per country (CC=basis points, one per line; 1000 = 10%)<textarea name="byCountry">${esc(Object.entries(p.vat.byCountry).map(([c, r]) => `${c}=${r}`).join('\n'))}</textarea></label><div><button>Save VAT rates</button></div></form>
</main></body></html>`;
}
