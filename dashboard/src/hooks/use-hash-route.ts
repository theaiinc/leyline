import { useEffect, useState } from 'react';

/** The page from the URL hash (#/providers), so pages can be linked and survive reloads. */
export function useHashRoute(fallback: string): [string, (page: string) => void] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('?')[0] || fallback;
  const [page, setPage] = useState(read);
  useEffect(() => {
    const onChange = () => setPage(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return [page, (next: string) => { window.location.hash = `/${next}`; }];
}
