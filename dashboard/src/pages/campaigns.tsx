import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, PageHeader, ToneBadge } from '@/components/common';
import { apiUrl } from '@/api';
import { priceUsd } from '@/lib/promotions';

/**
 * adm only: promotions (src/core/campaigns.ts, API in src/core/admin-campaigns.ts). A campaign sells some models
 * below their official price for a time, to everyone (automatic) or to workspaces that enter its code on dash
 * Billing. A promo price below what Valefront pays the provider is shown as a warning, and saving it needs a
 * confirmation.
 */

type Official =
  | { kind: 'chat'; input: number; output: number; cachedInput?: number }
  | { kind: 'image'; perImage: number; perImageAbove?: { pixels: number; perImage: number } }
  | { kind: 'video'; perMTokens: number; perMTokens1080p?: number };
type CatalogEntry = { id: string; name: string; provider: string; price: Official; cost: Official };
type PromoPrice = { input?: number; output?: number; perImage?: number; perMVideoTokens?: number };
type Discount = { kind: 'percent'; percentBp: number } | { kind: 'price'; prices: Record<string, PromoPrice> };
type Campaign = {
  id: string; name: string; type: 'automatic' | 'code'; code: string | null; status: 'active' | 'paused'; startsAt: number; endsAt: number;
  models: string[]; discount: Discount; maxRedemptions: number | null; oncePerWorkspace: boolean; redemptions?: number;
  createdBy: string; updatedAt: number; updatedBy: string;
  prices: Array<{ id: string; name: string; official: Official | null; promo: Official | null }>;
};
type Warning = { model: string; field: string; promo: number; cost: number };

/** Like api(), but a refusal keeps its body (the below-cost warnings). */
async function call<T>(path: string, method = 'GET', body?: unknown): Promise<{ ok: boolean; status: number; data: T & { error?: string; code?: string; warnings?: Warning[] } }> {
  const res = await fetch(apiUrl(path), { method, credentials: 'same-origin', headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

const utc = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
/** <input type="datetime-local"> value for a UTC time (the form is in UTC). */
const localValue = (t: number) => new Date(t).toISOString().slice(0, 16);

function priceText(p: Official | null): string {
  if (!p) return '—';
  if (p.kind === 'chat') return `${priceUsd(p.input)} in / ${priceUsd(p.output)} out per 1M`;
  if (p.kind === 'image') return `${priceUsd(p.perImage)} / image${p.perImageAbove ? ` (${priceUsd(p.perImageAbove.perImage)} large)` : ''}`;
  return `${priceUsd(p.perMTokens)} / 1M video tokens${p.perMTokens1080p !== undefined ? ` (${priceUsd(p.perMTokens1080p)} 1080p)` : ''}`;
}

const kindLabel: Record<Official['kind'], string> = { chat: 'Chat', image: 'Images', video: 'Videos' };

type Form = {
  id: string | null; name: string; type: 'automatic' | 'code'; code: string; maxRedemptions: string; oncePerWorkspace: boolean; active: boolean;
  startsAt: string; endsAt: string; kind: 'percent' | 'price'; percent: string; models: string[]; prices: Record<string, Record<string, string>>;
};

function emptyForm(now: number): Form {
  const start = Math.ceil(now / 3_600_000) * 3_600_000;
  return { id: null, name: '', type: 'automatic', code: '', maxRedemptions: '', oncePerWorkspace: true, active: true, startsAt: localValue(start), endsAt: localValue(start + 7 * 86_400_000), kind: 'percent', percent: '20', models: [], prices: {} };
}

function formOf(c: Campaign): Form {
  const prices: Form['prices'] = {};
  if (c.discount.kind === 'price') for (const [m, p] of Object.entries(c.discount.prices)) prices[m] = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]));
  return {
    id: c.id, name: c.name, type: c.type, code: c.code ?? '', maxRedemptions: c.maxRedemptions === null ? '' : String(c.maxRedemptions), oncePerWorkspace: c.oncePerWorkspace,
    active: c.status === 'active', startsAt: localValue(c.startsAt), endsAt: localValue(c.endsAt), kind: c.discount.kind,
    percent: c.discount.kind === 'percent' ? String(c.discount.percentBp / 100) : '20', models: c.models, prices,
  };
}

function bodyOf(f: Form) {
  const prices: Record<string, Record<string, string>> = {};
  for (const m of f.models) prices[m] = f.prices[m] ?? {};
  return {
    name: f.name, type: f.type, status: f.active ? 'active' : 'paused', startsAt: f.startsAt, endsAt: f.endsAt,
    ...(f.type === 'code' ? { code: f.code, maxRedemptions: f.maxRedemptions || null, oncePerWorkspace: f.oncePerWorkspace } : {}),
    models: f.models,
    discount: f.kind === 'percent' ? { kind: 'percent', percent: Number(f.percent) } : { kind: 'price', prices },
  };
}

export function CampaignsPage() {
  const [data, setData] = useState<{ campaigns: Campaign[]; catalog: CatalogEntry[]; now: number } | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState<Form | null>(null);
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [checkError, setCheckError] = useState('');
  const [confirm, setConfirm] = useState<Warning[] | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const r = await call<{ campaigns: Campaign[]; catalog: CatalogEntry[]; now: number }>('/admin/api/campaigns');
    if (!r.ok) { setError(r.data.error ?? `Could not load campaigns (${r.status})`); return; }
    setError('');
    setData(r.data);
  }, []);
  useEffect(() => { void load(); }, [load]);

  // The below-cost check, as the form changes (the server works it out from the same prices it charges).
  useEffect(() => {
    if (!form || !form.models.length) { setWarnings([]); setCheckError(''); return; }
    const t = setTimeout(() => {
      void call<{ warnings: Warning[] }>('/admin/api/campaigns/check', 'POST', bodyOf(form)).then((r) => {
        if (r.ok) { setWarnings(r.data.warnings ?? []); setCheckError(''); } else { setWarnings([]); setCheckError(r.data.error ?? ''); }
      });
    }, 300);
    return () => clearTimeout(t);
  }, [form]);

  const catalog = data?.catalog ?? [];
  const byKind = useMemo(() => (['chat', 'image', 'video'] as const).map((k) => [k, catalog.filter((e) => e.price.kind === k)] as const).filter(([, list]) => list.length), [catalog]);

  async function save(acknowledgeBelowCost = false) {
    if (!form) return;
    setSaving(true);
    try {
      const r = await call<{ campaign: Campaign }>(form.id ? `/admin/api/campaigns/${form.id}` : '/admin/api/campaigns', form.id ? 'PUT' : 'POST', { ...bodyOf(form), acknowledgeBelowCost });
      if (r.status === 409 && r.data.code === 'below_cost') { setConfirm(r.data.warnings ?? []); return; }
      if (!r.ok) { toast.error(r.data.error ?? `Not saved (${r.status})`); return; }
      toast.success(form.id ? 'Campaign saved.' : 'Campaign created.');
      setConfirm(null);
      setForm(null);
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(c: Campaign, status: 'active' | 'paused') {
    const r = await call(`/admin/api/campaigns/${c.id}/status`, 'POST', { status });
    if (!r.ok) toast.error(r.data.error ?? 'Not changed');
    await load();
  }

  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const toggleModel = (id: string, on: boolean) => setForm((f) => (f ? { ...f, models: on ? [...f.models, id] : f.models.filter((m) => m !== id) } : f));
  const setPrice = (id: string, field: string, value: string) => setForm((f) => (f ? { ...f, prices: { ...f.prices, [id]: { ...f.prices[id], [field]: value } } } : f));
  const now = data?.now ?? Date.now();
  const state = (c: Campaign) => (c.status === 'paused' ? <ToneBadge tone="neutral">Paused</ToneBadge>
    : now < c.startsAt ? <ToneBadge tone="warning">Scheduled</ToneBadge>
      : now >= c.endsAt ? <ToneBadge tone="neutral">Ended</ToneBadge>
        : <ToneBadge tone="success">Live</ToneBadge>);

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Promotion prices: automatic for everyone, or with a promo code customers enter on Billing. Customers pay the promo price inside the window; the discount shows as its own line on Spending."
        actions={!form ? <Button onClick={() => { setForm(emptyForm(now)); setWarnings([]); }}>New campaign</Button> : null}
      />
      {error ? <Alert variant="destructive" className="mb-4"><AlertTitle>Campaigns unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}

      {form ? (
        <Card className="mb-6">
          <CardHeader><CardTitle>{form.id ? 'Edit campaign' : 'New campaign'}</CardTitle><CardDescription>Times are UTC. A promo price is never charged above the official one.</CardDescription></CardHeader>
          <CardContent className="grid gap-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="grid gap-1.5"><Label htmlFor="c-name">Name</Label><Input id="c-name" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Launch week" /></div>
              <div className="flex items-end gap-3"><Switch id="c-active" checked={form.active} onCheckedChange={(v) => set({ active: v })} /><Label htmlFor="c-active">{form.active ? 'Active' : 'Paused'}</Label></div>
              <div className="grid gap-1.5"><Label htmlFor="c-start">Start (UTC)</Label><Input id="c-start" type="datetime-local" value={form.startsAt} onChange={(e) => set({ startsAt: e.target.value })} /></div>
              <div className="grid gap-1.5"><Label htmlFor="c-end">End (UTC)</Label><Input id="c-end" type="datetime-local" value={form.endsAt} onChange={(e) => set({ endsAt: e.target.value })} /></div>
            </div>

            <div className="grid gap-2">
              <Label>Who gets it</Label>
              <RadioGroup value={form.type} onValueChange={(v) => set({ type: v as Form['type'] })} className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm"><RadioGroupItem value="automatic" />Automatic: everyone</label>
                <label className="flex items-center gap-2 text-sm"><RadioGroupItem value="code" />Promo code: workspaces that enter it</label>
              </RadioGroup>
              {form.type === 'code' ? (
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="grid gap-1.5"><Label htmlFor="c-code">Code</Label><Input id="c-code" value={form.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })} placeholder="LAUNCH25" /></div>
                  <div className="grid gap-1.5"><Label htmlFor="c-max">Max redemptions</Label><Input id="c-max" type="number" min="1" value={form.maxRedemptions} onChange={(e) => set({ maxRedemptions: e.target.value })} placeholder="No limit" /></div>
                  <div className="flex items-end gap-3"><Switch id="c-once" checked={form.oncePerWorkspace} onCheckedChange={(v) => set({ oncePerWorkspace: v })} /><Label htmlFor="c-once">Once per workspace</Label></div>
                </div>
              ) : null}
            </div>

            <div className="grid gap-2">
              <Label>Discount</Label>
              <RadioGroup value={form.kind} onValueChange={(v) => set({ kind: v as Form['kind'] })} className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm"><RadioGroupItem value="percent" />% off the official price</label>
                <label className="flex items-center gap-2 text-sm"><RadioGroupItem value="price" />Fixed promo price per model</label>
              </RadioGroup>
              {form.kind === 'percent' ? (
                <div className="flex items-center gap-2"><Input aria-label="Percent off" className="w-28" type="number" min="0.01" max="100" step="0.01" value={form.percent} onChange={(e) => set({ percent: e.target.value })} /><span className="text-sm whitespace-nowrap text-muted-foreground">% off</span></div>
              ) : null}
            </div>

            <div className="grid gap-3">
              <Label>Models</Label>
              {byKind.map(([kind, list]) => (
                <div key={kind} className="grid gap-1.5">
                  <div className="text-xs font-medium text-muted-foreground uppercase">{kindLabel[kind]}</div>
                  {list.map((e) => {
                    const on = form.models.includes(e.id);
                    const p = form.prices[e.id] ?? {};
                    return (
                      <div key={e.id} className="grid gap-2 rounded-md border p-2 text-sm md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                        <label className="flex min-w-0 items-center gap-2" title={e.id}>
                          <input type="checkbox" aria-label={e.name} checked={on} onChange={(ev) => toggleModel(e.id, ev.target.checked)} />
                          <span className="truncate font-medium">{e.name}</span>
                          <span className="hidden truncate text-xs text-muted-foreground sm:inline">official {priceText(e.price)}{JSON.stringify(e.cost) !== JSON.stringify(e.price) ? ` · cost ${priceText(e.cost)}` : ''}</span>
                        </label>
                        {on && form.kind === 'price' ? (
                          <div className="flex flex-wrap items-center gap-2">
                            {e.price.kind === 'chat' ? <>
                              <Input aria-label={`${e.id} promo input price`} className="h-8 w-28" type="number" min="0" step="any" placeholder={`in ${e.price.input}`} value={p.input ?? ''} onChange={(ev) => setPrice(e.id, 'input', ev.target.value)} />
                              <Input aria-label={`${e.id} promo output price`} className="h-8 w-28" type="number" min="0" step="any" placeholder={`out ${e.price.output}`} value={p.output ?? ''} onChange={(ev) => setPrice(e.id, 'output', ev.target.value)} />
                              <span className="text-xs text-muted-foreground">$ / 1M</span>
                            </> : e.price.kind === 'image' ? <>
                              <Input aria-label={`${e.id} promo price per image`} className="h-8 w-28" type="number" min="0" step="any" placeholder={String(e.price.perImage)} value={p.perImage ?? ''} onChange={(ev) => setPrice(e.id, 'perImage', ev.target.value)} />
                              <span className="text-xs text-muted-foreground">$ / image</span>
                            </> : <>
                              <Input aria-label={`${e.id} promo price per 1M video tokens`} className="h-8 w-28" type="number" min="0" step="any" placeholder={String(e.price.perMTokens)} value={p.perMVideoTokens ?? ''} onChange={(ev) => setPrice(e.id, 'perMVideoTokens', ev.target.value)} />
                              <span className="text-xs text-muted-foreground">$ / 1M video tokens</span>
                            </>}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            {warnings.length ? (
              <Alert variant="destructive">
                <AlertTitle>Below cost</AlertTitle>
                <AlertDescription>
                  <p>These promo prices are below what Valefront pays the provider:</p>
                  <ul className="mt-1 list-disc pl-5">{warnings.map((w) => <li key={`${w.model}-${w.field}`}>{w.model} {w.field}: {priceUsd(w.promo)} (cost {priceUsd(w.cost)})</li>)}</ul>
                </AlertDescription>
              </Alert>
            ) : null}
            {checkError ? <p className="text-sm text-muted-foreground">{checkError}</p> : null}
            <div className="flex gap-2">
              <Button onClick={() => void save(false)} disabled={saving}>{form.id ? 'Save' : 'Create campaign'}</Button>
              <Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>All campaigns</CardTitle><CardDescription>Ended and paused ones stay here for the record.</CardDescription></CardHeader>
        <CardContent>
          {!data ? <p className="text-sm text-muted-foreground">Loading…</p> : data.campaigns.length === 0 ? <EmptyState title="No campaigns yet">Create one to sell some models at a promotion price for a while.</EmptyState> : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader><TableRow><TableHead>Campaign</TableHead><TableHead>Window (UTC)</TableHead><TableHead>Prices</TableHead><TableHead className="text-right">Redeemed</TableHead><TableHead /></TableRow></TableHeader>
                <TableBody>{data.campaigns.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="min-w-48 align-top whitespace-normal">
                      <div className="flex flex-wrap items-center gap-2 font-medium">{c.name}{state(c)}</div>
                      <div className="text-xs text-muted-foreground">{c.type === 'code' ? <>Code <code>{c.code}</code>{c.oncePerWorkspace ? ' · once per workspace' : ''}</> : 'Automatic'} · {c.discount.kind === 'percent' ? `${c.discount.percentBp / 100}% off` : 'fixed prices'}</div>
                    </TableCell>
                    <TableCell className="align-top text-xs whitespace-nowrap">{utc(c.startsAt)}<br />{utc(c.endsAt)}</TableCell>
                    <TableCell className="min-w-64 align-top text-xs whitespace-normal">{c.prices.map((p) => (
                      <div key={p.id} className="mb-1"><span className="font-medium">{p.name}</span>: <span className="text-muted-foreground line-through">{priceText(p.official)}</span> {priceText(p.promo)}</div>
                    ))}</TableCell>
                    <TableCell className="align-top text-right tabular-nums">{c.type === 'code' ? `${c.redemptions ?? 0}${c.maxRedemptions ? ` / ${c.maxRedemptions}` : ''}` : '—'}</TableCell>
                    <TableCell className="align-top text-right whitespace-nowrap">
                      <Button variant="outline" size="sm" onClick={() => { setForm(formOf(c)); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Edit</Button>{' '}
                      {c.status === 'active' ? <Button variant="ghost" size="sm" onClick={() => void setStatus(c, 'paused')}>Pause</Button> : <Button variant="ghost" size="sm" onClick={() => void setStatus(c, 'active')}>Resume</Button>}
                    </TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={Boolean(confirm)} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sell below cost?</DialogTitle>
            <DialogDescription>This campaign charges less than Valefront pays the provider for:</DialogDescription>
          </DialogHeader>
          <ul className="list-disc pl-5 text-sm">{(confirm ?? []).map((w) => <li key={`${w.model}-${w.field}`}>{w.model} {w.field}: {priceUsd(w.promo)} (cost {priceUsd(w.cost)})</li>)}</ul>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(null)}>Go back</Button>
            <Button variant="destructive" onClick={() => void save(true)} disabled={saving}>Save anyway</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
