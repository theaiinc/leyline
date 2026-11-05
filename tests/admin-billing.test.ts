import request from 'supertest';
import { SETTINGS } from '../src/core/billing-service';
import { getMode, providerStatus, secretsFor, setMode } from '../src/core/provider-modes';
import { BUYER, WORLDFIRST, workspace } from './helpers/billing-fixture';
import { cookieFor, hostedBilling } from './helpers/hosted-billing';

const ADM = 'adm.valefront.com';

async function pendingOrder(h: ReturnType<typeof hostedBilling>) {
  await h.store.saveSetting(SETTINGS.account, WORLDFIRST, 'admin');
  const ws = await workspace(h.store);
  await h.service.saveProfile(ws, BUYER);
  return { ws, order: (await h.service.createOrder(ws, { amountCents: 5000, method: 'worldfirst', idempotencyKey: `adm-${Math.random().toString(36).slice(2, 10)}` })).order };
}

describe('billing admin on adm.valefront.com (Cloudflare Access + the app\'s own check)', () => {
  it('needs a valid Access token for an admin email, for this application', async () => {
    const h = hostedBilling();
    const get = (jwt?: string) => { const r = request(h.app).get('/billing/').set('Host', ADM); return jwt ? r.set('Cf-Access-Jwt-Assertion', jwt) : r; };
    expect((await get()).status).toBe(403);
    expect((await get(h.access.token({ email: 'someone@example.com' }))).status).toBe(403);
    expect((await get(h.access.token({ email: 'owner@valefront.com', aud: ['other-app'] }))).status).toBe(403);
    expect((await get(h.access.token({ email: 'owner@valefront.com', exp: Math.floor(Date.now() / 1000) - 10 }))).status).toBe(403);
    expect((await get(h.access.token({ email: 'owner@valefront.com', iss: 'https://evil.cloudflareaccess.com' }))).status).toBe(403);
    const forged = h.access.token({ email: 'someone@example.com' }).split('.');
    forged[1] = Buffer.from(JSON.stringify({ iss: 'https://theaiinc.cloudflareaccess.com', aud: ['aud-tag-123'], email: 'owner@valefront.com', exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
    expect((await get(forged.join('.'))).status).toBe(403);
    const ok = await get(h.access.token({ email: 'Owner@Valefront.com'.toLowerCase() }));
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('Valefront billing admin');
    // An allowed service token (automation) too.
    expect((await get(h.access.token({ common_name: 'svc-1.access' }))).status).toBe(200);
    expect((await get(h.access.token({ common_name: 'svc-2.access' }))).status).toBe(403);
  });

  it('is not configured: nobody gets in', async () => {
    const h = hostedBilling({ hosted: { access: null } });
    expect((await request(h.app).get('/billing/').set('Host', ADM).set('Cf-Access-Jwt-Assertion', 'x')).status).toBe(503);
  });

  it('mark paid credits once; the admin host serves the owner dashboard only through Access, and billing admin paths exist on no other host', async () => {
    const h = hostedBilling();
    const { ws, order } = await pendingOrder(h);
    const jwt = h.access.token({ email: 'owner@valefront.com' });
    const mark = (origin?: string) => {
      const r = request(h.app).post(`/billing/orders/${order.id}/mark-paid`).set('Host', ADM).set('Cf-Access-Jwt-Assertion', jwt).type('form').send({ bankReference: 'WF-123', receivedUsd: '50.00' });
      return origin ? r.set('Origin', origin) : r;
    };
    expect((await mark()).status).toBe(403);
    expect((await mark('https://dash.valefront.com')).status).toBe(403);
    const first = await mark(`https://${ADM}`);
    expect(first.status).toBe(303);
    expect(decodeURIComponent(first.headers.location)).toContain('marked paid');
    const second = await mark(`https://${ADM}`);
    expect(decodeURIComponent(second.headers.location)).toContain('already paid');
    expect((await h.store.balance(ws.id)).cents).toBe(5000);
    expect((await h.store.receiptForOrder(order.id))!.providerReference).toBe('WF-123');
    // Not on the API or dashboard hosts; and the admin host has no customer or API routes.
    expect((await request(h.app).post(`/billing/orders/${order.id}/mark-paid`).set('Host', 'llm.valefront.com').set('Cf-Access-Jwt-Assertion', jwt)).status).toBe(404);
    // The admin host serves the owner's dashboard to an Access-verified admin (and only to them).
    const session = await request(h.app).get('/dashboard/session').set('Host', ADM).set('Cf-Access-Jwt-Assertion', jwt);
    expect(session.body).toMatchObject({ hosted: true, admin: true });
    expect((await request(h.app).get('/dashboard/session').set('Host', ADM)).status).toBe(403);
  });

  it('a received amount that is not the order total is not marked paid', async () => {
    const h = hostedBilling();
    const { ws, order } = await pendingOrder(h);
    const res = await request(h.app).post(`/billing/orders/${order.id}/mark-paid`).set('Host', ADM).set('Origin', `https://${ADM}`)
      .set('Cf-Access-Jwt-Assertion', h.access.token({ email: 'owner@valefront.com' })).type('form').send({ receivedUsd: '49.00' });
    expect(decodeURIComponent(res.headers.location)).toContain('Not marked paid');
    expect((await h.store.balance(ws.id)).cents).toBe(0);
  });

  it('settings: WorldFirst account, legal details, VAT rates', async () => {
    const h = hostedBilling();
    const post = (path: string, body: Record<string, string>) => request(h.app).post(`/billing${path}`).set('Host', ADM).set('Origin', `https://${ADM}`)
      .set('Cf-Access-Jwt-Assertion', h.access.token({ email: 'owner@valefront.com' })).type('form').send(body);
    await post('/settings/worldfirst', { accountName: 'THE AI', accountNumber: '123', bankName: 'CFSB', swiftCode: 'cmfgus33' });
    expect(await h.service.account()).toMatchObject({ swiftCode: 'CMFGUS33', currency: 'USD' });
    expect(decodeURIComponent((await post('/settings/legal', { companyName: '' })).headers.location)).toContain('required');
    await post('/settings/vat', { defaultBp: '0', byCountry: 'VN=800' });
    expect(await h.service.vat()).toEqual({ defaultBp: 0, byCountry: { VN: 800 } });
  });

  it('provider modes: live only after typing LIVE, audit-logged; credentials shown as present or not, never their values', async () => {
    const h = hostedBilling();
    const jwt = h.access.token({ email: 'owner@valefront.com' });
    const page = await request(h.app).get('/billing/').set('Host', ADM).set('Cf-Access-Jwt-Assertion', jwt);
    expect(page.text).toContain('PAYPAL_LIVE_CLIENT_SECRET: set');
    expect(page.text).toContain('PAYPAL_SANDBOX_CLIENT_ID: missing');
    expect(page.text).not.toContain('super-secret-value');
    const switchTo = (mode: string, confirm?: string) => request(h.app).post('/billing/providers/paypal/mode').set('Host', ADM).set('Origin', `https://${ADM}`).set('Cf-Access-Jwt-Assertion', jwt).type('form').send({ mode, ...(confirm ? { confirm } : {}) });
    expect(decodeURIComponent((await switchTo('live')).headers.location)).toContain('Type LIVE');
    expect(await getMode(h.store, 'paypal')).toBe('sandbox');
    await switchTo('live', 'LIVE');
    expect(await getMode(h.store, 'paypal')).toBe('live');
    const audit = h.db.sqlite.prepare("SELECT meta FROM audit_events WHERE type = 'provider.mode_changed'").all() as Array<{ meta: string }>;
    expect(JSON.parse(audit[0]!.meta)).toEqual({ provider: 'paypal', from: 'sandbox', to: 'live', by: 'owner@valefront.com' });
    await switchTo('sandbox');
    expect(await getMode(h.store, 'paypal')).toBe('sandbox');
  });
});

describe('provider modes (reusable by Bookkeeper)', () => {
  const store = () => {
    const m = new Map<string, unknown>();
    return { setting: async <T,>(k: string) => (m.has(k) ? { value: m.get(k) as T, updatedAt: 1, updatedBy: 'x' } : null), saveSetting: async (k: string, v: unknown) => { m.set(k, v); } };
  };

  it('defaults to sandbox; live needs LIVE; per-mode secrets', async () => {
    const s = store();
    expect(await getMode(s, 'sinvoice')).toBe('sandbox');
    await expect(setMode(s, 'sinvoice', 'live', { by: 'a', confirm: 'live' })).rejects.toThrow('Type LIVE');
    await setMode(s, 'sinvoice', 'live', { by: 'a', confirm: 'LIVE' });
    expect(await getMode(s, 'sinvoice')).toBe('live');
    const env = { PAYPAL_SANDBOX_CLIENT_ID: 'i', PAYPAL_SANDBOX_CLIENT_SECRET: 's', PAYPAL_SANDBOX_WEBHOOK_ID: 'w', PAYPAL_LIVE_CLIENT_ID: 'li' };
    expect(secretsFor(env, 'paypal', 'sandbox')).toEqual({ CLIENT_ID: 'i', CLIENT_SECRET: 's', WEBHOOK_ID: 'w' });
    expect(secretsFor(env, 'paypal', 'live')).toBeNull();
    const status = await providerStatus(s, env);
    expect(status.find((p) => p.id === 'paypal')).toMatchObject({ mode: 'sandbox', sandbox: { ready: true }, live: { ready: false } });
    expect(JSON.stringify(status)).not.toContain('"i"');
  });

  it('dash.valefront.com is for customers: an admin email signed in there is not the owner (Steve, 2026-11-05)', async () => {
    const h = hostedBilling();
    const res = await request(h.app).get('/dashboard/session').set('Host', 'dash.valefront.com').set('Cookie', cookieFor('owner-sub', 'owner@valefront.com'));
    expect(res.body).toMatchObject({ hosted: true, email: 'owner@valefront.com', admin: false });
    expect((await request(h.app).get('/dashboard/stats').set('Host', 'dash.valefront.com').set('Cookie', cookieFor('owner-sub', 'owner@valefront.com'))).status).toBe(401);
  });
});
