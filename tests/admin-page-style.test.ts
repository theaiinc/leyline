import { readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { ADMIN_NAV_IDS, ADMIN_PAGE_CSS, DARK_TOKENS, LIGHT_TOKENS } from '../src/core/admin-page-style';
import { validateInquiry } from '../src/core/partner-inquiries';
import { ADMIN_PAGES } from '../worker/host-routing';
import { hostedBilling } from './helpers/hosted-billing';

const ADM = 'adm.valefront.com';
const root = path.join(__dirname, '..');

/** `--name: value;` pairs of one top-level block of dashboard/src/styles.css. */
function tokens(selector: string): Record<string, string> {
  const css = readFileSync(path.join(root, 'dashboard/src/styles.css'), 'utf8');
  const block = css.match(new RegExp(`^${selector.replace('.', '\\.')}\\s*\\{([^]*?)\\n\\}`, 'm'))![1];
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]));
}

describe('adm server pages look like the adm app', () => {
  test('colour tokens are the dashboard\'s, light and dark', () => {
    expect(LIGHT_TOKENS).toEqual(tokens(':root'));
    expect(DARK_TOKENS).toEqual(tokens('.dark'));
    expect(ADMIN_PAGE_CSS).toContain('font-family:Inter,ui-sans-serif');
  });

  test('the side nav has every adm page (dashboard/src/app.tsx), app pages as their paths', () => {
    const app = readFileSync(path.join(root, 'dashboard/src/app.tsx'), 'utf8');
    const ids = [...app.matchAll(/\{ id: '([\w-]+)'/g)].map((m) => m[1]).concat('customer-billing', 'partner-inquiries');
    expect([...ADMIN_NAV_IDS].sort()).toEqual([...ids].sort());
    for (const id of ADMIN_NAV_IDS.filter((i) => i !== 'customer-billing' && i !== 'partner-inquiries')) expect(ADMIN_PAGES.has(`/${id}`)).toBe(true);
  });

  const shell = (html: string, current: string) => {
    expect(html).toContain('<div class="shell">');
    expect(html).toContain('<aside class="side">');
    expect(html).toContain('<span class="pill">Admin</span>');
    for (const href of ['/overview', '/benchmarks', '/keys', '/spending', '/billing/', '/partners/', '/activity']) expect(html).toContain(`href="${href}"`);
    expect(html).toMatch(new RegExp(`<a href="${current}" aria-current="page">`));
    expect(html).toContain("localStorage.getItem('valefront.theme')");
    expect(html).toContain('href="/cdn-cgi/access/logout"');
    expect(html).not.toMatch(/style="[^"]*color:#/);
  };

  test('Billing renders in the adm shell', async () => {
    const h = hostedBilling();
    const page = await request(h.app).get('/billing/?status=paid').set('Host', ADM).set('Cf-Access-Jwt-Assertion', h.access.token({ email: 'owner@valefront.com' }));
    expect(page.status).toBe(200);
    shell(page.text, '/billing/');
    expect(page.text).toContain('<nav class="filters"><a href="/billing/">All</a><a href="/billing/?status=pending">Pending</a><a href="/billing/?status=paid" aria-current="page">Paid</a>');
    expect(page.text).toMatch(/class="badge (warn|live)">(SANDBOX|LIVE)</);
    // The forms are where they were.
    for (const action of ['/billing/settings/exchange-rate', '/billing/settings/worldfirst', '/billing/settings/legal', '/billing/settings/vat', '/billing/einvoices/process', '/billing/providers/paypal/mode']) expect(page.text).toContain(`action="${action}"`);
  });

  test('Partners renders in the adm shell', async () => {
    const h = hostedBilling();
    await h.partners.store.add(validateInquiry({ company: 'Acme AI', contactName: 'Linh', email: 'partnerships.lead@acme-example.ai', website: 'acme.ai', modelsOffered: 'Acme-1', modalities: ['text'], partnershipType: 'list-models', turnstileToken: 'ok', lang: 'en' }), 'ip');
    const page = await request(h.app).get('/partners/').set('Host', ADM).set('Cf-Access-Jwt-Assertion', h.access.token({ email: 'owner@valefront.com' }));
    expect(page.status).toBe(200);
    shell(page.text, '/partners/');
    expect(page.text).toContain('<a href="/partners/" aria-current="page">All (1)</a>');
    expect(page.text).toContain('<a href="mailto:partnerships.lead@acme-example.ai">');
    expect(page.text).toMatch(/form class="status" method="post" action="\/partners\/[\w-]+\/status"/);
  });

  test('a service token is not offered sign-out', async () => {
    const h = hostedBilling();
    const page = await request(h.app).get('/billing/').set('Host', ADM).set('Cf-Access-Jwt-Assertion', h.access.token({ common_name: 'svc-1.access' }));
    expect(page.status).toBe(200);
    expect(page.text).not.toContain('/cdn-cgi/access/logout');
  });
});
