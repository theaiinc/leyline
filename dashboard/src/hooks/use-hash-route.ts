import { useEffect, useState } from 'react';

const DASHBOARD_PREFIX = /^\/dashboard(?:\/|$)/;

function pageFromPathname(pathname: string, fallback: string): string {
  const path = pathname
    .replace(DASHBOARD_PREFIX, '')
    .replace(/^\/+|\/+$/g, '');
  return path || fallback;
}

function canonicalPath(page: string): string {
  const [path, query = ''] = page.split('?');
  const clean = path.replace(/^\/+|\/+$/g, '');
  return `/${clean}${query ? `?${query}` : ''}`;
}

/** Read dashboard pages from history paths while accepting legacy hash links. */
export function useHashRoute(fallback: string): [string, (page: string) => void] {
  const read = () => {
    const hash = window.location.hash.replace(/^#\/?/, '');
    if (hash) return hash || fallback;
    const page = pageFromPathname(window.location.pathname, fallback);
    return `${page}${window.location.search}`;
  };
  const [page, setPage] = useState(read);

  useEffect(() => {
    const onNavigate = () => setPage(read());
    window.addEventListener('popstate', onNavigate);
    window.addEventListener('hashchange', onNavigate);
    if (window.location.hash) {
      window.history.replaceState(null, '', canonicalPath(read()));
      setPage(read());
    }
    return () => {
      window.removeEventListener('popstate', onNavigate);
      window.removeEventListener('hashchange', onNavigate);
    };
  }, []);

  const go = (next: string) => {
    const path = canonicalPath(next);
    if (`${window.location.pathname}${window.location.search}` !== path) {
      window.history.pushState(null, '', path);
    }
    setPage(next);
  };

  return [page, go];
}

