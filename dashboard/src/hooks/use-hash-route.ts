import { useEffect, useState } from 'react';

import { DASHBOARD_PAGE_PATHS, isDashboardPagePath } from '../../../src/dashboard-pages';

function pageFromPath(pathname: string, fallback: string): string {
  const page = pathname.replace(/^\/+/, '').split('/')[0] || fallback;
  return DASHBOARD_PAGE_PATHS.includes(page as (typeof DASHBOARD_PAGE_PATHS)[number]) ? page : fallback;
}

function readPage(fallback: string): string {
  const hash = window.location.hash;
  if (hash.startsWith('#/')) {
    const legacyPage = hash.slice(2).split('?')[0] || fallback;
    const target = `/${legacyPage}`;
    window.history.replaceState(null, '', target);
    return pageFromPath(target, fallback);
  }
  return pageFromPath(window.location.pathname, fallback);
}

/** The dashboard page from the URL, migrating legacy #/ links with replaceState. */
export function useHashRoute(fallback: string): [string, (page: string) => void] {
  const [page, setPage] = useState(() => readPage(fallback));
  useEffect(() => {
    const onChange = () => setPage(readPage(fallback));
    window.addEventListener('popstate', onChange);
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('popstate', onChange);
      window.removeEventListener('hashchange', onChange);
    };
  }, [fallback]);
  return [page, (next: string) => {
    const target = `/${next}`;
    window.history.pushState(null, '', target);
    setPage(pageFromPath(target, fallback));
  }];
}
