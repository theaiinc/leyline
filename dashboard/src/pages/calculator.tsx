import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/common';
import { apiUrl } from '@/api';
import { costForTokens, formatUsd, type ModelPrice } from '@/lib/cost';

type PricingModel = { id: string; name?: string; provider?: string; input?: number; output?: number; cachedInput?: number; free_tier?: boolean; source?: string };
type CalcPrice = ModelPrice & { name: string; provider?: string; free: boolean; source?: string };

/** /v1/pricing lists models as an array ({id, name, provider, input, output, free_tier}); older servers sent an object by id. */
export function pricesFrom(data: { models?: PricingModel[] | Record<string, Omit<PricingModel, 'id'>>; free_tier?: { models?: string[] } }): CalcPrice[] {
  const rows: PricingModel[] = Array.isArray(data.models) ? data.models : Object.entries(data.models ?? {}).map(([id, v]) => ({ id, ...v }));
  const freeIds = new Set(data.free_tier?.models ?? []);
  return rows.flatMap((m) => typeof m.input === 'number' && typeof m.output === 'number' && m.id
    ? [{ model: m.id, name: m.name || m.id, provider: m.provider, input: m.input, output: m.output, cachedInput: m.cachedInput, free: Boolean(m.free_tier) || freeIds.has(m.id), source: m.source }]
    : []);
}

export function CalculatorPage() {
  const [prices, setPrices] = useState<CalcPrice[]>([]);
  const [freeTokens, setFreeTokens] = useState(0);
  const [freePerDay, setFreePerDay] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [inputTokens, setInputTokens] = useState(1000);
  const [outputTokens, setOutputTokens] = useState(500);
  const [requests, setRequests] = useState(100);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(apiUrl('/v1/pricing'), { credentials: 'same-origin' }).then(async response => {
      if (!response.ok) throw new Error('Could not load published pricing');
      const data = await response.json();
      const next = pricesFrom(data);
      setPrices(next);
      setFreeTokens(Number(data.free_tier?.tokens ?? 0));
      setFreePerDay(Number(data.free_tier?.tokens_per_day ?? 0));
      setSelected(next.slice(0, 2).map(item => item.model));
    }).catch(err => setError(err instanceof Error ? err.message : 'Could not load pricing'));
  }, []);

  const results = useMemo(() => selected.map(model => {
    const price = prices.find(item => item.model === model);
    const request = costForTokens(inputTokens, outputTokens, price);
    const monthly = request === undefined ? undefined : request * requests * 30;
    const tokensPerDay = (inputTokens + outputTokens) * requests;
    // Free tokens are used at most freePerDay a day, so a busy day is only partly free.
    const freeUsedPerDay = freePerDay ? Math.min(tokensPerDay, freePerDay) : tokensPerDay;
    const freeDays = price?.free && freeTokens && freeUsedPerDay ? Math.min(30, freeTokens / freeUsedPerDay) : null;
    const freeShare = tokensPerDay ? freeUsedPerDay / tokensPerDay : 1;
    return { price, request, daily: request === undefined ? undefined : request * requests, monthly, freeDays, freeShare };
  }), [selected, prices, inputTokens, outputTokens, requests, freeTokens, freePerDay]);

  return <>
    <PageHeader title="Cost calculator" description="Plan usage with the providers' official prices. Valefront adds no markup." />
    {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
    <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
      <Card><CardHeader><CardTitle>Inputs</CardTitle><CardDescription>Tokens per request and requests per day</CardDescription></CardHeader><CardContent className="grid gap-4">
        <div><Label htmlFor="calc-input">Input tokens / request</Label><Input id="calc-input" type="number" min="0" value={inputTokens} onChange={e => setInputTokens(Number(e.target.value) || 0)} /></div>
        <div><Label htmlFor="calc-output">Output tokens / request</Label><Input id="calc-output" type="number" min="0" value={outputTokens} onChange={e => setOutputTokens(Number(e.target.value) || 0)} /></div>
        <div><Label htmlFor="calc-requests">Requests / day</Label><Input id="calc-requests" type="number" min="0" value={requests} onChange={e => setRequests(Number(e.target.value) || 0)} /></div>
        <div className="grid gap-2"><Label>Models</Label>{prices.map(price => <label key={price.model} title={price.model} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.includes(price.model)} onChange={e => setSelected(current => e.target.checked ? [...current, price.model] : current.filter(model => model !== price.model))} /><span>{price.name}</span>{price.provider ? <span className="text-xs text-muted-foreground">{price.provider}</span> : null}{price.free ? <span className="rounded-full bg-emerald-500/10 px-1.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-300">free tier</span> : null}</label>)}</div>
      </CardContent></Card>
      <div className="grid content-start gap-4 md:grid-cols-2">{results.map(result => <Card key={result.price?.model}><CardHeader><CardTitle title={result.price?.model}>{result.price?.name}</CardTitle><CardDescription>{result.price?.provider ? `${result.price.provider} · ` : ''}Input ${result.price?.input ?? 0}/M · Output ${result.price?.output ?? 0}/M tokens</CardDescription></CardHeader><CardContent className="grid gap-2 text-sm"><div>Per request <strong>{formatUsd(result.request)}</strong></div><div>Per day <strong>{formatUsd(result.daily)}</strong></div><div>Per 30 days <strong>{formatUsd(result.monthly)}</strong></div><div className="text-muted-foreground">{result.freeDays === null ? 'Not in the free tier: paid from credit.' : <>Free tokens cover {result.freeShare < 1 ? <><strong className="text-foreground">{Math.round(result.freeShare * 100)}% of each day</strong> (the daily free limit) for </> : null}<strong className="text-foreground">{result.freeDays >= 30 ? 'the whole 30 days' : `about ${Math.max(0, Math.floor(result.freeDays * 10) / 10)} days`}</strong> at this volume.</>}</div>{result.price?.source ? <a className="text-xs text-muted-foreground underline" href={result.price.source} target="_blank" rel="noreferrer">Provider price</a> : null}</CardContent></Card>)}</div>
    </div>
  </>;
}
