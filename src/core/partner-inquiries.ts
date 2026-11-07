import { adminDocument, filterTabs } from './admin-page-style';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { accessAdminOf, adminNav, isAdminHost } from './admin-billing';
import { clientIp } from './customer-routes';
import { hashIdentity } from './self-serve-workspaces';
import type { D1Database } from './d1-stores';
import type { HostedOptions } from './hosted';

/**
 * "Partner with Valefront": model/AI providers fill in a form on valefront.com (a static site), which posts here.
 *
 *   POST /v1/partners/inquiry (also /partners/inquiry), on the API host: CORS for https://valefront.com only (and
 *        http://localhost / 127.0.0.1 for testing); Turnstile; at most 5 an hour per IP. Stored in D1
 *        (partner_inquiries, migration 0004), then the team is emailed (PARTNER_INQUIRY_TO, reply-to the submitter)
 *        and the submitter gets a short confirmation in their language. An email that fails is logged; the inquiry
 *        is already stored.
 *   GET  /partners/                  on the admin host (adm.valefront.com, adminHostGate): the inquiries, newest first
 *   POST /partners/:id/status        status (new | contacted | closed) and a note
 */

export const PARTNERSHIP_TYPES = ['list-models', 'reseller', 'marketing', 'other'] as const;
export type PartnershipType = (typeof PARTNERSHIP_TYPES)[number];
export const MODALITIES = ['text', 'image', 'video', 'audio', 'embeddings'] as const;
export type Modality = (typeof MODALITIES)[number];
export const INQUIRY_STATUSES = ['new', 'contacted', 'closed'] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];
export type Lang = 'en' | 'vi';

/** Per IP (hashed), submissions an hour. */
export const INQUIRIES_PER_IP_PER_HOUR = 5;
export const DEFAULT_PARTNER_INQUIRY_TO = 'info@valefront.com';
export const PARTNER_INQUIRY_FROM = { email: 'billing@valefront.com', name: 'Valefront' };

const TYPE_LABELS: Record<PartnershipType, string> = {
  'list-models': 'List models on Valefront',
  reseller: 'Reseller',
  marketing: 'Marketing',
  other: 'Other',
};

export type PartnerInquiryInput = {
  company: string;
  contactName: string;
  email: string;
  website: string | null;
  role: string | null;
  modelsOffered: string;
  modalities: Modality[];
  regions: string | null;
  partnershipType: PartnershipType;
  message: string | null;
  lang: Lang;
};

export type PartnerInquiry = PartnerInquiryInput & {
  id: string;
  createdAt: number;
  status: InquiryStatus;
  note: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
  notifyEmailStatus: string | null;
  confirmEmailStatus: string | null;
};

/** One email, as the Worker's Email Sending binding takes it. */
export type PartnerEmail = { from: { email: string; name?: string }; to: string; replyTo?: string; subject: string; text: string; html: string };

// ── validation ────────────────────────────────────────────────────────────────────────────────────────────

type Field = 'company' | 'contactName' | 'email' | 'website' | 'role' | 'modelsOffered' | 'modalities' | 'regions' | 'partnershipType' | 'message';

const LABELS: Record<Lang, Record<Field, string>> = {
  en: { company: 'Company', contactName: 'Contact name', email: 'Email', website: 'Website', role: 'Role', modelsOffered: 'Models offered', modalities: 'Modalities', regions: 'Regions', partnershipType: 'Partnership type', message: 'Message' },
  vi: { company: 'Công ty', contactName: 'Tên người liên hệ', email: 'Email', website: 'Website', role: 'Chức vụ', modelsOffered: 'Các mô hình cung cấp', modalities: 'Loại dữ liệu', regions: 'Khu vực', partnershipType: 'Hình thức hợp tác', message: 'Lời nhắn' },
};

const MESSAGES = {
  en: {
    required: (l: string) => `${l} is required.`,
    tooLong: (l: string, max: number) => `${l} is too long (at most ${max} characters).`,
    html: (l: string) => `${l} can't contain HTML.`,
    text: (l: string) => `${l} must be text.`,
    email: 'Enter a valid email address.',
    website: 'Enter a valid website address (https://…).',
    modalities: `Modalities must be any of: ${MODALITIES.join(', ')}.`,
    partnershipType: 'Choose a partnership type.',
    json: 'Send the form as JSON.',
    turnstile: 'The security check failed; please try again.',
    rateLimited: 'Too many inquiries from your network; please try again in an hour or email info@valefront.com.',
    unavailable: 'Partner inquiries are not available just now; please email info@valefront.com.',
    origin: 'This form can only be sent from valefront.com.',
  },
  vi: {
    required: (l: string) => `Vui lòng nhập ${l}.`,
    tooLong: (l: string, max: number) => `${l} quá dài (tối đa ${max} ký tự).`,
    html: (l: string) => `${l} không được chứa HTML.`,
    text: (l: string) => `${l} phải là văn bản.`,
    email: 'Vui lòng nhập địa chỉ email hợp lệ.',
    website: 'Vui lòng nhập địa chỉ website hợp lệ (https://…).',
    modalities: `Loại dữ liệu chỉ gồm: ${MODALITIES.join(', ')}.`,
    partnershipType: 'Vui lòng chọn hình thức hợp tác.',
    json: 'Vui lòng gửi biểu mẫu dưới dạng JSON.',
    turnstile: 'Kiểm tra bảo mật không thành công; vui lòng thử lại.',
    rateLimited: 'Có quá nhiều yêu cầu từ mạng của bạn; vui lòng thử lại sau một giờ hoặc gửi email tới info@valefront.com.',
    unavailable: 'Hiện chưa thể gửi yêu cầu hợp tác; vui lòng gửi email tới info@valefront.com.',
    origin: 'Biểu mẫu này chỉ được gửi từ valefront.com.',
  },
};

export class InquiryFieldError extends Error {
  constructor(readonly field: Field | 'body', message: string) {
    super(message);
  }
}

// A tag, comment or processing instruction ("<b", "</", "<!--", "<?"); "<5 ms" is fine.
const HTML = /<\s*[a-zA-Z!/?]/;
// eslint-disable-next-line no-control-regex
const CONTROL_SINGLE = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_MULTI = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-zA-Z]{2,}$/;

export function langOf(value: unknown): Lang {
  return value === 'vi' ? 'vi' : 'en';
}

/** The form's JSON -> a clean inquiry, or InquiryFieldError with a message in the form's language. */
export function validateInquiry(body: unknown): PartnerInquiryInput {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const lang = langOf(b.lang);
  const m = MESSAGES[lang];
  const label = (f: Field) => LABELS[lang][f];
  const text = (f: Field, max: number, opts: { required?: boolean; multiline?: boolean } = {}): string | null => {
    const raw = b[f];
    if (raw !== undefined && raw !== null && typeof raw !== 'string') throw new InquiryFieldError(f, m.text(label(f)));
    const v = (raw ?? '').replace(/\r\n?/g, '\n').trim();
    if (!v) {
      if (opts.required) throw new InquiryFieldError(f, m.required(label(f)));
      return null;
    }
    if (v.length > max) throw new InquiryFieldError(f, m.tooLong(label(f), max));
    if ((opts.multiline ? CONTROL_MULTI : CONTROL_SINGLE).test(v)) throw new InquiryFieldError(f, m.text(label(f)));
    if (HTML.test(v)) throw new InquiryFieldError(f, m.html(label(f)));
    return v;
  };

  const company = text('company', 200, { required: true })!;
  const contactName = text('contactName', 120, { required: true })!;
  const email = text('email', 254, { required: true })!;
  if (!EMAIL.test(email)) throw new InquiryFieldError('email', m.email);
  let website = text('website', 300);
  if (website) {
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(website) ? website : `https://${website}`;
    let url: URL | null = null;
    try { url = new URL(withScheme); } catch { url = null; }
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname.includes('.') || url.username || url.password) throw new InquiryFieldError('website', m.website);
    website = withScheme;
  }
  const role = text('role', 120);
  const modelsOffered = text('modelsOffered', 4000, { required: true, multiline: true })!;

  let modalities: Modality[] = [];
  if (b.modalities !== undefined && b.modalities !== null) {
    const list = Array.isArray(b.modalities) ? b.modalities : null;
    if (!list || list.length > MODALITIES.length * 2 || !list.every((x) => typeof x === 'string' && (MODALITIES as readonly string[]).includes(x.trim().toLowerCase()))) {
      throw new InquiryFieldError('modalities', m.modalities);
    }
    const chosen = new Set(list.map((x) => String(x).trim().toLowerCase()));
    modalities = MODALITIES.filter((x) => chosen.has(x));
  }

  // Regions: free text, or a list of names.
  if (Array.isArray(b.regions)) {
    if (!b.regions.every((x) => typeof x === 'string')) throw new InquiryFieldError('regions', m.text(label('regions')));
    b.regions = (b.regions as string[]).map((x) => x.trim()).filter(Boolean).join(', ');
  }
  const regions = text('regions', 500);

  const type = typeof b.partnershipType === 'string' ? b.partnershipType.trim() : '';
  if (!(PARTNERSHIP_TYPES as readonly string[]).includes(type)) throw new InquiryFieldError('partnershipType', m.partnershipType);
  const message = text('message', 5000, { multiline: true });

  return { company, contactName, email, website, role, modelsOffered, modalities, regions, partnershipType: type as PartnershipType, message, lang };
}

// ── storage ───────────────────────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function fromRow(r: Row): PartnerInquiry {
  const str = (k: string) => (r[k] === null || r[k] === undefined ? null : String(r[k]));
  let modalities: Modality[] = [];
  try { modalities = JSON.parse(String(r.modalities ?? '[]')) as Modality[]; } catch { modalities = []; }
  return {
    id: String(r.id),
    createdAt: Number(r.created_at),
    company: String(r.company),
    contactName: String(r.contact_name),
    email: String(r.email),
    website: str('website'),
    role: str('role'),
    modelsOffered: String(r.models_offered),
    modalities,
    regions: str('regions'),
    partnershipType: String(r.partnership_type) as PartnershipType,
    message: str('message'),
    lang: langOf(r.lang),
    status: String(r.status) as InquiryStatus,
    note: str('note'),
    updatedAt: r.updated_at === null || r.updated_at === undefined ? null : Number(r.updated_at),
    updatedBy: str('updated_by'),
    notifyEmailStatus: str('notify_email_status'),
    confirmEmailStatus: str('confirm_email_status'),
  };
}

export class D1PartnerInquiryStore {
  constructor(private readonly db: D1Database, private readonly now: () => number = Date.now) {}

  async add(input: PartnerInquiryInput, ipHash: string): Promise<PartnerInquiry> {
    const id = randomUUID();
    const at = this.now();
    await this.db.prepare(`INSERT INTO partner_inquiries (id, created_at, company, contact_name, email, website, role, models_offered, modalities, regions, partnership_type, message, lang, ip_hash, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`)
      .bind(id, at, input.company, input.contactName, input.email, input.website, input.role, input.modelsOffered, JSON.stringify(input.modalities), input.regions, input.partnershipType, input.message, input.lang, ipHash)
      .run();
    return { ...input, id, createdAt: at, status: 'new', note: null, updatedAt: null, updatedBy: null, notifyEmailStatus: null, confirmEmailStatus: null };
  }

  async get(id: string): Promise<PartnerInquiry | null> {
    const r = await this.db.prepare('SELECT * FROM partner_inquiries WHERE id = ?').bind(id).first<Row>();
    return r ? fromRow(r) : null;
  }

  /** Newest first; with a status, only those. */
  async list(status?: InquiryStatus, limit = 500): Promise<PartnerInquiry[]> {
    const q = status
      ? this.db.prepare('SELECT * FROM partner_inquiries WHERE status = ? ORDER BY created_at DESC, id LIMIT ?').bind(status, limit)
      : this.db.prepare('SELECT * FROM partner_inquiries ORDER BY created_at DESC, id LIMIT ?').bind(limit);
    return ((await q.all<Row>()).results ?? []).map(fromRow);
  }

  async counts(): Promise<Record<InquiryStatus, number>> {
    const rows = (await this.db.prepare('SELECT status, count(*) AS n FROM partner_inquiries GROUP BY status').all<{ status: string; n: number }>()).results ?? [];
    const out: Record<InquiryStatus, number> = { new: 0, contacted: 0, closed: 0 };
    for (const r of rows) if (r.status in out) out[r.status as InquiryStatus] = Number(r.n);
    return out;
  }

  async countSince(ipHash: string, since: number): Promise<number> {
    const r = await this.db.prepare('SELECT count(*) AS n FROM partner_inquiries WHERE ip_hash = ? AND created_at >= ?').bind(ipHash, since).first<{ n: number }>();
    return Number(r?.n ?? 0);
  }

  async setStatus(id: string, status: InquiryStatus, note: string | null, by: string): Promise<boolean> {
    const r = await this.db.prepare('UPDATE partner_inquiries SET status = ?, note = ?, updated_at = ?, updated_by = ? WHERE id = ?').bind(status, note, this.now(), by, id).run();
    return Number(r.meta?.changes ?? 0) > 0;
  }

  async setEmailStatus(id: string, which: 'notify' | 'confirm', status: 'sent' | 'failed'): Promise<void> {
    await this.db.prepare(`UPDATE partner_inquiries SET ${which === 'notify' ? 'notify_email_status' : 'confirm_email_status'} = ? WHERE id = ?`).bind(status, id).run();
  }
}

// ── the service ───────────────────────────────────────────────────────────────────────────────────────────

export type PartnerInquiriesOptions = {
  store: D1PartnerInquiryStore;
  /** The Worker's Email Sending binding; unset: inquiries are stored but nobody is emailed. */
  sendEmail?: (message: PartnerEmail) => Promise<void>;
  /** PARTNER_INQUIRY_TO (default info@valefront.com). */
  to?: string;
  /** https://adm.valefront.com: the link in the team's email. */
  adminUrl?: string;
  now?: () => number;
};

const escHtml = (t: unknown) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class PartnerInquiries {
  readonly store: D1PartnerInquiryStore;
  private readonly now: () => number;

  constructor(readonly opts: PartnerInquiriesOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
  }

  get to(): string {
    return this.opts.to?.trim() || DEFAULT_PARTNER_INQUIRY_TO;
  }

  async rateLimited(ipHash: string): Promise<boolean> {
    return (await this.store.countSince(ipHash, this.now() - 3_600_000)) >= INQUIRIES_PER_IP_PER_HOUR;
  }

  /** Stores the inquiry, then emails the team and the submitter (failures are logged; the inquiry stays). */
  async submit(input: PartnerInquiryInput, ipHash: string): Promise<PartnerInquiry> {
    const inquiry = await this.store.add(input, ipHash);
    console.log(JSON.stringify({ event: 'partner_inquiry', id: inquiry.id, type: inquiry.partnershipType }));
    await Promise.all([this.email(inquiry, 'notify', this.notification(inquiry)), this.email(inquiry, 'confirm', this.confirmation(inquiry))]);
    return inquiry;
  }

  private async email(inquiry: PartnerInquiry, which: 'notify' | 'confirm', message: PartnerEmail): Promise<void> {
    if (!this.opts.sendEmail) return;
    try {
      await this.opts.sendEmail(message);
      await this.store.setEmailStatus(inquiry.id, which, 'sent').catch(() => undefined);
    } catch (err) {
      console.error(`[partners] ${which} email failed`, inquiry.id, err instanceof Error ? err.message : err);
      await this.store.setEmailStatus(inquiry.id, which, 'failed').catch(() => undefined);
    }
  }

  notification(i: PartnerInquiry): PartnerEmail {
    const rows: Array<[string, string]> = [
      ['Company', i.company],
      ['Contact', i.contactName],
      ['Email', i.email],
      ['Website', i.website ?? '-'],
      ['Role', i.role ?? '-'],
      ['Partnership type', TYPE_LABELS[i.partnershipType]],
      ['Modalities', i.modalities.join(', ') || '-'],
      ['Regions', i.regions ?? '-'],
      ['Models offered', i.modelsOffered],
      ['Message', i.message ?? '-'],
      ['Language', i.lang],
      ['Received', new Date(i.createdAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'],
    ];
    const admin = `${(this.opts.adminUrl ?? 'https://adm.valefront.com').replace(/\/+$/, '')}/partners/`;
    return {
      from: PARTNER_INQUIRY_FROM,
      to: this.to,
      replyTo: i.email,
      subject: `Partner inquiry: ${i.company} (${TYPE_LABELS[i.partnershipType]})`,
      text: ['A new partner inquiry from valefront.com. Reply to this email to answer the submitter.', '', ...rows.map(([k, v]) => `${k}: ${v}`), '', `All inquiries: ${admin}`].join('\n'),
      html: `<p>A new partner inquiry from valefront.com. Reply to this email to answer the submitter.</p>
<table cellpadding="6" style="border-collapse:collapse;font:14px/1.45 system-ui,sans-serif">${rows.map(([k, v]) => `<tr><th align="left" valign="top" style="border-bottom:1px solid #e3e5ea">${escHtml(k)}</th><td style="border-bottom:1px solid #e3e5ea;white-space:pre-wrap">${escHtml(v)}</td></tr>`).join('')}</table>
<p><a href="${escHtml(admin)}">All inquiries</a></p>`,
    };
  }

  confirmation(i: PartnerInquiry): PartnerEmail {
    const vi = i.lang === 'vi';
    const paragraphs = vi
      ? [`Xin chào ${i.contactName},`, `Cảm ơn bạn đã quan tâm đến việc hợp tác với Valefront. Chúng tôi đã nhận được yêu cầu của ${i.company} và đội ngũ của chúng tôi sẽ phản hồi trong vòng 2 ngày làm việc.`, `Nếu cần bổ sung thông tin, bạn chỉ cần trả lời email này.`, `Đội ngũ Valefront\nhttps://valefront.com`]
      : [`Hi ${i.contactName},`, `Thank you for your interest in partnering with Valefront. We've received your inquiry for ${i.company}, and our team will reply within 2 business days.`, `If you'd like to add anything, just reply to this email.`, `The Valefront team\nhttps://valefront.com`];
    return {
      from: PARTNER_INQUIRY_FROM,
      to: i.email,
      replyTo: this.to,
      subject: vi ? 'Valefront đã nhận được yêu cầu hợp tác của bạn' : 'We received your partnership inquiry',
      text: paragraphs.join('\n\n'),
      html: `<div style="font:14px/1.5 system-ui,sans-serif">${paragraphs.map((p) => `<p>${escHtml(p).replace(/\n/g, '<br>')}</p>`).join('')}</div>`,
    };
  }
}

// ── the public endpoint ───────────────────────────────────────────────────────────────────────────────────

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

export function partnerOriginAllowed(origin: string): boolean {
  return origin === 'https://valefront.com' || LOCAL_ORIGIN.test(origin);
}

/**
 * POST /v1/partners/inquiry and /partners/inquiry, on every host but the admin host. Mounted before the app's
 * open CORS (server.ts) so only valefront.com's origin is allowed here.
 */
export function mountPartnerInquiryApi(app: Express, opts: HostedOptions): void {
  const json = express.json({ limit: '32kb' });
  app.all(['/v1/partners/inquiry', '/partners/inquiry'], (req: Request, res: Response, next: NextFunction) => {
    if (isAdminHost(opts, req)) return next();
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const allowed = Boolean(origin) && partnerOriginAllowed(origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');
    if (allowed) res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      if (!allowed) return res.status(403).end();
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
      return res.status(204).end();
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      return res.status(405).json({ ok: false, error: 'method_not_allowed', message: 'Use POST.' });
    }
    if (origin && !allowed) return res.status(403).json({ ok: false, error: 'origin_not_allowed', message: MESSAGES.en.origin });
    json(req, res, (err?: unknown) => {
      void handle(req, res, err).catch((e) => {
        console.error('[partners] inquiry failed', e);
        if (!res.headersSent) res.status(500).json({ ok: false, error: 'server_error', message: MESSAGES.en.unavailable });
      });
    });
  });

  const handle = async (req: Request, res: Response, parseError: unknown): Promise<void> => {
    const body = req.body as Record<string, unknown> | undefined;
    const lang = langOf(body?.lang);
    const m = MESSAGES[lang];
    if (parseError || !req.is('application/json') || !body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ ok: false, error: 'invalid_json', message: m.json });
      return;
    }
    let input: PartnerInquiryInput;
    try {
      input = validateInquiry(body);
    } catch (err) {
      if (err instanceof InquiryFieldError) {
        res.status(400).json({ ok: false, error: 'invalid_field', field: err.field, message: err.message });
        return;
      }
      throw err;
    }
    const partners = opts.partners;
    if (!partners || !opts.turnstile) {
      res.status(503).json({ ok: false, error: 'unavailable', message: m.unavailable });
      return;
    }
    const ip = clientIp(req);
    const ipHash = hashIdentity(`partner-ip:${ip}`);
    if (await partners.rateLimited(ipHash)) {
      res.setHeader('Retry-After', '3600');
      res.status(429).json({ ok: false, error: 'rate_limited', message: m.rateLimited });
      return;
    }
    const token = typeof body.turnstileToken === 'string' ? body.turnstileToken.trim() : '';
    if (!token || token.length > 4096 || !(await opts.turnstile.verify(token, ip))) {
      res.status(403).json({ ok: false, error: 'turnstile_failed', message: m.turnstile });
      return;
    }
    await partners.submit(input, ipHash);
    res.status(200).json({ ok: true });
  };
}

// ── admin (adm.valefront.com) ─────────────────────────────────────────────────────────────────────────────

const isStatus = (v: unknown): v is InquiryStatus => typeof v === 'string' && (INQUIRY_STATUSES as readonly string[]).includes(v);

export function mountAdminPartners(app: Express, opts: HostedOptions): void {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '32kb' }));
  router.use((req: Request, res: Response, next: NextFunction) => {
    // adminHostGate already checked Cloudflare Access and the request's origin.
    if (!accessAdminOf(req)) return res.status(403).type('text').send('Not allowed.');
    if (!opts.partners) return res.status(503).type('text').send('Partner inquiries are not configured on this server.');
    next();
  });

  const back = (res: Response, note: string, filter?: string) =>
    res.redirect(303, `/partners/?${isStatus(filter) ? `status=${filter}&` : ''}note=${encodeURIComponent(note)}`);

  router.post('/:id/status', async (req, res) => {
    const filter = typeof req.body?.filter === 'string' ? req.body.filter : undefined;
    try {
      const status = req.body?.status;
      if (!isStatus(status)) return back(res, 'Error: choose new, contacted or closed.', filter);
      const note = String(req.body?.note ?? '').replace(/\r\n?/g, '\n').trim().slice(0, 2000) || null;
      const changed = await opts.partners!.store.setStatus(String(req.params.id), status, note, accessAdminOf(req)!);
      if (!changed) return back(res, 'Error: inquiry not found.', filter);
      back(res, `Saved: ${status}.`, filter);
    } catch (err) {
      console.error('[admin-partners]', err);
      back(res, 'Error: failed; see the Worker logs.', filter);
    }
  });

  router.get('/', async (req, res) => {
    const status = isStatus(req.query.status) ? req.query.status : undefined;
    const [inquiries, counts] = await Promise.all([opts.partners!.store.list(status), opts.partners!.store.counts()]);
    const note = typeof req.query.note === 'string' ? req.query.note : '';
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(partnersPage({ who: accessAdminOf(req)!, note, status, inquiries, counts }));
  });

  app.use('/partners', (req, res, next) => (isAdminHost(opts, req) ? router(req, res, next) : next()));
}

function partnersPage(p: { who: string; note: string; status?: InquiryStatus; inquiries: PartnerInquiry[]; counts: Record<InquiryStatus, number> }): string {
  const e = escHtml;
  const total = p.counts.new + p.counts.contacted + p.counts.closed;
  const filter = (s: InquiryStatus | undefined, label: string, n: number) => ({ href: `/partners/${s ? `?status=${s}` : ''}`, label: `${label} (${n})`, current: s === p.status });
  const multi = (t: string | null) => (t ? `<div class="pre">${e(t)}</div>` : '');
  const rows = p.inquiries.map((i) => {
    const site = i.website && /^https?:\/\//i.test(i.website) ? `<br><small><a href="${e(i.website)}" rel="noopener noreferrer nofollow" target="_blank">${e(i.website)}</a></small>` : '';
    const emails = `<small>email: team ${e(i.notifyEmailStatus ?? 'not sent')}, confirmation ${e(i.confirmEmailStatus ?? 'not sent')}</small>`;
    const options = INQUIRY_STATUSES.map((s) => `<option value="${s}"${s === i.status ? ' selected' : ''}>${s}</option>`).join('');
    return `<tr class="s-${e(i.status)}"><td>${e(new Date(i.createdAt).toISOString().slice(0, 16).replace('T', ' '))}<br><small>${e(i.lang)}</small></td>
<td><strong>${e(i.company)}</strong>${site}</td>
<td>${e(i.contactName)}${i.role ? `<br><small>${e(i.role)}</small>` : ''}<br><small><a href="mailto:${e(i.email)}">${e(i.email)}</a></small></td>
<td>${e(TYPE_LABELS[i.partnershipType] ?? i.partnershipType)}${i.modalities.length ? `<br><small>${e(i.modalities.join(', '))}</small>` : ''}${i.regions ? `<br><small>Regions: ${e(i.regions)}</small>` : ''}</td>
<td>${multi(i.modelsOffered)}${i.message ? `<hr>${multi(i.message)}` : ''}</td>
<td><form class="status" method="post" action="/partners/${e(i.id)}/status"><input type="hidden" name="filter" value="${e(p.status ?? '')}"><select name="status">${options}</select>
<textarea name="note" rows="2" placeholder="Note">${e(i.note)}</textarea><button>Save</button></form>${i.updatedBy ? `<small>${e(i.updatedBy)}, ${e(new Date(i.updatedAt!).toISOString().slice(0, 16).replace('T', ' '))}</small><br>` : ''}${emails}</td></tr>`;
  }).join('');
  const css = '.pre{white-space:pre-wrap;overflow-wrap:break-word;max-height:12em;overflow:auto;min-width:16rem;max-width:26rem}tr.s-new td:first-child{box-shadow:inset 3px 0 0 var(--ring)}tr.s-closed{opacity:.7}td form.status{flex-direction:column;align-items:stretch;flex-wrap:nowrap;min-width:12rem}td form.status button{align-self:flex-start}';
  return adminDocument({ current: 'partner-inquiries', title: 'Partner inquiries', who: p.who, css, body: `<h1>Partner inquiries</h1><p>From the "Partner with Valefront" form on valefront.com. Signed in through Cloudflare Access as <strong>${e(p.who)}</strong>.</p>
${p.note ? `<p class="note">${e(p.note)}</p>` : ''}
${filterTabs([filter(undefined, 'All', total), filter('new', 'New', p.counts.new), filter('contacted', 'Contacted', p.counts.contacted), filter('closed', 'Closed', p.counts.closed)])}
<div class="wrap"><table><thead><tr><th>Received (UTC)</th><th>Company</th><th>Contact</th><th>Partnership</th><th>Models offered / message</th><th>Status</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">No inquiries.</td></tr>'}</tbody></table></div>` });
}
