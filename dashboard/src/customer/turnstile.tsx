import { useEffect, useRef } from 'react';

type TurnstileApi = {
  render(el: HTMLElement, opts: { sitekey: string; callback: (token: string) => void; 'expired-callback'?: () => void; 'error-callback'?: () => void; theme?: string; action?: string }): string;
  reset(id?: string): void;
  remove(id?: string): void;
};
declare global {
  interface Window { turnstile?: TurnstileApi }
}

let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not load')));
    script.onerror = () => { loading = null; reject(new Error('Turnstile did not load')); };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Cloudflare Turnstile, the security check before sign-up, new keys and Add credit. Each token works once: after a
 * request uses it, change `resetKey` to get a new one.
 */
export function Turnstile({ siteKey, action, onToken, resetKey = 0 }: { siteKey: string | null; action: string; onToken: (token: string | null) => void; resetKey?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!siteKey || !ref.current) return;
    let id: string | undefined;
    let cancelled = false;
    onToken(null);
    loadTurnstile().then((api) => {
      if (cancelled || !ref.current) return;
      id = api.render(ref.current, {
        sitekey: siteKey,
        action,
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
        callback: (token) => onToken(token),
        'expired-callback': () => onToken(null),
        'error-callback': () => onToken(null),
      });
    }).catch(() => onToken(null));
    return () => {
      cancelled = true;
      if (id && window.turnstile) window.turnstile.remove(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, action, resetKey]);
  if (!siteKey) return <p className="text-sm text-destructive">The security check is not configured yet; sign-up is paused.</p>;
  return <div ref={ref} className="min-h-[65px]" />;
}
