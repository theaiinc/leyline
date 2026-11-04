export function legacyDashboardRedirect(url: URL): Response | null {
  if (url.hostname !== 'llm.theaiinc.com') return null;
  if (url.pathname !== '/' && url.pathname !== '/dashboard' && url.pathname !== '/dashboard/' && !url.pathname.startsWith('/auth/')) {
    return null;
  }
  const dashboard = new URL(url);
  dashboard.hostname = 'dash.valefront.com';
  return Response.redirect(dashboard.toString(), 302);
}