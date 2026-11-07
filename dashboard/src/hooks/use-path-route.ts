import { useCallback, useEffect, useState } from 'react';

/** Whether this app reads its page from the path (set by usePathRoute); local dashboards keep #/ pages. */
let pathMode = false;

/**
 * The page from the URL path (dash.valefront.com/billing, adm.valefront.com/benchmarks), so pages read like normal
 * links (Steve 2026-11-06/07: no `#/` on the hosted dashboards). Old hash links (/#/billing?…) still work: they are
 * rewritten to the path once. The Worker serves the app for these paths (worker/host-routing.ts dashboardPagePath,
 * adminPagePath). With `paths: false` (the local dashboard, served under /dashboard/ or by Tauri) pages stay #/x.
 */
export function usePathRoute(fallback: string, { paths = true }: { paths?: boolean } = {}): [string, (page: string) => void] {
  if (paths) pathMode = true;
  const fromHash = () => {
    const h = window.location.hash;
    if (!h.startsWith('#/')) return null;
    const [page = '', query = ''] = h.slice(2).split('?');
    return { page, query };
  };
  const read = () => paths
    ? window.location.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || fallback
    : window.location.hash.replace(/^#\/?/, '').split('?')[0] || fallback;
  const adoptHash = () => {
    if (!paths) return false;
    const legacy = fromHash();
    if (!legacy || !legacy.page) return false;
    window.history.replaceState(null, '', `/${legacy.page}${legacy.query ? `?${legacy.query}` : ''}`);
    return true;
  };
  const [page, setPage] = useState(() => { adoptHash(); return read(); });
  useEffect(() => {
    const onChange = () => { adoptHash(); setPage(read()); };
    window.addEventListener('popstate', onChange);
    window.addEventListener('hashchange', onChange);
    return () => { window.removeEventListener('popstate', onChange); window.removeEventListener('hashchange', onChange); };
  }, [paths]);
  const go = useCallback((next: string) => {
    if (!paths) { window.location.hash = `/${next}`; return; }
    if (read() === next && !window.location.search) return;
    window.history.pushState(null, '', `/${next}`);
    setPage(next);
  }, [paths]);
  return [page, go];
}

/** Opens a page of this app with its query ("/spending?key=k1"): a path on the hosted dashboards, #/ locally. */
export function openPage(target: string): void {
  const path = target.startsWith('/') ? target : `/${target}`;
  if (!pathMode) { window.location.hash = `#${path}`; return; }
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
