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

/**
 * The customer dashboard's pages, linked as paths (https://dash.valefront.com/billing, PayPal's return address): the
 * Worker serves the app for them and the app reads the page from the path (dashboard/src/hooks/use-path-route.ts).
 * Only a browser's page load (GET/HEAD asking for HTML), so the old root API paths and webhooks are untouched.
 */
export const CUSTOMER_PAGES = new Set(['/get-started', '/keys', '/providers', '/playground', '/billing', '/spending', '/usage', '/calculator', '/data']);
export function dashboardPagePath(request: Request, url: URL): boolean {
  if (url.hostname === 'llm.valefront.com' || url.hostname === 'llm.theaiinc.com') return false;
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (!CUSTOMER_PAGES.has(url.pathname.replace(/\/+$/, ''))) return false;
  return (request.headers.get('accept') ?? '').includes('text/html');
}

/** Rewrites browser-cached root API paths to the dashboard API namespace on dashboard hosts. */
export function dashboardApiRequest(request: Request): Request | null {
  const url = new URL(request.url);
  if (url.hostname === 'llm.valefront.com' || url.hostname === 'llm.theaiinc.com') return null;
  if (
    url.pathname === '/' ||
    url.pathname.startsWith('/dashboard/') ||
    url.pathname === '/dashboard' ||
    url.pathname.startsWith('/assets/') ||
    DASHBOARD_API_EXCLUSIONS.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
  ) return null;
  const rewritten = new URL(`/dashboard${url.pathname}${url.search}`, url);
  return new Request(rewritten, request);
}

const DASHBOARD_API_EXCLUSIONS = ['/auth', '/v1', '/healthz', '/admin', '/mcp', '/readyz', '/webhooks', '/billing', '/partners'];