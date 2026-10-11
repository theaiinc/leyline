import { useEffect, useState } from 'react';
import { Activity, FlaskConical, KeyRound, LayoutDashboard, Layers, LogOut, Moon, RefreshCw, Route, Server, Sun, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/common';
import { apiUrl } from '@/api';
import { useDashboard } from '@/hooks/use-dashboard';
import { useHashRoute } from '@/hooks/use-hash-route';
import { cn } from '@/lib/utils';
import { ActivityPage } from '@/pages/activity';
import { KeysPage } from '@/pages/keys';
import { OfferedPage } from '@/pages/offered';
import { OverviewPage } from '@/pages/overview';
import { PlaygroundPage } from '@/pages/playground';
import { ProvidersPage } from '@/pages/providers';
import { RoutingPage } from '@/pages/routing';
import { SpendingPage } from '@/pages/spending';

type Nav = { id: string; label: string; icon: typeof Activity; hosted?: true };
const NAV: Nav[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'providers', label: 'Providers', icon: Server },
  { id: 'routing', label: 'Routing', icon: Route },
  { id: 'keys', label: 'Access keys', icon: KeyRound, hosted: true },
  { id: 'spending', label: 'Spending', icon: Wallet, hosted: true },
  { id: 'offered', label: 'Offered models', icon: Layers, hosted: true },
  { id: 'playground', label: 'Playground', icon: FlaskConical },
  { id: 'activity', label: 'Activity', icon: Activity },
];

function useTheme(): [boolean, () => void] {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const stored = (() => { try { return window.localStorage.getItem('leyline.theme'); } catch { return null; } })();
  const [dark, setDark] = useState(stored ? stored === 'dark' : media.matches);
  useEffect(() => { document.documentElement.classList.toggle('dark', dark); }, [dark]);
  return [dark, () => setDark(v => {
    try { window.localStorage.setItem('leyline.theme', v ? 'light' : 'dark'); } catch { /* per-browser preference only */ }
    return !v;
  })];
}

export function App() {
  const d = useDashboard();
  const [page, go] = useHashRoute('overview');
  const [dark, toggleTheme] = useTheme();
  const hosted = Boolean(d.session?.hosted);
  const nav = NAV.filter(n => !n.hosted || hosted);
  const current = nav.find(n => n.id === page)?.id ?? 'overview';

  async function signOut() {
    await fetch(apiUrl('/auth/logout'), { method: 'POST', credentials: 'same-origin' });
    window.location.href = '/auth/login?next=/dashboard/';
  }

  return (
    <div className="min-h-svh md:grid md:grid-cols-[15rem_1fr]">
      <aside className="border-b bg-sidebar md:sticky md:top-0 md:flex md:h-svh md:flex-col md:border-r md:border-b-0">
        <div className="flex items-center gap-2 px-4 py-3 md:py-5">
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" className="size-7 rounded-md" />
          <div className="leading-tight">
            <div className="font-semibold">Leyline</div>
            <div className="text-xs text-muted-foreground">{hosted ? 'Cloud' : 'Local router'}</div>
          </div>
          <div className="ml-auto flex md:hidden">
            <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="Toggle theme">{dark ? <Sun /> : <Moon />}</Button>
            {hosted && d.session?.signIn && d.session.email !== 'token' ? <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out"><LogOut /></Button> : null}
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible md:pb-0">
          {nav.map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => go(item.id)}
              className={cn(
                'flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent',
                current === item.id ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground',
              )}
            >
              <item.icon className="size-4" />{item.label}
            </button>
          ))}
        </nav>
        <div className="mt-auto hidden p-3 md:block">
          <Separator className="mb-3" />
          {hosted ? (
            <div className="mb-2 truncate px-1 text-xs text-muted-foreground" title={d.session?.email ?? ''}>{d.session?.email === 'token' ? 'Admin token' : d.session?.email}</div>
          ) : null}
          <div className="flex gap-1">
            <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="Toggle theme">{dark ? <Sun /> : <Moon />}</Button>
            <Button variant="ghost" size="icon" onClick={() => void d.refreshAll()} aria-label="Refresh"><RefreshCw /></Button>
            {hosted && d.session?.signIn && d.session.email !== 'token' ? <Button variant="ghost" size="sm" className="ml-auto" onClick={signOut}><LogOut />Sign out</Button> : null}
          </div>
        </div>
      </aside>

      <main className="min-w-0 px-4 py-6 md:px-8 md:py-8">
        <div className="mx-auto max-w-6xl">
          {d.waiting ? <div className="mb-4"><ToneBadge tone="warning">Waiting for the Leyline API…</ToneBadge></div> : null}
          {!d.status ? (
            <div className="grid gap-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-28" /><Skeleton className="h-64" /></div>
          ) : current === 'overview' ? <OverviewPage d={d} go={go} />
            : current === 'providers' ? <ProvidersPage d={d} />
              : current === 'routing' ? <RoutingPage d={d} />
                : current === 'keys' ? <KeysPage d={d} />
                  : current === 'spending' ? <SpendingPage />
                  : current === 'offered' ? <OfferedPage d={d} />
                    : current === 'playground' ? <PlaygroundPage d={d} />
                      : <ActivityPage d={d} />}
        </div>
      </main>
    </div>
  );
}
