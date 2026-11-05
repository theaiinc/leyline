import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/common';
import { apiUrl } from '@/api';
import { costForTokens, formatUsd, freeTierRemaining, type ModelPrice } from '@/lib/cost';

export function CalculatorPage() {
  const [prices, setPrices] = useState<ModelPrice[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [inputTokens, setInputTokens] = useState(1000);
  const [outputTokens, setOutputTokens] = useState(500);
  const [requests, setRequests] = useState(100);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(apiUrl('/v1/pricing'), { credentials: 'same-origin' }).then(async response => {
      if (!response.ok) throw new Error('Could not load published pricing');
      const data = await response.json() as { models?: Record<string, { input?: number; output?: number; cachedInput?: number; free_tier?: number }> };
      const next = Object.entries(data.models ?? {}).flatMap(([model, value]) =>
        typeof value.input === 'number' && typeof value.output === 'number'
          ? [{ model, input: value.input, output: value.output, cachedInput: value.cachedInput, freeTier: value.free_tier }]
          : []);
      setPrices(next);
      setSelected(next.slice(0, 2).map(item => item.model));
    }).catch(err => setError(err instanceof Error ? err.message : 'Could not load pricing'));
  }, []);

  const results = useMemo(() => selected.map(model => {
    const price = prices.find(item => item.model === model);
    const request = costForTokens(inputTokens, outputTokens, price);
    const monthly = request === undefined ? undefined : request * requests * 30;
    return { price, request, daily: request === undefined ? undefined : request * requests, monthly };
  }), [selected, prices, inputTokens, outputTokens, requests]);

  return <>
    <PageHeader title="Cost calculator" description="Plan usage with the providers' official prices. Valefront adds no markup." />
    <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
      <Card><CardHeader><CardTitle>Inputs</CardTitle><CardDescription>Token, request, and monthly volume</CardDescription></CardHeader><CardContent className="grid gap-4">
        <div><Label htmlFor="calc-input">Input tokens / request</Label><Input id="calc-input" type="number" min="0" value={inputTokens} onChange={e => setInputTokens(Number(e.target.value) || 0)} /></div>
        <div><Label htmlFor="calc-output">Output tokens / request</Label><Input id="calc-output" type="number" min="0" value={outputTokens} onChange={e => setOutputTokens(Number(e.target.value) || 0)} /></div>
        <div><Label htmlFor="calc-requests">Requests / day</Label><Input id="calc-requests" type="number" min="0" value={requests} onChange={e => setRequests(Number(e.target.value) || 0)} /></div>
        <div className="grid gap-2"><Label>Models</Label>{prices.map(price => <label key={price.model} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.includes(price.model)} onChange={e => setSelected(current => e.target.checked ? [...current, price.model] : current.filter(model => model !== price.model))} />{price.model}</label>)}</div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </CardContent></Card>
      <div className="grid gap-4 md:grid-cols-2">{results.map(result => <Card key={result.price?.model}><CardHeader><CardTitle>{result.price?.model}</CardTitle><CardDescription>Input ${result.price?.input ?? 0}/M · Output ${result.price?.output ?? 0}/M</CardDescription></CardHeader><CardContent className="grid gap-2 text-sm"><div>Per request <strong>{formatUsd(result.request)}</strong></div><div>Per day <strong>{formatUsd(result.daily)}</strong></div><div>Per month <strong>{formatUsd(result.monthly)}</strong></div><div>Free tier remaining <strong>{formatUsd(freeTierRemaining(result.monthly ?? 0, result.price?.freeTier))}</strong></div></CardContent></Card>)}</div>
    </div>
  </>;
}