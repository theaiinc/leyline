import { useEffect, useState } from 'react';
import { Activity, BadgePercent, Calculator, CreditCard, FlaskConical, Handshake, KeyRound, LayoutDashboard, Layers, LogOut, Moon, RefreshCw, Route, Server, Sun, Wallet } from 'lucide-react';
import { navIds, type NavEntry } from '@/components/side-nav';
import { AppShell } from '@/components/app-shell';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { ToneBadge } from '@/components/common';
import { apiUrl, fetchSession, type Session } from '@/api';
import { CustomerApp } from '@/customer/customer-app';
import { useDashboard } from '@/hooks/use-dashboard';
import { usePathRoute } from '@/hooks/use-path-route';
import { cn } from '@/lib/utils';
import { ActivityPage } from '@/pages/activity';
import { CalculatorPage } from '@/pages/calculator';
import { CampaignsPage } from '@/pages/campaigns';
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
/** Money in one place: spending (hosted), customer billing (hosted: its own pages under /billing on the platform
 * admin host) and the cost calculator. */
const CUSTOMER_BILLING = 'customer-billing';
/** Partner inquiries (the valefront.com form) are server pages under /partners on the admin host too. */
const PARTNER_INQUIRIES = 'partner-inquiries';
const SERVER_PAGES: Record<string, string> = { [CUSTOMER_BILLING]: '/billing/', [PARTNER_INQUIRIES]: '/partners/' };
const BILLING: Nav[] = [
  { id: 'spending', label: 'Spending', icon: Wallet, hosted: true },
  { id: CUSTOMER_BILLING, label: 'Customer billing', icon: CreditCard, hosted: true },
  // Promotions (adm only): automatic and promo-code campaigns.
  { id: 'campaigns', label: 'Campaigns', icon: BadgePercent, hosted: true },
  { id: PARTNER_INQUIRIES, label: 'Partner inquiries', icon: Handshake, hosted: true },
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
  // Hosted, the owner's dashboard is adm.valefront.com, whose pages are paths (/benchmarks); locally they stay #/x.
  return <App paths={Boolean(session.hosted)} />;
}

export function App({ paths = false }: { paths?: boolean } = {}) {
  const d = useDashboard();
  const [page, go] = usePathRoute('overview', { paths });
  const [dark, toggleTheme] = useTheme();
  const hosted = Boolean(d.session?.hosted);
  const nav = navFor(hosted);
  const current = navIds(nav).includes(page) ? page : 'overview';

  // Customer billing and partner inquiries are server pages on the admin host, not pages of this app.
  const goTo = (id: string) => { if (SERVER_PAGES[id]) window.location.href = SERVER_PAGES[id]; else go(id); };

  async function signOut() {
    // Hosted, this dashboard is only on the platform admin host, signed in through Cloudflare Access.
    if (hosted) { window.location.href = '/cdn-cgi/access/logout'; return; }
    const res = await fetch(apiUrl('/auth/logout'), { method: 'POST', credentials: 'same-origin' });
    // Aegis's sign-out page ends the Aegis session too; without it the next sign-in skipped the login.
    const next = res.ok ? ((await res.json().catch(() => null)) as { next?: string } | null)?.next : undefined;
    window.location.href = next || '/auth/login?next=/';
  }

  const canSignOut = hosted && d.session?.signIn && d.session.email !== 'token';
  return (
    <AppShell area={hosted ? 'Admin' : 'Local'} email={hosted ? (d.session?.email === 'token' ? 'Admin token' : d.session?.email) : null}
      nav={nav} current={current} go={goTo} dark={dark} toggleTheme={toggleTheme} wide
      onSignOut={canSignOut ? signOut : undefined} onRefresh={() => void d.refreshAll()}
      banner={d.waiting ? <div className="mb-4"><ToneBadge tone="warning">Waiting for the Valefront API…</ToneBadge></div> : null}>
      {current === 'benchmarks' ? <BenchmarksPage base={d.session?.hosted ? (d.session.publicUrl || window.location.origin) : d.stats.tunnel?.publicBaseUrl?.replace(/\/v1$/, '') || apiUrl('')} /> : null}
      {!d.status ? (
        <div className="grid gap-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-28" /><Skeleton className="h-64" /></div>
      ) : current === 'overview' ? <OverviewPage d={d} go={go} />
        : current === 'providers' ? <ProvidersPage d={d} />
          : current === 'routing' ? <RoutingPage d={d} />
            : current === 'keys' ? <KeysPage d={d} />
              : current === 'spending' ? <SpendingPage />
                : current === 'campaigns' ? <CampaignsPage />
                : current === 'offered' ? <OfferedPage d={d} />
                  : current === 'playground' ? <PlaygroundPage d={d} />
                    : current === 'calculator' ? <CalculatorPage />
                      : current === 'benchmarks' ? null
                        : <ActivityPage d={d} />}
    </AppShell>
  );
}
