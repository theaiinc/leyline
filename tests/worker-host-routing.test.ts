import { DASHBOARD_PAGE_PATHS, isDashboardPagePath } from '../src/dashboard-pages';
import { dashboardApiRequest, dashboardPageRedirect, dashboardRouteRedirect, isDashboardPageNavigation, legacyDashboardRedirect } from '../worker/host-routing';

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

  test('known page paths are served only for HTML navigations', () => {
    const navigation = new Request('https://dash.valefront.com/providers', {
      headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
    });
    const fetchRequest = new Request('https://dash.valefront.com/providers', {
      headers: { accept: 'application/json', 'sec-fetch-mode': 'cors' },
    });
    expect(isDashboardPageNavigation(navigation)).toBe(true);
    expect(isDashboardPageNavigation(fetchRequest)).toBe(false);
    expect(dashboardApiRequest(fetchRequest)?.url).toBe('https://dash.valefront.com/dashboard/providers');
  });

  test('shared dashboard page paths do not overlap API paths', () => {
    for (const page of DASHBOARD_PAGE_PATHS) {
      expect(isDashboardPagePath(`/dashboard/${page}`)).toBe(false);
      expect(isDashboardPagePath(`/${page}`)).toBe(true);
    }
  });
});
describe('dashboard pages linked as paths', () => {
  test('real dashboard page paths are served directly, preserving the query', () => {
    expect(dashboardRouteRedirect(new URL('https://dash.valefront.com/billing?paypal=return&order=ord_1'))).toBeNull();
  });

  test('old paths keep working; API hosts and API paths are left alone', () => {
    expect(dashboardRouteRedirect(new URL('https://dash.valefront.com/usage'))).toBeNull();
    expect(dashboardRouteRedirect(new URL('https://llm.valefront.com/billing'))).toBeNull();
    expect(dashboardRouteRedirect(new URL('https://dash.valefront.com/dashboard/me/billing'))).toBeNull();
  });

  test('the PayPal webhook is not rewritten into the dashboard API', () => {
    expect(dashboardApiRequest(new Request('https://dash.valefront.com/webhooks/paypal', { method: 'POST' }))).toBeNull();
  });
});
