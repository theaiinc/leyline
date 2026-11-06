import { useEffect, useState, type FormEvent } from 'react';
import { Image as ImageIcon, Send, Video } from 'lucide-react';
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
import type { Capability } from '@/normalization';
import { MediaPlayground } from '@/pages/media-playground';

export function PlaygroundPage({ d }: { d: Dashboard }) {
  const providers = d.stats.providers;
  const [mode, setMode] = useState<'chat' | 'image' | 'video'>('chat');
  const [providerName, setProviderName] = useState('');
  const [modelId, setModelId] = useState('');
  const [prompt, setPrompt] = useState('Say hello in one sentence.');
  const [answer, setAnswer] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [error, setError] = useState('');
  const [latency, setLatency] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [expectedOutput, setExpectedOutput] = useState(500);
  const [prices, setPrices] = useState<Record<string, ModelPrice>>({});
  const [mediaPrices, setMediaPrices] = useState<Record<string, string>>({});
  const [usage, setUsage] = useState<DisplayUsage | null>(null);
  const [sessionTotal, setSessionTotal] = useState(0);
  const provider = providers.find(p => p.name === providerName) ?? providers[0];
  const capability: Capability = mode === 'chat' ? 'chat' : mode;
  const availableProviders = providers.filter(p => p.capabilities.includes(capability));
  const activeProvider = availableProviders.find(p => p.name === providerName) ?? availableProviders[0];
  const models = activeProvider?.models ?? [];

  useEffect(() => {
    if (!activeProvider) return;
    if (activeProvider.name !== providerName) setProviderName(activeProvider.name);
    if (!models.some(m => m.id === modelId)) setModelId(models[0]?.id || activeProvider.defaultModel || '');
  }, [mode, activeProvider?.name, models.length]);

  useEffect(() => {
    fetch(apiUrl('/v1/pricing'), { credentials: 'same-origin' }).then(response => response.json()).then(data => {
      const next: Record<string, ModelPrice> = {};
      for (const [model, value] of Object.entries((data as { models?: Record<string, { input?: number; output?: number; cachedInput?: number }> }).models ?? {})) {
        if (typeof value.input === 'number' && typeof value.output === 'number') next[model] = { model, input: value.input, output: value.output, cachedInput: value.cachedInput };
      }
      const media: Record<string, string> = {};
      for (const m of (data as { media?: Array<{ id: string; per_image?: number; per_1m_video_tokens?: number }> }).media ?? []) {
        media[m.id] = m.per_image !== undefined ? `${formatUsd(m.per_image)}/image` : m.per_1m_video_tokens !== undefined ? `$${m.per_1m_video_tokens}/1M video tokens` : '';
      }
      setMediaPrices(media);
      setPrices(next);
    }).catch(() => undefined);
  }, []);

  const price = prices[modelId];
  const estimatedInput = Math.ceil(prompt.length / 4);
  const estimate = costForTokens(estimatedInput, expectedOutput, price);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!activeProvider || !modelId || !prompt.trim()) return;
    setSending(true);
    setError('');
    setAnswer('');
    setMediaUrl('');
    setUsage(null);
    const started = performance.now();
    try {
      const endpoint = mode === 'chat' ? '/v1/chat/completions' : mode === 'image' ? '/v1/images/generations' : '/v1/videos';
      const body = mode === 'chat'
        ? { model: modelId, messages: [{ role: 'user', content: prompt }] }
        : { model: modelId, prompt };
      const res = await fetch(apiUrl(endpoint), {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...(d.session?.hosted ? {} : { Authorization: `Bearer ${d.stats.clientAuth?.apiKey || ''}` }),
          'X-Leyline-Force-Provider': provider.name,
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setLatency(Math.round(performance.now() - started));
      if (!res.ok) return setError(data?.error?.message || 'Request failed');
      if (mode === 'chat') {
        setAnswer(data.choices?.[0]?.message?.content || '(empty response)');
        const runUsage = displayUsage(data, modelId, prices, price);
        setUsage(runUsage);
        const runCost = runUsage.cost;
        if (runCost !== undefined) setSessionTotal(total => total + runCost);
      } else {
        let final = data;
        // A video is a job: poll it until it's done (the charge appears once it succeeded).
        if (mode === 'video' && data.id && data.status !== 'succeeded') {
          for (let i = 0; i < 120 && !['succeeded', 'failed', 'cancelled', 'expired'].includes(final.status); i++) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            const poll = await fetch(apiUrl(`/v1/videos/${encodeURIComponent(data.id)}`), { credentials: 'same-origin', headers: d.session?.hosted ? {} : { Authorization: `Bearer ${d.stats.clientAuth?.apiKey || ''}` } });
            final = await poll.json();
            if (!poll.ok) return setError(final?.error?.message || 'Video check failed');
          }
          setLatency(Math.round(performance.now() - started));
          if (final.status !== 'succeeded') return setError(final.error || `Video ${final.status || 'did not finish'}`);
        }
        const media = final.data?.[0] ?? final;
        const url = media.url || (media.b64_json ? `data:image/png;base64,${media.b64_json}` : undefined);
        if (typeof url === 'string') setMediaUrl(url);
        const cost = typeof final.cost === 'number' ? final.cost : undefined;
        if (cost !== undefined) {
          setUsage({ servedModel: modelId, input: 0, output: 0, cached: 0, cost });
          setSessionTotal(total => total + cost);
        }
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
          <CardDescription>Choose a capability, then run an account-available model directly through its provider.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Playground mode">
            {([
              ['chat', 'Chat', Send],
              ['image', 'Image', ImageIcon],
              ['video', 'Video', Video],
            ] as const).map(([value, label, Icon]) => (
              <Button key={value} type="button" variant={mode === value ? 'default' : 'outline'} onClick={() => setMode(value)} role="tab" aria-selected={mode === value}>
                <Icon /> {label}
              </Button>
            ))}
            </div>
            {mode !== 'chat' ? <MediaPlayground kind={mode} authHeaders={d.session?.hosted ? {} : { Authorization: `Bearer ${d.stats.clientAuth?.apiKey || ''}` }} /> : <>
            <form onSubmit={send} className="grid gap-4">
              <div className="flex flex-wrap gap-2">
                <Select value={activeProvider?.name || ''} onValueChange={setProviderName}>
                  <SelectTrigger className="w-52" aria-label="Provider"><SelectValue placeholder="Provider" /></SelectTrigger>
                  <SelectContent>{availableProviders.map(p => <SelectItem key={p.name} value={p.name}>{p.label || p.name}</SelectItem>)}</SelectContent>
                </Select>
                <Select value={modelId} onValueChange={setModelId}>
                  <SelectTrigger className="min-w-52 flex-1" aria-label="Model"><SelectValue placeholder="Model" /></SelectTrigger>
                  <SelectContent>{models.map(m => <SelectItem key={m.id} value={m.id}>{m.name || m.id} · {mediaPrices[m.id] || (prices[m.id] ? formatUsd(prices[m.id].output) : 'Price unavailable')}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            <div className="grid gap-1.5">
              <Label htmlFor="prompt">Prompt</Label>
              <Textarea id="prompt" rows={4} value={prompt} onChange={e => setPrompt(e.target.value)} />
            </div>
            <div className="grid gap-2 sm:flex sm:items-center sm:gap-3">
              <Button type="submit" disabled={sending || !provider || !modelId}><Send />{sending ? 'Sending…' : 'Send'}</Button>
              {mode === 'chat' ? <span className="text-sm text-muted-foreground">Estimated cost: {formatUsd(estimate)} ({estimatedInput.toLocaleString()} input tokens estimated)</span> : <span className="text-sm text-muted-foreground">Price: {mediaPrices[modelId] || 'unavailable'}</span>}
              <label className="text-sm text-muted-foreground">Expected output <input className="ml-2 w-20 rounded border bg-background px-2 py-1" type="number" min="0" value={expectedOutput} onChange={e => setExpectedOutput(Number(e.target.value) || 0)} /></label>
              {latency !== null ? <span className="text-sm text-muted-foreground tabular-nums">{latency}ms</span> : null}
            </div>
          </form>
          {error ? <Alert variant="destructive" className="mt-4"><AlertDescription>{error}</AlertDescription></Alert> : null}
          {answer ? <pre className="mt-4 rounded-lg border bg-muted/50 p-4 text-sm whitespace-pre-wrap">{answer}</pre> : null}
          {usage ? <div className="mt-4 rounded-lg border p-4 text-sm grid gap-1"><strong>Run usage</strong><span>Served by {usage.servedModel}</span><span>{usage.input.toLocaleString()} input · {usage.output.toLocaleString()} output{usage.cached ? ` · ${usage.cached.toLocaleString()} cached` : ''}</span><span>Charged {usage.cost === undefined ? 'price not published' : formatUsd(usage.cost)} · {latency ?? 0}ms</span><span>Playground session total: {formatUsd(sessionTotal)}</span></div> : null}
          <p className="mt-4 text-sm"><a className="underline" href="#calculator">Open cost calculator</a></p>
          </>}
        </CardContent>
      </Card>
    </>
  );
}
