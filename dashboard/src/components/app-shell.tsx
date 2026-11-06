import type { ReactNode } from 'react';
import { LogOut, Moon, RefreshCw, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SideNav, type NavEntry } from '@/components/side-nav';
import { cn } from '@/lib/utils';

/**
 * The frame both Valefront apps use: adm (platform admin) and dash (customers). Styling only: each app brings its own
 * navigation, pages and logic (Steve, 2026-11-06: "separated applications"; the component library is shared, logic
 * is not). Desktop: a sidebar with the product, the pages and the account; phones: a header and one row of page tabs.
 */
export function AppShell({
  area, email, nav, current, go, dark, toggleTheme, onSignOut, onRefresh, wide, banner, children,
}: {
  /** Which app: "Admin" (adm) or "Dashboard" (dash). Shown under the product name. */
  area: string;
  email?: string | null;
  /** null: no navigation yet (sign-up takes the whole screen). */
  nav: NavEntry[] | null;
  current: string;
  go: (id: string) => void;
  dark: boolean;
  toggleTheme: () => void;
  onSignOut?: () => void;
  onRefresh?: () => void;
  /** Wider content column (tables, billing). */
  wide?: boolean;
  banner?: ReactNode;
  children: ReactNode;
}) {
  const brand = (
    <div className="flex min-w-0 items-center gap-2.5">
      <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" className="size-8 shrink-0" />
      <div className="min-w-0 leading-tight">
        <div className="font-semibold tracking-tight">Valefront</div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="rounded-full bg-primary/15 px-1.5 py-px text-[10px] font-semibold tracking-wide text-primary uppercase">{area}</span>
        </div>
      </div>
    </div>
  );
  const themeButton = <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="Toggle theme">{dark ? <Sun /> : <Moon />}</Button>;
  return (
    <div className="min-h-svh bg-background md:grid md:grid-cols-[16rem_1fr]">
      <aside className="sticky top-0 z-20 border-b bg-sidebar/95 backdrop-blur md:flex md:h-svh md:flex-col md:border-r md:border-b-0">
        <div className="flex items-center gap-2 px-4 py-3 md:px-5 md:py-6">
          {brand}
          <div className="ml-auto flex md:hidden">
            {themeButton}
            {onSignOut ? <Button variant="ghost" size="icon" onClick={onSignOut} aria-label="Sign out"><LogOut /></Button> : null}
          </div>
        </div>
        {nav ? <SideNav entries={nav} current={current} go={go} /> : null}
        <div className="mt-auto hidden border-t p-3 md:block">
          {email ? <div className="mb-2 truncate px-1 text-xs text-muted-foreground" title={email}>{email}</div> : null}
          <div className="flex items-center gap-1">
            {themeButton}
            {onRefresh ? <Button variant="ghost" size="icon" onClick={onRefresh} aria-label="Refresh"><RefreshCw /></Button> : null}
            {onSignOut ? <Button variant="ghost" size="sm" className="ml-auto" onClick={onSignOut}><LogOut />Sign out</Button> : null}
          </div>
        </div>
      </aside>
      <main className="min-w-0 px-4 py-6 md:px-10 md:py-10">
        <div className={cn('mx-auto', wide ? 'max-w-6xl' : 'max-w-5xl')}>
          {banner}
          {children}
        </div>
      </main>
    </div>
  );
}
