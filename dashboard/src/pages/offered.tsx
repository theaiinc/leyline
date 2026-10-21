import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Ban, Plus, Search, Sparkles, X } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { money } from '@/pages/keys';
import { PageHeader, when } from '@/components/common';
import { api, type HostedSettings, type Price } from '@/api';
import type { Dashboard } from '@/hooks/use-dashboard';

type Row = { from: string; to: string };
type PriceRow = { model: string; input: string; output: string };

export function OfferedPage({ d }: { d: Dashboard }) {
  const [settings, setSettings] = useState<HostedSettings | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [draft, setDraft] = useState('');
  const [budget, setBudget] = useState('');
  const [providerBudgets, setProviderBudgets] = useState<Record<string, string>>({});
  const [priceRows, setPriceRows] = useState<PriceRow[]>([]);
  const [fallback, setFallback] = useState({ input: '', output: '' });
  const [blocked, setBlocked] = useState<string[]>([]);
  const [usePublished, setUsePublished] = useState(true);
  const [blockSearch, setBlockSearch] = useState('');
  const [saving, setSaving] = useState(false);

  const apply = (s: HostedSettings) => {
    setSettings(s);
    setModels(s.models);
    setRows(Object.entries(s.aliases).map(([from, to]) => ({ from, to })));
    setBudget(s.monthlyBudgetUsd ? String(s.monthlyBudgetUsd) : '');
    setProviderBudgets(Object.fromEntries(Object.entries(s.providerBudgetsUsd ?? {}).map(([name, usd]) => [name, String(usd)])));
    setPriceRows(Object.entries(s.prices).map(([model, p]) => ({ model, input: String(p.input), output: String(p.output) })));
    setFallback({ input: String(s.defaultPrice.input), output: String(s.defaultPrice.output) });
    setBlocked(s.blockedModels ?? []);
    setUsePublished(s.usePublishedPrices !== false);
  };
  useEffect(() => {
    api<HostedSettings>('/admin/api/settings').then(apply).catch(error => toast.error(error instanceof Error ? error.message : 'Could not load settings'));
  }, []);

  // Every model the providers report, to pick from.
  const known = useMemo(() => [...new Set(d.stats.providers.flatMap(p => p.models.map(m => m.id)))].sort(), [d.stats.providers]);
  const aliases = Object.fromEntries(rows.filter(r => r.from.trim() && r.to.trim()).map(r => [r.from.trim(), r.to.trim()]));
  const prices: Record<string, Price> = Object.fromEntries(priceRows
    .filter(r => r.model.trim() && r.input.trim() !== '' && r.output.trim() !== '')
    .map(r => [r.model.trim(), { input: Number(r.input), output: Number(r.output) }]));
  const defaultPrice: Price = { input: Number(fallback.input) || 0, output: Number(fallback.output) || 0 };
  const monthlyBudgetUsd = budget.trim() ? Number(budget) : null;
  const providerBudgetsUsd: Record<string, number> = Object.fromEntries(Object.entries(providerBudgets)
    .filter(([, usd]) => usd.trim() && Number(usd) > 0)
    .map(([name, usd]) => [name, Number(usd)]));
  // Every provider that serves chat, plus any with a limit already set.
  const providerNames = [...new Set([...d.stats.providers.map(p => p.name), ...Object.keys(settings?.providerBudgetsUsd ?? {})])].sort();
  const dirty = settings !== null && (
    JSON.stringify(models) !== JSON.stringify(settings.models)
    || JSON.stringify(aliases) !== JSON.stringify(settings.aliases)
    || monthlyBudgetUsd !== settings.monthlyBudgetUsd
    || JSON.stringify(providerBudgetsUsd) !== JSON.stringify(settings.providerBudgetsUsd ?? {})
    || JSON.stringify(prices) !== JSON.stringify(settings.prices)
    || JSON.stringify(defaultPrice) !== JSON.stringify(settings.defaultPrice)
    || JSON.stringify(blocked) !== JSON.stringify(settings.blockedModels ?? [])
    || usePublished !== (settings.usePublishedPrices !== false));
  const publishedTotal = Object.values(settings?.publishedPrices ?? {}).reduce((a, b) => a + b, 0);
  const globMatch = (pattern: string, m: string) => (pattern.includes('*')
    ? new RegExp(`^${pattern.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(m)
    : pattern.toLowerCase() === m.toLowerCase());
  const isOff = (m: string) => blocked.some(p => globMatch(p, m));
  const blockQuery = blockSearch.trim().toLowerCase();
  const blockList = (blockQuery ? known.filter(m => m.toLowerCase().includes(blockQuery)) : known.filter(isOff)).slice(0, 60);
  const toggleModel = (m: string, on: boolean) => {
    if (on) {
      // Turning one back on: drop its exact entry; a pattern that still covers it stays (shown below).
      setBlocked(blocked.filter(p => p.toLowerCase() !== m.toLowerCase()));
    } else if (!isOff(m)) {
      setBlocked([...blocked, m]);
    }
  };
  const addBlock = (value: string) => {
    const v = value.trim();
    if (v && !blocked.includes(v)) setBlocked([...blocked, v]);
  };
  const unpriced = models.filter(m => !m.includes('*') && !prices[m] && !Object.keys(prices).some(p => p.includes('*') && new RegExp(`^${p.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(m)));

  function add(model: string) {
    const m = model.trim();
    if (m && !models.includes(m)) setModels([...models, m]);
    setDraft('');
  }

  function claudeAliases() {
    const strong = models.find(m => !m.includes('*')) ?? '';
    const fast = models.find(m => /flash|mini|haiku|small|lite/i.test(m)) ?? strong;
    const next = rows.filter(r => !r.from.startsWith('claude-'));
    next.push({ from: 'claude-opus-*', to: strong }, { from: 'claude-sonnet-*', to: strong }, { from: 'claude-haiku-*', to: fast });
    setRows(next);
  }

  async function save() {
    setSaving(true);
    try {
      apply(await api<HostedSettings>('/admin/api/settings', { method: 'PUT', body: { models, aliases, blockedModels: blocked, monthlyBudgetUsd, providerBudgetsUsd, prices, defaultPrice, usePublishedPrices: usePublished } }));
      toast.success('Saved.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  const unknownTargets = Object.values(aliases).filter(t => models.length && !models.some(m => m === t || (m.includes('*') && new RegExp(`^${m.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(t))));

  return (
    <>
      <PageHeader
        title="Offered models"
        description="What access keys can use, what it costs, and the monthly spending limit. A key can be narrowed further on Access keys."
        actions={<Button onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save changes'}</Button>}
      />
      {settings && !settings.saved ? <Alert className="mb-4"><AlertDescription>Showing the defaults from the server's environment. Saving here makes the dashboard the source from now on.</AlertDescription></Alert> : null}

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Ban className="size-4" />Turned off</CardTitle>
          <CardDescription>Models no access key can use, even through an alias, and that agents won't see in <code className="font-mono text-xs">/v1/models</code>. Your own playground isn't affected.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {blocked.length ? blocked.map(p => (
              <Badge key={p} variant="outline" className="gap-1 border-destructive/30 bg-destructive/10 py-1 pr-1 font-mono text-destructive">
                {p}{p.includes('*') ? <span className="font-sans text-[10px] opacity-70">({known.filter(m => globMatch(p, m)).length})</span> : null}
                <button type="button" className="rounded-sm p-0.5 hover:bg-background" onClick={() => setBlocked(blocked.filter(x => x !== p))} aria-label={`Turn ${p} back on`}><X className="size-3" /></button>
              </Badge>
            )) : <span className="text-sm text-muted-foreground">Nothing turned off.</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            {['*claude-opus*', '*claude-sonnet*'].filter(p => !blocked.includes(p)).map(p => (
              <Button key={p} type="button" variant="outline" size="sm" className="font-mono text-xs" onClick={() => addBlock(p)}><Plus />{p}</Button>
            ))}
          </div>
          <div className="relative max-w-md">
            <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input className="pl-8" value={blockSearch} onChange={e => setBlockSearch(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && blockSearch.includes('*')) { addBlock(blockSearch); setBlockSearch(''); } }}
              placeholder="Find a model to turn off (or type a pattern like claude-* and press Enter)" aria-label="Find a model" />
          </div>
          {blockList.length ? (
            <div className="grid max-h-80 gap-1 overflow-y-auto sm:grid-cols-2">
              {blockList.map(m => {
                const off = isOff(m);
                const byPattern = off && !blocked.some(p => p.toLowerCase() === m.toLowerCase());
                return (
                  <label key={m} className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50">
                    <span className="min-w-0">
                      <span className={off ? 'font-mono text-xs text-muted-foreground line-through' : 'font-mono text-xs'}>{m}</span>
                      {byPattern ? <span className="block text-[11px] text-muted-foreground">off by a pattern above</span> : null}
                    </span>
                    <Switch checked={!off} disabled={byPattern} onCheckedChange={on => toggleModel(m, on)} aria-label={`${m} ${off ? 'off' : 'on'}`} />
                  </label>
                );
              })}
            </div>
          ) : blockQuery ? <p className="text-sm text-muted-foreground">No model matches "{blockSearch}".</p> : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Spending</CardTitle>
            <CardDescription>What every key together may spend a month, at the prices below. Requests stop once it's reached and start again on the 1st (UTC).</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {settings ? (
              <div className="grid gap-1.5">
                <div className="flex items-baseline justify-between text-sm">
                  <span className="text-2xl font-semibold tabular-nums">{money(settings.spend.usd)}</span>
                  <span className="text-muted-foreground">{settings.monthlyBudgetUsd ? `of $${settings.monthlyBudgetUsd} in ${settings.spend.month}` : `in ${settings.spend.month}, no limit`}</span>
                </div>
                {settings.monthlyBudgetUsd ? <Progress value={Math.min(100, (100 * settings.spend.usd) / settings.monthlyBudgetUsd)} className="h-2" /> : null}
                <p className="text-xs text-muted-foreground">{settings.spend.requests.toLocaleString()} requests this month, including the playground.</p>
              </div>
            ) : null}
            <div className="grid max-w-56 gap-1.5">
              <Label htmlFor="budget">Monthly limit (US$)</Label>
              <div className="flex items-center gap-2">
                <Input id="budget" type="number" min={1} step={1} placeholder="No limit" value={budget} onChange={e => setBudget(e.target.value)} />
                <Button type="button" size="sm" onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save'}</Button>
              </div>
            </div>
            <div className="grid gap-2">
              <div className="grid gap-0.5">
                <Label>Per provider (US$ a month)</Label>
                <span className="text-xs text-muted-foreground">
                  A provider at its limit gets no more requests this month: they go to another provider serving the same model, or are refused when there's none.
                </span>
              </div>
              {providerNames.map(name => {
                const spent = settings?.spend.byProvider?.[name]?.usd ?? 0;
                const limit = Number(providerBudgets[name]);
                return (
                  <div key={name} className="grid grid-cols-[1fr_auto_7rem] items-center gap-3 text-sm">
                    <span className="truncate">{name}</span>
                    <span className={`tabular-nums text-xs ${limit > 0 && spent >= limit ? 'text-destructive' : 'text-muted-foreground'}`}>
                      {money(spent)}{limit > 0 ? ` of $${limit}` : ''}
                    </span>
                    <Input
                      aria-label={`${name} monthly limit`}
                      type="number" min={1} step={1} placeholder="No limit"
                      value={providerBudgets[name] ?? ''}
                      onChange={e => setProviderBudgets(b => ({ ...b, [name]: e.target.value }))}
                    />
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Prices</CardTitle>
            <CardDescription>US$ per million tokens for the model that answered. A price set here wins; otherwise the provider's published price; otherwise "Others". <code className="font-mono text-xs">*</code> matches anything. Audio is priced by the minute (speech-to-text) or the character (text-to-speech) at list prices.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <label className="mb-2 flex items-start justify-between gap-3 rounded-lg border p-3">
              <span className="grid gap-0.5">
                <span className="text-sm font-medium">Use providers' published prices</span>
                <span className="text-xs text-muted-foreground">
                  {publishedTotal
                    ? `${publishedTotal.toLocaleString()} models priced automatically: ${Object.entries(settings?.publishedPrices ?? {}).map(([p, n]) => `${p} ${n}`).join(', ')}. Updated with each provider's model list.`
                    : 'llmapi.ai and OpenRouter publish prices with their model lists; none loaded yet.'}
                </span>
              </span>
              <Switch checked={usePublished} onCheckedChange={setUsePublished} aria-label="Use providers' published prices" />
            </label>
            <div className="grid grid-cols-[1fr_5.5rem_5.5rem_2.25rem] gap-2 text-xs text-muted-foreground"><span>Model</span><span>Input</span><span>Output</span><span /></div>
            {priceRows.map((row, i) => (
              <div key={i} className="grid grid-cols-[1fr_5.5rem_5.5rem_2.25rem] items-center gap-2">
                <Input className="font-mono text-xs" value={row.model} placeholder="gpt-5.5" list="offered-models" aria-label="Model" onChange={e => setPriceRows(priceRows.map((r, j) => (j === i ? { ...r, model: e.target.value } : r)))} />
                <Input type="number" min={0} step="any" value={row.input} aria-label="Input price" onChange={e => setPriceRows(priceRows.map((r, j) => (j === i ? { ...r, input: e.target.value } : r)))} />
                <Input type="number" min={0} step="any" value={row.output} aria-label="Output price" onChange={e => setPriceRows(priceRows.map((r, j) => (j === i ? { ...r, output: e.target.value } : r)))} />
                <Button type="button" variant="ghost" size="icon" onClick={() => setPriceRows(priceRows.filter((_, j) => j !== i))} aria-label="Remove price"><X /></Button>
              </div>
            ))}
            <div className="grid grid-cols-[1fr_5.5rem_5.5rem_2.25rem] items-center gap-2">
              <span className="text-sm text-muted-foreground">Others</span>
              <Input type="number" min={0} step="any" value={fallback.input} aria-label="Default input price" onChange={e => setFallback({ ...fallback, input: e.target.value })} />
              <Input type="number" min={0} step="any" value={fallback.output} aria-label="Default output price" onChange={e => setFallback({ ...fallback, output: e.target.value })} />
              <span />
            </div>
            {unpriced.length ? <p className="text-xs text-muted-foreground">No price set here{usePublished ? ' (the provider\'s published price applies, else "Others")' : ' (counted at "Others")'}: {unpriced.join(', ')}</p> : null}
          </CardContent>
          <CardFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setPriceRows([...priceRows, { model: unpriced[0] ?? '', input: '', output: '' }])}><Plus />Price</Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Models</CardTitle>
            <CardDescription>Model ids listed on <code className="font-mono text-xs">/v1/models</code> and allowed in requests. <code className="font-mono text-xs">*</code> matches anything. None: whatever the router can serve. Embeddings and audio models count too (e.g. <code className="font-mono text-xs">text-embedding-*</code>, <code className="font-mono text-xs">whisper-1</code>, <code className="font-mono text-xs">nova-3</code>, <code className="font-mono text-xs">tts-1</code>, <code className="font-mono text-xs">@cf/*</code>).</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="flex flex-wrap gap-2">
              {models.length ? models.map(m => (
                <Badge key={m} variant="secondary" className="gap-1 py-1 pr-1 font-mono">
                  {m}
                  <button type="button" className="rounded-sm p-0.5 hover:bg-background" onClick={() => setModels(models.filter(x => x !== m))} aria-label={`Remove ${m}`}><X className="size-3" /></button>
                </Badge>
              )) : <span className="text-sm text-muted-foreground">Every model the router can serve.</span>}
            </div>
            <form className="flex gap-2" onSubmit={e => { e.preventDefault(); add(draft); }}>
              <Input value={draft} onChange={e => setDraft(e.target.value)} placeholder="Model id, e.g. gpt-5.5" list="known-models" aria-label="Add a model" />
              <datalist id="known-models">{known.map(m => <option key={m} value={m} />)}</datalist>
              <Button type="submit" variant="secondary" disabled={!draft.trim()}><Plus />Add</Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Aliases</CardTitle>
            <CardDescription>Map a requested model to one you offer. Claude Code asks for <code className="font-mono text-xs">claude-*</code> models, so alias those to what you want it to use.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {rows.map((row, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input className="font-mono text-xs" value={row.from} placeholder="claude-sonnet-*" aria-label="Requested model" onChange={e => setRows(rows.map((r, j) => (j === i ? { ...r, from: e.target.value } : r)))} />
                <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                <Input className="font-mono text-xs" value={row.to} placeholder="gpt-5.5" list="offered-models" aria-label="Model used" onChange={e => setRows(rows.map((r, j) => (j === i ? { ...r, to: e.target.value } : r)))} />
                <Button type="button" variant="ghost" size="icon" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove alias"><X /></Button>
              </div>
            ))}
            <datalist id="offered-models">{[...models.filter(m => !m.includes('*')), ...known].map(m => <option key={m} value={m} />)}</datalist>
            {unknownTargets.length ? <p className="text-xs text-warning">Not in the offered list: {unknownTargets.join(', ')}</p> : null}
          </CardContent>
          <CardFooter className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setRows([...rows, { from: '', to: '' }])}><Plus />Alias</Button>
            <Button type="button" variant="outline" size="sm" onClick={claudeAliases} disabled={!models.some(m => !m.includes('*'))}><Sparkles />Claude Code aliases</Button>
          </CardFooter>
        </Card>
      </div>
      {settings?.saved ? <p className="mt-4 text-xs text-muted-foreground">Last saved {when(settings.saved.at)}{settings.saved.by && settings.saved.by !== 'token' ? ` by ${settings.saved.by}` : ''}.</p> : null}
    </>
  );
}
