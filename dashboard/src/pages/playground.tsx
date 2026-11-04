import { useEffect, useState, type FormEvent } from 'react';
import { Send } from 'lucide-react';
import { costForTokens, displayUsage, formatUsd, type DisplayUsage, type ModelPrice } from '@/lib/cost';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { PageHeader } from '@/components/common';
import { apiUrl } from '@/api';
import type { Dashboard } from '@/hooks/use-dashboard';

export function PlaygroundPage({ d }: { d: Dashboard }) {
  const providers = d.stats.providers;
  const [providerName, setProviderName] = useState('');
  const [modelId, setModelId] = useState('');
  const [prompt, setPrompt] = useState('Say hello in one sentence.');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [latency, setLatency] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [expectedOutput, setExpectedOutput] = useState(500);
  const [prices, setPrices] = useState<Record<string, ModelPrice>>({});
  const [usage, setUsage] = useState<DisplayUsage | null>(null);
  const [sessionTotal, setSessionTotal] = useState(0);
  const provider = providers.find(p => p.name === providerName) ?? providers[0];
  const models = provider?.models ?? [];

  useEffect(() => {
    if (!provider) return;
    if (!models.some(m => m.id === modelId)) setModelId(models[0]?.id || provider.defaultModel || '');
  }, [provider?.name, models.length]);

  useEffect(() => {
    fetch(apiUrl('/v1/pricing'), { credentials: 'same-origin' }).then(response => response.json()).then(data => {
      const next: Record<string, ModelPrice> = {};
      for (const [model, value] of Object.entries((data as { models?: Record<string, { input?: number; output?: number; cachedInput?: number }> }).models ?? {})) {
        if (typeof value.input === 'number' && typeof value.output === 'number') next[model] = { model, input: value.input, output: value.output, cachedInput: value.cachedInput };
      }
      setPrices(next);
    }).catch(() => undefined);
  }, []);

  const price = prices[modelId];
  const estimatedInput = Math.ceil(prompt.length / 4);
  const estimate = costForTokens(estimatedInput, expectedOutput, price);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!provider || !modelId || !prompt.trim()) return;
    setSending(true);
    setError('');
    setAnswer('');
    const started = performance.now();
    try {
      // Hosted: the signed-in owner's session is enough (no access key, not counted). Local: the client key.
      const res = await fetch(apiUrl('/v1/chat/completions'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...(d.session?.hosted ? {} : { Authorization: `Bearer ${d.stats.clientAuth?.apiKey || ''}` }),
          'X-Leyline-Force-Provider': provider.name,
        },
        body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: prompt }] }),
      });
      const data = await res.json();
      setLatency(Math.round(performance.now() - started));
      if (!res.ok) return setError(data?.error?.message || 'Request failed');
      setAnswer(data.choices?.[0]?.message?.content || '(empty response)');
      const runUsage = displayUsage(data, modelId, prices, price);
      setUsage(runUsage);
      const chargedCost = runUsage.cost;
      if (chargedCost !== undefined) {
        setSessionTotal(total => total + chargedCost);
      }
    } catch (err) {
      setLatency(Math.round(performance.now() - started));
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <PageHeader title="Playground" description="Send one request straight to a provider and model, bypassing pools and pins, to check that combination works." />
      <Card>
        <CardHeader>
          <CardTitle>Test a provider and model</CardTitle>
          <CardDescription>Goes through <code className="font-mono text-xs">/v1/chat/completions</code>.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={send} className="grid gap-4">
            <div className="flex flex-wrap gap-2">
              <Select value={provider?.name || ''} onValueChange={setProviderName}>
                <SelectTrigger className="w-52" aria-label="Provider"><SelectValue placeholder="Provider" /></SelectTrigger>
                <SelectContent>{providers.map(p => <SelectItem key={p.name} value={p.name}>{p.label || p.name}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={modelId} onValueChange={setModelId}>
                <SelectTrigger className="min-w-52 flex-1" aria-label="Model"><SelectValue placeholder="Model" /></SelectTrigger>
                <SelectContent>{models.map(m => <SelectItem key={m.id} value={m.id}>{m.name || m.id}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="prompt">Prompt</Label>
              <Textarea id="prompt" rows={4} value={prompt} onChange={e => setPrompt(e.target.value)} />
            </div>
            <div className="grid gap-2 sm:flex sm:items-center sm:gap-3">
              <Button type="submit" disabled={sending || !provider || !modelId}><Send />{sending ? 'Sending…' : 'Send'}</Button>
              <span className="text-sm text-muted-foreground">Estimated cost: {formatUsd(estimate)} ({estimatedInput.toLocaleString()} input tokens estimated)</span>
              <label className="text-sm text-muted-foreground">Expected output <input className="ml-2 w-20 rounded border bg-background px-2 py-1" type="number" min="0" value={expectedOutput} onChange={e => setExpectedOutput(Number(e.target.value) || 0)} /></label>
              {latency !== null ? <span className="text-sm text-muted-foreground tabular-nums">{latency}ms</span> : null}
            </div>
          </form>
          {error ? <Alert variant="destructive" className="mt-4"><AlertDescription>{error}</AlertDescription></Alert> : null}
          {answer ? <pre className="mt-4 rounded-lg border bg-muted/50 p-4 text-sm whitespace-pre-wrap">{answer}</pre> : null}
          {usage ? <div className="mt-4 rounded-lg border p-4 text-sm grid gap-1"><strong>Run usage</strong><span>Served by {usage.servedModel}</span><span>{usage.input.toLocaleString()} input · {usage.output.toLocaleString()} output{usage.cached ? ` · ${usage.cached.toLocaleString()} cached` : ''}</span><span>Charged {usage.cost === undefined ? 'price not published' : formatUsd(usage.cost)} · {latency ?? 0}ms</span><span>Playground session total: {formatUsd(sessionTotal)}</span></div> : null}
          <p className="mt-4 text-sm"><a className="underline" href="#calculator">Open cost calculator</a></p>
        </CardContent>
      </Card>
    </>
  );
}
