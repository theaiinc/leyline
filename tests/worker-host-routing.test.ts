import { dashboardApiRequest, dashboardPageRedirect, legacyDashboardRedirect } from '../worker/host-routing';

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

  test.each(['llm.valefront.com', 'llm.theaiinc.com'])('does not rewrite API host %s', (hostname) => {
    expect(dashboardApiRequest(new Request(`https://${hostname}/session`))).toBeNull();
  });
});