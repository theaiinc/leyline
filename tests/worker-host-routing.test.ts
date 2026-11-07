import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ADMIN_PAGES, ADMIN_SERVER_PATHS, CUSTOMER_PAGES, adminPagePath, dashboardApiRequest, dashboardPagePath, dashboardPageRedirect, legacyDashboardRedirect } from '../worker/host-routing';

describe('legacy dashboard host routing', () => {
  test.each(['/', '/dashboard', '/dashboard/', '/auth/login', '/auth/callback'])(
    'redirects %s to the canonical dashboard host with its query',
    (path) => {
      const response = legacyDashboardRedirect(new URL(`https://llm.theaiinc.com${path}?next=%2Fdashboard`));
      expect(response).not.toBeNull();
      expect(response?.status).toBe(302);
      expect(response?.headers.get('location')).toBe(`https://dash.valefront.com${path}?next=%2Fdashboard`);
    },
  );

  test('does not redirect legacy API requests', () => {
    expect(legacyDashboardRedirect(new URL('https://llm.theaiinc.com/v1/chat/completions'))).toBeNull();
  });

  test('does not redirect unrelated hosts', () => {
    expect(legacyDashboardRedirect(new URL('https://dash.valefront.com/auth/login'))).toBeNull();
  });

  test.each(['/dashboard/session', '/dashboard/api-keys'])('leaves dashboard API path %s for the app', (path) => {
    expect(dashboardPageRedirect(new URL(`https://dash.valefront.com${path}`))).toBeNull();
  });

  test('redirects dashboard page on the dashboard host to root', () => {
    const response = dashboardPageRedirect(new URL('https://dash.valefront.com/dashboard/'));
    expect(response?.status).toBe(301);
    expect(response?.headers.get('location')).toBe('https://dash.valefront.com/');
  });

  test('redirects dashboard page on the API host to the dashboard host', () => {
    const response = dashboardPageRedirect(new URL('https://llm.valefront.com/dashboard/'));
    expect(response?.status).toBe(301);
    expect(response?.headers.get('location')).toBe('https://dash.valefront.com/');
  });

  test.each(['/mcp', '/readyz'])('does not rewrite dashboard host infrastructure path %s', (path) => {
    expect(dashboardApiRequest(new Request(`https://dash.valefront.com${path}`))).toBeNull();
  });

  test.each(['/partners/', '/partners/abc/status', '/billing/'])('does not rewrite the admin host\'s server page %s', (path) => {
    expect(dashboardApiRequest(new Request(`https://adm.valefront.com${path}`))).toBeNull();
  });

  test.each(['llm.valefront.com', 'llm.theaiinc.com'])('does not rewrite API host %s', (hostname) => {
    expect(dashboardApiRequest(new Request(`https://${hostname}/session`))).toBeNull();
  });
});
describe('dashboard pages linked as paths', () => {
  const get = (u: string, accept = 'text/html,application/xhtml+xml') => new Request(u, { headers: { accept } });
  test('https://dash.valefront.com/billing (the 402 message, PayPal\'s return) is served as the app, query kept for it', () => {
    const u = 'https://dash.valefront.com/billing?paypal=return&order=ord_1';
    expect(dashboardPagePath(get(u), new URL(u))).toBe(true);
    for (const p of ['/keys', '/providers', '/playground', '/spending', '/usage', '/get-started', '/data/']) {
      expect(dashboardPagePath(get(`https://dash.valefront.com${p}`), new URL(`https://dash.valefront.com${p}`))).toBe(true);
    }
  });

  test('API hosts, API paths, non-HTML and non-GET requests are left alone', () => {
    const u = 'https://dash.valefront.com/billing';
    expect(dashboardPagePath(get('https://llm.valefront.com/billing'), new URL('https://llm.valefront.com/billing'))).toBe(false);
    expect(dashboardPagePath(get('https://dash.valefront.com/dashboard/me/billing'), new URL('https://dash.valefront.com/dashboard/me/billing'))).toBe(false);
    expect(dashboardPagePath(get(u, 'application/json'), new URL(u))).toBe(false);
    expect(dashboardPagePath(new Request(u, { method: 'POST', headers: { accept: 'text/html' } }), new URL(u))).toBe(false);
  });

  test('the PayPal webhook is not rewritten into the dashboard API', () => {
    expect(dashboardApiRequest(new Request('https://dash.valefront.com/webhooks/paypal', { method: 'POST' }))).toBeNull();
  });
});

describe('owner dashboard pages on the admin host linked as paths', () => {
  const ADM = 'adm.valefront.com';
  const get = (u: string, accept = 'text/html,application/xhtml+xml') => new Request(u, { headers: { accept } });
  const page = (p: string, accept?: string, host = ADM) => adminPagePath(get(`https://${host}${p}`, accept), new URL(`https://${host}${p}`), ADM);

  test.each([...ADMIN_PAGES, '/benchmarks/', '/spending?key=k1'])('https://adm.valefront.com%s is served as the app', (p) => {
    expect(page(p)).toBe(true);
  });

  test.each([
    '/', '/billing', '/billing/', '/billing/?status=pending', '/partners', '/partners/', '/partners/abc/status', '/admin',
    '/admin/api/spend', '/auth/login', '/dashboard', '/dashboard/session', '/v1/models', '/v1/benchmarks/refresh', '/mcp',
    '/healthz', '/readyz', '/webhooks/paypal', '/cdn-cgi/access/logout', '/customer-billing', '/partner-inquiries', '/nope',
    '/benchmarks/extra',
  ])('server and unknown path %s on the admin host is left to the server', (p) => {
    expect(page(p)).toBe(false);
  });

  test('no owner dashboard page shadows a server path on the admin host', () => {
    for (const p of ADMIN_PAGES) expect(ADMIN_SERVER_PATHS).not.toContain(p);
    // dash's /billing page is a server page on adm: it is not an admin page.
    expect(CUSTOMER_PAGES.has('/billing') && !ADMIN_PAGES.has('/billing') && !ADMIN_PAGES.has('/partners')).toBe(true);
  });

  test('the app\'s own fetches, non-GET requests and other hosts are not served the app', () => {
    expect(page('/benchmarks', 'application/json')).toBe(false);
    expect(page('/providers', '*/*')).toBe(false);
    const u = `https://${ADM}/keys`;
    expect(adminPagePath(new Request(u, { method: 'POST', headers: { accept: 'text/html' } }), new URL(u), ADM)).toBe(false);
    expect(page('/benchmarks', undefined, 'dash.valefront.com')).toBe(false);
    expect(page('/benchmarks', undefined, 'llm.valefront.com')).toBe(false);
  });

  test('a page\'s legacy API path still reaches the server API (only page loads are the app)', () => {
    expect(dashboardApiRequest(new Request(`https://${ADM}/providers`))?.url).toBe(`https://${ADM}/dashboard/providers`);
  });

  test('dash pages are unchanged: adm-only pages are not customer pages', () => {
    const u = 'https://dash.valefront.com/benchmarks';
    expect(dashboardPagePath(get(u), new URL(u))).toBe(false);
  });

  test('every page in the owner dashboard nav is an admin page path, and the server pages are links', () => {
    const app = readFileSync(path.join(__dirname, '../dashboard/src/app.tsx'), 'utf8');
    const ids = [...app.matchAll(/\{ id: '([\w-]+)'/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids) expect(ADMIN_PAGES.has(`/${id}`)).toBe(true);
    expect(app).toContain("[CUSTOMER_BILLING]: '/billing/', [PARTNER_INQUIRIES]: '/partners/'");
  });
});
