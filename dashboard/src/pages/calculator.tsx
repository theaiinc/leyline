import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/common';
import { apiUrl, type PricingResponse } from '@/api';
import { costForTokens, formatUsd, type ModelPrice } from '@/lib/cost';

export function CalculatorPage() {
  const [prices, setPrices] = useState<Array<ModelPrice & { name: string; provider: string; id: string; freeTierEligible: boolean; available: boolean }>>([]);
  const [freeTier, setFreeTier] = useState<PricingResponse['free_tier']>({ tokens: 0, expires_after_days: 0, models: [] });
  const [selected, setSelected] = useState<string[]>([]);
  const [inputTokens, setInputTokens] = useState(1000);
  const [outputTokens, setOutputTokens] = useState(500);
  const [requests, setRequests] = useState(100);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(apiUrl('/v1/pricing'), { credentials: 'same-origin' }).then(async response => {
      if (!response.ok) throw new Error('Could not load published pricing');
      const data = await response.json() as PricingResponse;
      const allowance = data.free_tier ?? { tokens: 0, expires_after_days: 0, models: [] };
      const next = (Array.isArray(data.models) ? data.models : []).map(item => ({
        id: item.id,
        model: item.id,
        name: item.name || item.id,
        provider: item.provider || 'Unknown provider',
        input: item.input,
        output: item.output,
        cachedInput: item.cached_input,
        freeTierEligible: allowance.models.includes(item.id),
        available: true,
      }));
      setFreeTier(allowance);
      setPrices(next);
      setSelected(next.filter(item => item.available).slice(0, 2).map(item => item.id));
    }).catch(err => setError(err instanceof Error ? err.message : 'Could not load pricing'));
  }, []);

  const results = useMemo(() => selected.map(model => {
    const price = prices.find(item => item.id === model);
    const request = costForTokens(inputTokens, outputTokens, price);
    const monthlyBeforeFree = request === undefined ? undefined : request * requests * 30;
    const freeTokensPerMonth = price?.freeTierEligible ? freeTier.tokens : 0;
    const estimatedTokens = (inputTokens + outputTokens) * requests * 30;
    const freeFraction = estimatedTokens > 0 ? Math.min(1, freeTokensPerMonth / estimatedTokens) : 0;
    const monthly = monthlyBeforeFree === undefined ? undefined : monthlyBeforeFree * (1 - freeFraction);
    return { price, request, daily: request === undefined ? undefined : request * requests, monthly, freeTokensPerMonth };
  }), [selected, prices, inputTokens, outputTokens, requests, freeTier.tokens]);

  return <>
    <PageHeader title="Cost calculator" description="Plan usage with the providers' official prices. Valefront adds no markup." />
    <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
      <Card><CardHeader><CardTitle>Inputs</CardTitle><CardDescription>Token, request, and monthly volume</CardDescription></CardHeader><CardContent className="grid gap-4">
        <div><Label htmlFor="calc-input">Input tokens / request</Label><Input id="calc-input" type="number" min="0" value={inputTokens} onChange={e => setInputTokens(Number(e.target.value) || 0)} /></div>
        <div><Label htmlFor="calc-output">Output tokens / request</Label><Input id="calc-output" type="number" min="0" value={outputTokens} onChange={e => setOutputTokens(Number(e.target.value) || 0)} /></div>
        <div><Label htmlFor="calc-requests">Requests / day</Label><Input id="calc-requests" type="number" min="0" value={requests} onChange={e => setRequests(Number(e.target.value) || 0)} /></div>
        <div className="grid gap-2"><Label>Models</Label>{prices.map(price => <label key={price.id} className={`flex items-start gap-2 text-sm ${price.available ? '' : 'opacity-50'}`}><input type="checkbox" disabled={!price.available} checked={selected.includes(price.id)} onChange={e => setSelected(current => e.target.checked ? [...current, price.id] : current.filter(model => model !== price.id))} /><span><span className="block">{price.name} · {price.provider}</span><span className="block text-xs text-muted-foreground">{price.id}{price.available ? '' : ' · no price set'}</span></span></label>)}</div>\n        {freeTier.models.length ? <p className="text-xs text-muted-foreground">First {(freeTier.tokens / 1_000_000).toLocaleString()}M tokens free for {freeTier.expires_after_days} days on eligible models.</p> : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </CardContent></Card>
      <div className="grid gap-6 md:grid-cols-2">{Array.from(new Set(results.map(result => result.price?.provider).filter((provider): provider is string => Boolean(provider)))).map(provider => <section key={provider} className="grid gap-3"><h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{provider}</h2>{results.filter(result => result.price?.provider === provider).map(result => <Card key={result.price?.id}><CardHeader><CardTitle>{result.price?.name} · {result.price?.provider}</CardTitle><CardDescription>{result.price?.id} · Input ${result.price?.input ?? 0}/M · Output ${result.price?.output ?? 0}/M</CardDescription></CardHeader><CardContent className="grid gap-2 text-sm"><div>Per request <strong>{formatUsd(result.request)}</strong></div><div>Per day <strong>{formatUsd(result.daily)}</strong></div><div>Per month after allowance <strong>{formatUsd(result.monthly)}</strong></div>{result.freeTokensPerMonth > 0 ? <div className="text-muted-foreground">First {(result.freeTokensPerMonth / 1_000_000).toLocaleString()}M tokens free for {freeTier.expires_after_days} days on this model</div> : null}</CardContent></Card>)}</section>)}</div>
    </div>
  </>;
}