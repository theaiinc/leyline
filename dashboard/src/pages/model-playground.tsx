import { useMemo, useState } from 'react';
  import { Code2, Copy, Play, Search } from 'lucide-react';
  import { Button } from '@/components/ui/button';
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
  import { Input } from '@/components/ui/input';
  import { Label } from '@/components/ui/label';
  import { Textarea } from '@/components/ui/textarea';
  import { PageHeader } from '@/components/common';
  import { apiUrl } from '@/api';
  import { costForTokens, formatUsd, type ModelPrice } from '@/lib/cost';
  import { formatRunCost, modeLabel, modesForModel, maskedCodeSnippets, type PlaygroundMode, type PlaygroundModel } from '@/lib/playground';
  import type { Dashboard } from '@/hooks/use-dashboard';

  type Run = { mode: PlaygroundMode; model: string; input: string; output: string; cost?: number; elapsed: number };

  export function ModelPlaygroundPage({ d }: { d: Dashboard }) {
    const allModels = useMemo<PlaygroundModel[]>(() => d.stats.providers.flatMap(provider => provider.models.map(model => ({
      id: model.id,
      name: model.name,
      provider: provider.name,
      capabilities: (model as typeof model & { capabilities?: PlaygroundModel['capabilities'] }).capabilities,
    }))), [d.stats.providers]);
    const [query, setQuery] = useState('');
    const [selected, setSelected] = useState<PlaygroundModel | undefined>(allModels[0]);
    const [mode, setMode] = useState<PlaygroundMode>('chat');
    const [input, setInput] = useState('Explain Valefront in one sentence.');
    const [output, setOutput] = useState('');
    const [status, setStatus] = useState<'Idle' | 'Running' | 'Done' | 'Failed'>('Idle');
    const [elapsed, setElapsed] = useState(0);
    const [cost, setCost] = useState<number>();
    const [prices, setPrices] = useState<Record<string, ModelPrice>>({});
    const [history, setHistory] = useState<Run[]>([]);
    const filtered = allModels.filter(model => `${model.name} ${model.id} ${model.provider}`.toLowerCase().includes(query.toLowerCase()));
    const availableModes = selected ? modesForModel(selected) : [];
    const price = selected ? prices[selected.id] : undefined;
    const estimatedTokens = Math.ceil(input.length / 4);
    const estimate = costForTokens(estimatedTokens, mode === 'chat' ? 300 : 0, price);

    async function run() {
      if (!selected || !input.trim() || !availableModes.includes(mode)) return;
      setStatus('Running');
      setOutput('');
      const started = performance.now();
      try {
        const endpoint = mode === 'chat' ? '/v1/chat/completions' : mode === 'embeddings' ? '/v1/embeddings' : mode === 'speech' ? '/v1/audio/speech' : '/v1/audio/transcriptions';
        const imageFile = mode === 'chat' ? (document.getElementById('model-image') as HTMLInputElement | null)?.files?.[0] : undefined;
        const chatContent = imageFile ? [{ type: 'text', text: input }, { type: 'image_url', image_url: { url: URL.createObjectURL(imageFile) } }] : input;
        const body = mode === 'chat' ? { model: selected.id, messages: [{ role: 'user', content: chatContent }] } : mode === 'embeddings' ? { model: selected.id, input } : { model: selected.id, input };
        const isTranscription = mode === 'transcription';
        const requestBody = isTranscription ? (() => {
          const form = new FormData();
          form.append('model', selected.id);
          const file = (document.getElementById('model-input') as HTMLInputElement | null)?.files?.[0];
          if (file) form.append('file', file);
          return form;
        })() : mode === 'speech' ? JSON.stringify({ ...body, voice: 'alloy', response_format: 'mp3' }) : JSON.stringify(body);
        const response = await fetch(apiUrl(endpoint), { method: 'POST', credentials: 'same-origin', headers: isTranscription ? undefined : { 'Content-Type': 'application/json' }, body: requestBody });
        const contentType = response.headers.get('content-type') || '';
        const data = contentType.startsWith('audio/') ? await response.blob() : await response.json();
        const runtime = Math.round(performance.now() - started);
        setElapsed(runtime);
        if (!response.ok) throw new Error(data?.error?.message || 'Request failed');
        const text = mode === 'chat' ? data.choices?.[0]?.message?.content || '' : mode === 'embeddings' ? JSON.stringify(data.data?.[0]?.embedding?.slice(0, 8) || []) : mode === 'speech' && data instanceof Blob ? URL.createObjectURL(data) : mode === 'speech' ? 'Audio generated.' : data.text || '';
        const usage = data.usage;
        const actual = usage ? costForTokens(Number(usage.prompt_tokens || 0), Number(usage.completion_tokens || 0), price) : undefined;
        setCost(actual);
        setOutput(text);
        setHistory(previous => [{ mode, model: selected.id, input, output: text, cost: actual, elapsed: runtime }, ...previous].slice(0, 10));
        setStatus('Done');
      } catch (error) {
        setElapsed(Math.round(performance.now() - started));
        setOutput(error instanceof Error ? error.message : 'Request failed');
        setStatus('Failed');
      }
    }

    const snippets = selected ? maskedCodeSnippets(mode, selected.id, input) : null;
    return (
      <>
        <PageHeader title="Playground" description="Choose a served model, shape the request, and inspect its output and cost." />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Card>
            <CardHeader><CardTitle>Model and input</CardTitle><CardDescription>Only capabilities reported by the model are offered.</CardDescription></CardHeader>
            <CardContent className="grid gap-4">
              <div className="relative"><Search className="absolute left-3 top-3 size-4 text-muted-foreground" /><Input className="pl-9" placeholder="Search served models" value={query} onChange={event => setQuery(event.target.value)} /></div>
              <div className="max-h-44 overflow-auto rounded border">{filtered.map(model => <button type="button" key={`${model.provider}:${model.id}`} className={`block w-full px-3 py-2 text-left text-sm ${selected?.id === model.id ? 'bg-accent' : ''}`} onClick={() => { setSelected(model); setMode(modesForModel(model)[0] || 'chat'); }}>{model.name || model.id}<span className="ml-2 text-muted-foreground">{model.provider}</span></button>)}</div>
              {selected ? <div className="flex flex-wrap gap-2">{availableModes.map(item => <Button key={item} type="button" variant={mode === item ? 'default' : 'outline'} size="sm" onClick={() => setMode(item)}>{modeLabel(item)}</Button>)}</div> : null}
              <div className="grid gap-2"><Label htmlFor="model-input">{mode === 'transcription' ? 'Audio file' : mode === 'speech' ? 'Text to speak' : mode === 'embeddings' ? 'Text to embed' : 'Prompt'}</Label>{mode === 'transcription' ? <Input id="model-input" type="file" accept="audio/*" /> : <Textarea id="model-input" rows={7} value={input} onChange={event => setInput(event.target.value)} />}</div>
              <Button onClick={() => void run()} disabled={status === 'Running' || !selected}><Play />{status === 'Running' ? 'Running…' : `Run ${estimate === undefined ? '' : formatUsd(estimate)}`}</Button>
              <p className="text-xs text-muted-foreground">Estimated from the current input; the API remains the source of the charged cost.</p>
              {selected && price ? <p className="text-xs text-muted-foreground">Published price: ${price.input}/1M input · ${price.output}/1M output</p> : <p className="text-xs text-muted-foreground">Price not published</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Output</CardTitle><CardDescription><span className="mr-2 rounded-full border px-2 py-0.5 text-xs">{status}</span>{elapsed ? `${elapsed}ms` : 'Ready'}</CardDescription></CardHeader>
            <CardContent className="grid gap-4">
              {output ? <pre className="min-h-40 whitespace-pre-wrap rounded-lg border bg-muted/40 p-4 text-sm">{output}</pre> : <div className="grid min-h-40 place-items-center rounded-lg border border-dashed text-sm text-muted-foreground">Run the selected model to see its output.</div>}
              {cost !== undefined ? <p className="text-sm">Cost: {formatUsd(cost)} · Runtime: {elapsed}ms</p> : null}
              {snippets ? <details><summary className="flex cursor-pointer items-center gap-2 text-sm font-medium"><Code2 className="size-4" />Use it in code</summary><div className="mt-3 grid gap-3 text-xs"><pre className="overflow-auto rounded border p-3">{snippets.curl}</pre><pre className="overflow-auto rounded border p-3">{snippets.python}</pre><pre className="overflow-auto rounded border p-3">{snippets.javascript}</pre><Button type="button" variant="outline" onClick={() => void navigator.clipboard?.writeText(snippets.curl)}><Copy />Copy curl</Button></div></details> : null}
            </CardContent>
          </Card>
        </div>
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Card><CardHeader><CardTitle>Examples</CardTitle><CardDescription>Start with a useful request.</CardDescription></CardHeader><CardContent><Button type="button" variant="outline" onClick={() => setInput('Summarize this product idea in three clear bullets.')}>Product summary</Button></CardContent></Card>
          <Card><CardHeader><CardTitle>Session history</CardTitle><CardDescription>Recent runs stay in this browser session.</CardDescription></CardHeader><CardContent>{history.length ? <div className="grid gap-2">{history.map((item, index) => <button type="button" key={`${item.model}-${index}`} className="rounded border p-3 text-left text-sm" onClick={() => { setInput(item.input); setOutput(item.output); setCost(item.cost); setMode(item.mode); }}><span className="font-medium">{modeLabel(item.mode)} · {item.model}</span><span className="block text-muted-foreground">{item.elapsed}ms · {item.cost === undefined ? 'Price not published' : formatUsd(item.cost)}</span></button>)}</div> : <p className="text-sm text-muted-foreground">No runs yet.</p>}</CardContent></Card>
        </div>
      </>
    );
  }