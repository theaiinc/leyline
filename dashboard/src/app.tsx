import { useEffect, useState } from 'react';
import { Activity, Calculator, FlaskConical, KeyRound, LayoutDashboard, Layers, LogOut, Moon, RefreshCw, Route, Server, Sun, Wallet } from 'lucide-react';
import { SideNav, navIds, type NavEntry } from '@/components/side-nav';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/common';
import { apiUrl, fetchSession, type Session } from '@/api';
import { CustomerApp } from '@/customer/customer-app';
import { useDashboard } from '@/hooks/use-dashboard';
import { useHashRoute } from '@/hooks/use-hash-route';
import { cn } from '@/lib/utils';
import { ActivityPage } from '@/pages/activity';
import { CalculatorPage } from '@/pages/calculator';
import { BenchmarksPage } from '@/pages/benchmarks';
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
  { id: 'benchmarks', label: 'Benchmarks', icon: FlaskConical },
  { id: 'providers', label: 'Providers', icon: Server },
  { id: 'routing', label: 'Routing', icon: Route },
  { id: 'keys', label: 'Access keys', icon: KeyRound, hosted: true },
  { id: 'offered', label: 'Offered models', icon: Layers, hosted: true },
  { id: 'playground', label: 'Playground', icon: FlaskConical },
  { id: 'activity', label: 'Activity', icon: Activity },
];
/** Money in one place: spending (hosted) and the cost calculator. Customer billing is administered on
 * adm.valefront.com (platform admins only, behind Cloudflare Access), never on this dashboard. */
const BILLING: Nav[] = [
  { id: 'spending', label: 'Spending', icon: Wallet, hosted: true },
  { id: 'calculator', label: 'Cost calculator', icon: Calculator },
];

function navFor(hosted: boolean): NavEntry[] {
  const shown = (n: Nav) => !n.hosted || hosted;
  const top = NAV.filter(shown);
  // The Billing group sits after Offered models (before the playground), where Spending used to be.
  const at = top.findIndex((n) => n.id === 'playground');
  const group: NavEntry = { group: 'Billing', icon: Wallet, items: BILLING.filter(shown) };
  return [...top.slice(0, at), group, ...top.slice(at)];
}

export function useTheme(): [boolean, () => void] {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const stored = (() => { try { return window.localStorage.getItem('valefront.theme'); } catch { return null; } })();
  const [dark, setDark] = useState(stored ? stored === 'dark' : media.matches);
  useEffect(() => { document.documentElement.classList.toggle('dark', dark); }, [dark]);
  return [dark, () => setDark(v => {
    try { window.localStorage.setItem('valefront.theme', v ? 'light' : 'dark'); } catch { /* per-browser preference only */ }
    return !v;
  })];
}

/** Hosted: a customer (not an admin) gets their own workspace's dashboard; the owner gets the full one. */
export function Root() {
  const [session, setSession] = useState<Session | null>(null);
  const [dark, toggleTheme] = useTheme();
  useEffect(() => { void fetchSession().then(setSession); }, []);
  if (!session) return null;
  if (session.hosted && !session.admin) return <CustomerApp dark={dark} toggleTheme={toggleTheme} />;
  return <App />;
}

export function App() {
  const d = useDashboard();
  const [page, go] = useHashRoute('overview');
  const [dark, toggleTheme] = useTheme();
  const hosted = Boolean(d.session?.hosted);
  const nav = navFor(hosted);
  const current = navIds(nav).includes(page) ? page : 'overview';

  async function signOut() {
    await fetch(apiUrl('/auth/logout'), { method: 'POST', credentials: 'same-origin' });
    window.location.href = '/auth/login?next=/';
  }

  return (
    <div className="min-h-svh md:grid md:grid-cols-[15rem_1fr]">
      <aside className="border-b bg-sidebar md:sticky md:top-0 md:flex md:h-svh md:flex-col md:border-r md:border-b-0">
        <div className="flex items-center gap-2 px-4 py-3 md:py-5">
          <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" className="size-8" />
          <div className="leading-tight">
            <div className="font-semibold">Valefront</div>
            <div className="text-xs text-muted-foreground">{hosted ? 'Admin' : 'Local router'}</div>
          </div>
          <div className="ml-auto flex md:hidden">
            <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="Toggle theme">{dark ? <Sun /> : <Moon />}</Button>
            {hosted && d.session?.signIn && d.session.email !== 'token' ? <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out"><LogOut /></Button> : null}
          </div>
        </div>
        <SideNav entries={nav} current={current} go={go} />
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
          {d.waiting ? <div className="mb-4"><ToneBadge tone="warning">Waiting for the Valefront API…</ToneBadge></div> : null}
          {current === 'benchmarks' ? <BenchmarksPage base={d.session?.hosted ? (d.session.publicUrl || window.location.origin) : d.stats.tunnel?.publicBaseUrl?.replace(/\/v1$/, '') || apiUrl('')} /> : null}
          {!d.status ? (
            <div className="grid gap-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-28" /><Skeleton className="h-64" /></div>
          ) : current === 'overview' ? <OverviewPage d={d} go={go} />
            : current === 'providers' ? <ProvidersPage d={d} />
              : current === 'routing' ? <RoutingPage d={d} />
                : current === 'keys' ? <KeysPage d={d} />
                  : current === 'spending' ? <SpendingPage />
                  : current === 'offered' ? <OfferedPage d={d} />
                    : current === 'playground' ? <PlaygroundPage d={d} />
                      : current === 'calculator' ? <CalculatorPage />
                      : <ActivityPage d={d} />}
        </div>
      </main>
    </div>
  );
}
