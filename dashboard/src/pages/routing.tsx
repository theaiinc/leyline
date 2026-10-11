import { useEffect, useState, type FormEvent } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageHeader, ProviderDot, ToneBadge } from '@/components/common';
import type { Dashboard } from '@/hooks/use-dashboard';
import { cn } from '@/lib/utils';
import { providerTone, type ProviderStats, type RoutingStatus } from '@/normalization';

const INFER = '__infer__';
const UNPINNED = '__unpinned__';

const poolSize = (routing?: RoutingStatus) => (routing ? Object.values(routing.enabledModels).reduce((n, m) => n + m.length, 0) : 0);

export function RoutingPage({ d }: { d: Dashboard }) {
  const routing = d.status?.routing;
  const providers = d.stats.providers;
  const pinned = Boolean(routing?.singleModelEnabled);
  const pool = poolSize(routing);
  const [pinProvider, setPinProvider] = useState('');
  const [pinModel, setPinModel] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    setPinProvider(routing?.fixedProvider || '');
    setPinModel(routing?.fixedModel || '');
  }, [routing?.fixedProvider, routing?.fixedModel]);

  async function pin(event: FormEvent) {
    event.preventDefault();
    if (!pinModel.trim()) return;
    await d.updateRouting({ mode: 'pinned', pinnedProvider: pinProvider, pinnedModel: pinModel.trim() }, `Pinned to ${pinProvider ? `${pinProvider} / ` : ''}${pinModel.trim()}.`);
  }

  function toggle(provider: string, model: string, on: boolean) {
    const next = Object.fromEntries(Object.entries(routing?.enabledModels ?? {}).map(([p, m]) => [p, [...m]]));
    const cur = next[provider] ?? [];
    next[provider] = on ? [...new Set([...cur, model])] : cur.filter(id => id !== model);
    if (next[provider].length === 0) delete next[provider];
    void d.updateRouting({ enabledModels: next });
  }

  function pinInstance(model: string, provider: string) {
    const pins = { ...(routing?.modelPins ?? {}) };
    if (provider) pins[model] = provider;
    else delete pins[model];
    void d.updateRouting({ modelPins: pins });
  }

  const pinnedModels = providers.find(p => p.name === pinProvider)?.models ?? [];

  return (
    <>
      <PageHeader
        title="Routing"
        description={<>How requests are routed. Clients can also name a model per call (<code className="font-mono text-xs">"model": "gpt-5.5"</code>); <code className="font-mono text-xs">"auto"</code> lets the router pick from the pool.</>}
        actions={<ToneBadge tone={pinned ? 'warning' : 'success'}>{pinned ? `Pinned: ${routing?.fixedModel || 'unset'}` : pool ? `Auto: ${pool} model${pool === 1 ? '' : 's'}` : 'Auto: all models'}</ToneBadge>}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className={cn(!pinned && 'border-primary')}>
          <CardHeader>
            <CardTitle>Auto routing</CardTitle>
            <CardDescription>{pool ? `Routes across the ${pool} selected model${pool === 1 ? '' : 's'}.` : 'Routes across every available model. Switch models on below to narrow the pool.'}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {pinned ? <Button onClick={() => void d.updateRouting({ mode: 'auto' }, 'Auto routing on.')}>Use auto routing</Button> : <ToneBadge tone="success">Active</ToneBadge>}
            {!pinned && pool ? <Button variant="outline" onClick={() => void d.updateRouting({ enabledModels: {} }, 'Selection cleared: routing across all models.')}>Clear selection</Button> : null}
          </CardContent>
        </Card>

        <Card className={cn(pinned && 'border-primary')}>
          <CardHeader>
            <CardTitle>Pinned model</CardTitle>
            <CardDescription>Send every request to one provider and model, whatever model the request names.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={pin} className="flex flex-wrap gap-2">
              <Select value={pinProvider || INFER} onValueChange={v => setPinProvider(v === INFER ? '' : v)}>
                <SelectTrigger className="w-44" aria-label="Pinned provider"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={INFER}>Infer provider</SelectItem>
                  {providers.map(p => <SelectItem key={p.name} value={p.name}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input className="min-w-40 flex-1" value={pinModel} onChange={e => setPinModel(e.target.value)} placeholder="Model id" list="pin-models" aria-label="Pinned model" />
              <datalist id="pin-models">{pinnedModels.map(m => <option key={m.id} value={m.id} />)}</datalist>
              <Button type="submit" variant="secondary" disabled={!pinModel.trim()}>{pinned ? 'Update pin' : 'Pin'}</Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Providers and models</CardTitle>
          <CardDescription>Switch a model on to put it in the auto-routing pool. A model several providers serve can be pinned to one of them.</CardDescription>
          <CardAction>
            <div className="relative">
              <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
              <Input className="w-56 pl-8" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search models…" aria-label="Search models" />
            </div>
          </CardAction>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Models</TableHead>
                <TableHead className="text-right">Minute</TableHead>
                <TableHead className="text-right">Day</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.map(p => <ProviderRow key={p.name} p={p} routing={routing} search={search} onToggle={toggle} onPin={pinInstance} />)}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

function ProviderRow({ p, routing, search, onToggle, onPin }: { p: ProviderStats; routing?: RoutingStatus; search: string; onToggle: (p: string, m: string, on: boolean) => void; onPin: (m: string, p: string) => void }) {
  const [open, setOpen] = useState(false);
  const q = search.toLowerCase();
  const models = p.models.filter(m => !q || [m.id, m.name, m.description].some(v => v?.toLowerCase().includes(q)));
  const enabled = routing?.enabledModels[p.name] ?? [];
  const index = routing?.modelIndex ?? {};
  const limited = Boolean(p.quota && (p.usage.minute >= p.quota.requestsPerMinute || p.usage.day >= p.quota.requestsPerDay));
  const missingKey = Boolean(p.apiKeyConfigurable && !p.apiKeyConfigured);
  const missingRuntime = Boolean(p.runtimeReady === false && p.apiKeyConfigured);
  if (q && models.length === 0) return null;

  return (
    <TableRow className="align-top">
      <TableCell className="py-3">
        <div className="flex items-center gap-2 font-medium"><ProviderDot tone={providerTone(p.name, p.family)} />{p.name}</div>
        <code className="font-mono text-xs text-muted-foreground">{p.defaultModel}</code>
      </TableCell>
      <TableCell className="w-full py-3">
        <Collapsible open={open || Boolean(q)} onOpenChange={setOpen}>
          <CollapsibleTrigger className="flex items-center gap-1 text-sm hover:underline">
            <ChevronRight className={cn('size-4 transition-transform', (open || q) && 'rotate-90')} />
            {models.length} / {p.models.length} models{enabled.length ? ` · ${enabled.length} in pool` : ''}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 grid gap-1">
            {models.length ? models.map(m => {
              const offeredBy = index[m.id] ?? [];
              return (
                <div key={m.id} className="flex flex-wrap items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50">
                  <Switch checked={enabled.includes(m.id)} onCheckedChange={on => onToggle(p.name, m.id, on)} aria-label={`Route ${m.id}`} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{m.name || m.id}</div>
                    <div className="truncate font-mono text-xs text-muted-foreground">{m.id}{m.description ? ` · ${m.description}` : ''}</div>
                  </div>
                  {offeredBy.length > 1 ? (
                    <Select value={routing?.modelPins?.[m.id] || UNPINNED} onValueChange={v => onPin(m.id, v === UNPINNED ? '' : v)}>
                      <SelectTrigger size="sm" className="w-44" aria-label={`Preferred instance for ${m.id}`}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={UNPINNED}>Priority order</SelectItem>
                        {offeredBy.map(name => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : null}
                </div>
              );
            }) : <span className="text-sm text-muted-foreground">No matching models</span>}
          </CollapsibleContent>
        </Collapsible>
      </TableCell>
      <TableCell className="py-3 text-right tabular-nums">{p.usage.minute} / {p.quota?.requestsPerMinute ?? '∞'}</TableCell>
      <TableCell className="py-3 text-right tabular-nums">{p.usage.day} / {p.quota?.requestsPerDay ?? '∞'}</TableCell>
      <TableCell className="py-3">
        {limited ? <ToneBadge tone="warning">Rate limited</ToneBadge> : missingRuntime ? <ToneBadge tone="warning">Needs base URL</ToneBadge> : missingKey ? <ToneBadge tone="danger">Missing key</ToneBadge> : <ToneBadge tone="success">Available</ToneBadge>}
      </TableCell>
    </TableRow>
  );
}
