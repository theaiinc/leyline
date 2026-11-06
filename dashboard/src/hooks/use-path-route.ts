import { useCallback, useEffect, useState } from 'react';

/**
 * The page from the URL path (dash.valefront.com/billing), so pages read like normal links (Steve 2026-11-06: no
 * `#/` on the customer dashboard). Old hash links (/#/billing?…) still work: they are rewritten to the path once.
 * The Worker serves the app for these paths (worker/host-routing.ts dashboardPagePath).
 */
export function usePathRoute(fallback: string): [string, (page: string) => void] {
  const fromHash = () => {
    const h = window.location.hash;
    if (!h.startsWith('#/')) return null;
    const [page = '', query = ''] = h.slice(2).split('?');
    return { page, query };
  };
  const read = () => window.location.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || fallback;
  const adoptHash = () => {
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
  }, []);
  const go = useCallback((next: string) => {
    if (read() === next && !window.location.search) return;
    window.history.pushState(null, '', `/${next}`);
    setPage(next);
  }, []);
  return [page, go];
}
