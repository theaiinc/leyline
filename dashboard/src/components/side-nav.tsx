import { useEffect, useState, type ComponentType } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export type NavItem = { id: string; label: string; icon: ComponentType<{ className?: string }> };
export type NavEntry = NavItem | { group: string; icon: ComponentType<{ className?: string }>; items: NavItem[] };

const isGroup = (e: NavEntry): e is Extract<NavEntry, { group: string }> => 'group' in e;

/** Every page id in the nav, groups flattened (for finding the current page). */
export function navIds(entries: NavEntry[]): string[] {
  return entries.flatMap((e) => (isGroup(e) ? e.items.map((i) => i.id) : [e.id]));
}

/**
 * The side navigation: pages, and groups of pages under a heading that opens and closes (open by itself while one
 * of its pages is the current one). On a phone it's the same list, scrolling sideways, with the group's pages
 * following its heading.
 */
export function SideNav({ entries, current, go }: { entries: NavEntry[]; current: string; go: (id: string) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    for (const e of entries) if (isGroup(e) && e.items.some((i) => i.id === current)) setOpen((o) => ({ ...o, [e.group]: true }));
  }, [current, entries]);
  const button = (item: NavItem, nested = false) => (
    <button key={item.id} type="button" onClick={() => go(item.id)} aria-current={current === item.id ? 'page' : undefined}
      className={cn('flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent', nested && 'md:pl-8',
        current === item.id ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground')}>
      <item.icon className="size-4" />{item.label}
    </button>
  );
  return (
    <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible md:pb-0">
      {entries.map((e) => {
        if (!isGroup(e)) return button(e);
        const expanded = open[e.group] ?? false;
        const active = e.items.some((i) => i.id === current);
        return (
          <div key={e.group} role="group" aria-label={e.group} className="flex shrink-0 gap-1 md:flex-col">
            <button type="button" aria-expanded={expanded} onClick={() => setOpen((o) => ({ ...o, [e.group]: !expanded }))}
              className={cn('flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent', active && !expanded ? 'bg-accent font-medium text-accent-foreground' : active ? 'font-medium text-foreground' : 'text-muted-foreground')}>
              <e.icon className="size-4" />{e.group}<ChevronDown className={cn('ml-auto size-4 transition-transform', expanded ? 'rotate-180' : '-rotate-90 md:rotate-0')} />
            </button>
            {expanded ? e.items.map((i) => button(i, true)) : null}
          </div>
        );
      })}
    </nav>
  );
}
