export function legacyDashboardRedirect(url: URL): Response | null {
  if (url.hostname !== 'llm.theaiinc.com') return null;
  if (url.pathname !== '/' && url.pathname !== '/dashboard' && url.pathname !== '/dashboard/' && !url.pathname.startsWith('/auth/')) {
    return null;
  }
  const dashboard = new URL(url);
  dashboard.hostname = 'dash.valefront.com';
  return Response.redirect(dashboard.toString(), 302);
}

/** Redirect only dashboard page requests; dashboard API requests must reach Express unchanged. */
export function dashboardPageRedirect(url: URL): Response | null {
  const page = url.pathname === '/dashboard' || url.pathname === '/dashboard/' || url.pathname === '/dashboard/index.html';
  const asset = url.pathname.startsWith('/dashboard/assets/');
  if (!page && !asset) return null;
  const suffix = url.pathname.slice('/dashboard'.length) || '/';
  const target = new URL(`${suffix}${url.search}`, url.hostname === 'llm.valefront.com' ? 'https://dash.valefront.com' : url.origin);
  return Response.redirect(target.toString(), 301);
}

/** Browser navigations served by the dashboard SPA on dash.valefront.com and adm.valefront.com. */
export const DASHBOARD_PAGE_PATHS = new Set([
  '/',
  '/overview',
  '/providers',
  '/routing',
  '/playground',
  '/providers',
  '/spending',
  '/usage',
  '/keys',
  '/calculator',
  '/billing',
  '/get-started',
  '/data',
]);

/** Rewrites browser-cached root API paths to the dashboard API namespace on dashboard hosts. */
export function dashboardApiRequest(request: Request): Request | null {
  const url = new URL(request.url);
  if (url.hostname === 'llm.valefront.com' || url.hostname === 'llm.theaiinc.com') return null;
  if (
    url.pathname === '/' ||
    url.pathname.startsWith('/dashboard/') ||
    url.pathname === '/dashboard' ||
    url.pathname.startsWith('/assets/') ||
    DASHBOARD_PAGE_PATHS.has(url.pathname) ||
    DASHBOARD_API_EXCLUSIONS.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
  ) return null;
  const rewritten = new URL(`/dashboard${url.pathname}${url.search}`, url);
  return new Request(rewritten, request);
}

/** Redirect legacy path-based dashboard pages to the hash-router URLs used by the customer dashboard. */
export function dashboardRouteRedirect(url: URL): Response | null {
  if (url.hostname !== 'dash.valefront.com' || !DASHBOARD_PAGE_PATHS.has(url.pathname) || url.pathname === '/') return null;
  const target = new URL(url.origin);
  target.hash = `${url.pathname}${url.search}`;
  return Response.redirect(target.toString(), 302);
}

const DASHBOARD_API_EXCLUSIONS = ['/auth', '/v1', '/healthz', '/admin', '/mcp', '/readyz', '/webhooks', '/billing', '/partners'];