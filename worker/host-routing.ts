import { isDashboardPagePath } from '../src/dashboard-pages';

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

/** Real dashboard page paths are handled by the worker's navigation fallback, not redirected to hash routes. */
export function dashboardRouteRedirect(url: URL): Response | null {
  if (url.hostname === 'llm.valefront.com' || url.hostname === 'llm.theaiinc.com') return null;
  return null;
}

/** True only for browser navigations to a known dashboard page, never API/fetch requests. */
export function isDashboardPageNavigation(request: Request): boolean {
  const url = new URL(request.url);
  if (url.hostname !== 'dash.valefront.com' && url.hostname !== 'adm.valefront.com') return false;
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (!isDashboardPagePath(url.pathname)) return false;
  const accept = request.headers.get('accept') ?? '';
  const fetchMode = request.headers.get('sec-fetch-mode');
  return accept.includes('text/html') && (fetchMode === 'navigate' || fetchMode === null);
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