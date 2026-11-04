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

/** Rewrites browser-cached root API paths to the dashboard API namespace on dashboard hosts. */
export function dashboardApiRequest(request: Request): Request | null {
  const url = new URL(request.url);
  if (url.hostname === 'llm.valefront.com') return null;
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

const DASHBOARD_API_EXCLUSIONS = ['/auth', '/v1', '/healthz', '/admin'];