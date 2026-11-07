import request from 'supertest';
import { D1PartnerInquiryStore, PartnerInquiries, validateInquiry, InquiryFieldError } from '../src/core/partner-inquiries';
import { hostedBilling } from './helpers/hosted-billing';

const API = 'llm.valefront.com';
const ADM = 'adm.valefront.com';
const SITE = 'https://valefront.com';

const FORM = {
  company: 'Acme AI',
  contactName: 'Linh Tran',
  email: 'linh@acme.ai',
  website: 'acme.ai',
  role: 'Head of Partnerships',
  modelsOffered: 'Acme-1 (70B chat)\nAcme-Embed',
  modalities: ['text', 'embeddings'],
  regions: 'APAC, EU',
  partnershipType: 'list-models',
  message: 'We would like to list our models.',
  turnstileToken: 'ok-token',
  lang: 'en',
};

function post(h: ReturnType<typeof hostedBilling>, body: unknown, opts: { origin?: string | null; ip?: string; path?: string; host?: string } = {}) {
  const r = request(h.app).post(opts.path ?? '/v1/partners/inquiry').set('Host', opts.host ?? API).set('Cf-Connecting-Ip', opts.ip ?? '203.0.113.7');
  if (opts.origin !== null) r.set('Origin', opts.origin ?? SITE);
  return r.send(body as object);
}

describe('partner inquiries: the public endpoint', () => {
  it('stores a valid inquiry and emails the team (reply-to the submitter) and the submitter', async () => {
    const h = hostedBilling();
    const res = await post(h, FORM);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['access-control-allow-origin']).toBe(SITE);

    const [stored] = await h.partners.store.list();
    expect(stored).toMatchObject({ company: 'Acme AI', contactName: 'Linh Tran', email: 'linh@acme.ai', website: 'https://acme.ai', modalities: ['text', 'embeddings'], partnershipType: 'list-models', status: 'new', lang: 'en', notifyEmailStatus: 'sent', confirmEmailStatus: 'sent' });
    // Only a hash of the IP is kept.
    const row = h.db.sqlite.prepare('SELECT * FROM partner_inquiries').get() as Record<string, unknown>;
    expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain('203.0.113.7');

    expect(h.partnerEmails).toHaveLength(2);
    const team = h.partnerEmails.find((m) => m.to === 'info@valefront.com')!;
    expect(team.from).toEqual({ email: 'billing@valefront.com', name: 'Valefront' });
    expect(team.replyTo).toBe('linh@acme.ai');
    expect(team.subject).toContain('Acme AI');
    for (const v of ['Linh Tran', 'linh@acme.ai', 'https://acme.ai', 'Head of Partnerships', 'Acme-Embed', 'text, embeddings', 'APAC, EU', 'We would like to list our models.']) expect(team.text).toContain(v);
    const mine = h.partnerEmails.find((m) => m.to === 'linh@acme.ai')!;
    expect(mine.from.email).toBe('billing@valefront.com');
    expect(mine.text).toContain('2 business days');
    expect(mine.replyTo).toBe('info@valefront.com');
  });

  it('confirms in Vietnamese, sends to PARTNER_INQUIRY_TO, and is also at /partners/inquiry', async () => {
    const h = hostedBilling();
    h.hosted.partners = new PartnerInquiries({ store: h.partners.store, sendEmail: async (m) => { h.partnerEmails.push(m); }, to: 'partners@valefront.com' });
    const res = await post(h, { ...FORM, lang: 'vi' }, { path: '/partners/inquiry' });
    expect(res.status).toBe(200);
    expect(h.partnerEmails.map((m) => m.to).sort()).toEqual(['linh@acme.ai', 'partners@valefront.com']);
    expect(h.partnerEmails.find((m) => m.to === 'linh@acme.ai')!.text).toContain('2 ngày làm việc');
  });

  it('a failed email is logged, and the inquiry is kept', async () => {
    const h = hostedBilling();
    h.hosted.partners = new PartnerInquiries({ store: h.partners.store, sendEmail: async () => { throw new Error('smtp down'); } });
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await post(h, FORM);
    err.mockRestore();
    expect(res.status).toBe(200);
    const [stored] = await h.partners.store.list();
    expect(stored).toMatchObject({ company: 'Acme AI', notifyEmailStatus: 'failed', confirmEmailStatus: 'failed' });
  });

  it('refuses invalid fields with the field and a clear message (in the form\'s language)', async () => {
    const h = hostedBilling();
    const cases: Array<[Record<string, unknown>, string, RegExp]> = [
      [{ company: '' }, 'company', /Company is required/],
      [{ contactName: '   ' }, 'contactName', /Contact name is required/],
      [{ email: 'not-an-email' }, 'email', /valid email/],
      [{ modelsOffered: undefined }, 'modelsOffered', /Models offered is required/],
      [{ partnershipType: 'spam' }, 'partnershipType', /partnership type/],
      [{ modalities: ['text', 'smell'] }, 'modalities', /Modalities must be/],
      [{ website: 'javascript:alert(1)' }, 'website', /valid website/],
      [{ company: 'x'.repeat(201) }, 'company', /too long/],
      [{ message: 'Hi <script>alert(1)</script>' }, 'message', /HTML/],
      [{ contactName: 'Linh\nTran' }, 'contactName', /must be text/],
      [{ company: 42 }, 'company', /must be text/],
    ];
    for (const [over, field, message] of cases) {
      const res = await post(h, { ...FORM, ...over });
      expect({ status: res.status, field: res.body.field }).toEqual({ status: 400, field });
      expect(res.body.error).toBe('invalid_field');
      expect(res.body.message).toMatch(message);
    }
    const vi = await post(h, { ...FORM, company: '', lang: 'vi' });
    expect(vi.body.message).toBe('Vui lòng nhập Công ty.');
    expect((await post(h, '[1]')).status).toBe(400);
    expect(await h.partners.store.list()).toHaveLength(0);
    expect(h.turnstile.calls).toBe(0);
  });

  it('allows "<5 ms" and similar text that is not HTML', () => {
    expect(validateInquiry({ ...FORM, message: 'Latency <5 ms, price 3 > 2' }).message).toBe('Latency <5 ms, price 3 > 2');
    expect(() => validateInquiry({ ...FORM, message: '<!-- x -->' })).toThrow(InquiryFieldError);
  });

  it('a failed or missing Turnstile check is 403 and nothing is stored or sent', async () => {
    const h = hostedBilling();
    expect((await post(h, { ...FORM, turnstileToken: 'bad' })).status).toBe(403);
    const missing = await post(h, { ...FORM, turnstileToken: undefined });
    expect(missing.status).toBe(403);
    expect(missing.body.error).toBe('turnstile_failed');
    expect(await h.partners.store.list()).toHaveLength(0);
    expect(h.partnerEmails).toHaveLength(0);
  });

  it('at most 5 an hour per IP', async () => {
    const h = hostedBilling();
    for (let i = 0; i < 5; i++) expect((await post(h, FORM)).status).toBe(200);
    const sixth = await post(h, FORM);
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toBe('rate_limited');
    expect(sixth.headers['retry-after']).toBe('3600');
    // Another IP is not limited; an hour later this one isn't either.
    expect((await post(h, FORM, { ip: '198.51.100.1' })).status).toBe(200);
    h.clock.now += 3_600_001;
    expect((await post(h, FORM)).status).toBe(200);
  });

  it('CORS: preflight and responses for valefront.com (and localhost) only', async () => {
    const h = hostedBilling();
    const preflight = (origin: string) => request(h.app).options('/v1/partners/inquiry').set('Host', API).set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type');
    const ok = await preflight(SITE);
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(SITE);
    expect(ok.headers['access-control-allow-methods']).toContain('POST');
    expect(ok.headers['access-control-allow-headers']).toMatch(/content-type/i);
    expect(ok.headers.vary).toMatch(/Origin/);
    for (const local of ['http://localhost:4321', 'http://127.0.0.1:8080', 'http://localhost']) {
      expect((await preflight(local)).headers['access-control-allow-origin']).toBe(local);
    }
    for (const bad of ['https://evil.example', 'https://valefront.com.evil.example', 'http://valefront.com', 'https://dash.valefront.com']) {
      const r = await preflight(bad);
      expect(r.status).toBe(403);
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    }
    const cross = await post(h, FORM, { origin: 'https://evil.example' });
    expect(cross.status).toBe(403);
    expect(cross.body.error).toBe('origin_not_allowed');
    expect(cross.headers['access-control-allow-origin']).toBeUndefined();
    // An error response still carries CORS headers, so the form can show the message.
    const invalid = await post(h, { ...FORM, email: 'x' });
    expect(invalid.headers['access-control-allow-origin']).toBe(SITE);
    // Not the app's open CORS (*) on this route.
    expect((await post(h, FORM, { origin: null })).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('is not served on the admin host, and is 503 when not configured', async () => {
    const h = hostedBilling();
    expect((await post(h, FORM, { host: ADM })).status).toBe(403); // adminHostGate: no Access token
    h.hosted.partners = null;
    const res = await post(h, FORM);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('unavailable');
  });
});

describe('partner inquiries: admin on adm.valefront.com', () => {
  async function seeded() {
    const h = hostedBilling();
    const a = await h.partners.store.add(validateInquiry({ ...FORM, company: 'First Co' }), 'ip1');
    h.clock.now += 1000;
    const b = await h.partners.store.add(validateInquiry({ ...FORM, company: 'Second Co', partnershipType: 'reseller' }), 'ip2');
    return { h, a, b, jwt: h.access.token({ email: 'owner@valefront.com' }) };
  }

  it('lists inquiries newest first, filtered by status, only through Access', async () => {
    const { h, jwt } = await seeded();
    expect((await request(h.app).get('/partners/').set('Host', ADM)).status).toBe(403);
    expect((await request(h.app).get('/partners/').set('Host', ADM).set('Cf-Access-Jwt-Assertion', h.access.token({ email: 'someone@example.com' }))).status).toBe(403);
    const page = await request(h.app).get('/partners/').set('Host', ADM).set('Cf-Access-Jwt-Assertion', jwt);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Partner inquiries');
    expect(page.text.indexOf('Second Co')).toBeLessThan(page.text.indexOf('First Co'));
    expect(page.text).toMatch(/<a href="\/billing\/">(<svg[^]*?<\/svg>)?Customer billing<\/a>/);
    expect((await request(h.app).get('/partners/?status=contacted').set('Host', ADM).set('Cf-Access-Jwt-Assertion', jwt)).text).toContain('No inquiries.');
    // Not on other hosts.
    expect((await request(h.app).get('/partners/').set('Host', API).set('Cf-Access-Jwt-Assertion', jwt)).status).toBe(404);
    // The billing page links here.
    expect((await request(h.app).get('/billing/').set('Host', ADM).set('Cf-Access-Jwt-Assertion', jwt)).text).toMatch(/<a href="\/partners\/">(<svg[^]*?<\/svg>)?Partner inquiries<\/a>/);
  });

  it('changes status and note (same-origin form posts only)', async () => {
    const { h, a, jwt } = await seeded();
    const change = (origin: string | null, body: Record<string, string>) => {
      const r = request(h.app).post(`/partners/${a.id}/status`).set('Host', ADM).set('Cf-Access-Jwt-Assertion', jwt).type('form');
      return (origin ? r.set('Origin', origin) : r).send(body);
    };
    expect((await change(null, { status: 'contacted' })).status).toBe(403);
    expect((await change('https://dash.valefront.com', { status: 'contacted' })).status).toBe(403);
    const ok = await change(`https://${ADM}`, { status: 'contacted', note: 'Call booked Friday', filter: 'new' });
    expect(ok.status).toBe(303);
    expect(ok.headers.location).toMatch(/^\/partners\/\?status=new&note=/);
    expect(await h.partners.store.get(a.id)).toMatchObject({ status: 'contacted', note: 'Call booked Friday', updatedBy: 'owner@valefront.com' });
    const bad = await change(`https://${ADM}`, { status: 'deleted' });
    expect(decodeURIComponent(bad.headers.location)).toContain('Error');
    expect((await h.partners.store.get(a.id))!.status).toBe('contacted');
    const missing = await request(h.app).post('/partners/nope/status').set('Host', ADM).set('Origin', `https://${ADM}`).set('Cf-Access-Jwt-Assertion', jwt).type('form').send({ status: 'closed' });
    expect(decodeURIComponent(missing.headers.location)).toContain('not found');
    const filtered = await request(h.app).get('/partners/?status=contacted').set('Host', ADM).set('Cf-Access-Jwt-Assertion', jwt);
    expect(filtered.text).toContain('First Co');
    expect(filtered.text).not.toContain('Second Co');
  });

  it('escapes what submitters wrote', async () => {
    const h = hostedBilling();
    await new D1PartnerInquiryStore(h.db).add({ ...validateInquiry(FORM), message: '"><img src=x onerror=alert(1)>' }, 'ip');
    const page = await request(h.app).get('/partners/').set('Host', ADM).set('Cf-Access-Jwt-Assertion', h.access.token({ email: 'owner@valefront.com' }));
    expect(page.text).not.toContain('<img src=x');
    expect(page.text).toContain('&lt;img src=x');
  });
});
