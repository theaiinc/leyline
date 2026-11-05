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
import { mediaModels, defaultMediaParameters, type MediaKind, type MediaModel, type ParameterSchema } from '@/lib/media-playground';
  import type { Dashboard } from '@/hooks/use-dashboard';

  type Run = { mode: PlaygroundMode; model: string; input: string; output: string; cost?: number; elapsed: number };

  export function ModelPlaygroundPage({ d }: { d: Dashboard }) {
    const allModels = useMemo<PlaygroundModel[]>(() => d.stats.providers.flatMap(provider => provider.models.map(model => {
      const capabilities = provider.capabilities.reduce<NonNullable<PlaygroundModel['capabilities']>>((result, capability) => {
        result[capability] = true;
        return result;
      }, {});
      const modelCapabilities = (model as typeof model & { capabilities?: PlaygroundModel['capabilities'] }).capabilities;
      return { id: model.id, name: model.name, provider: provider.name, capabilities: { ...capabilities, ...modelCapabilities } };
    })), [d.stats.providers]);
    const mediaCatalog = useMemo<MediaModel[]>(() => d.stats.providers.flatMap(provider => provider.models.flatMap(model => {
      const capabilities = provider.capabilities;
      const id = `${model.id} ${model.name}`.toLowerCase();
      const kind: MediaKind | null = capabilities.includes('speech') || capabilities.includes('transcription') || /\b(tts|stt|speech|transcri)/i.test(id) ? 'audio' : /image|diffusion|flux|qwen-image|gpt-image/i.test(id) ? 'image' : /video|veo|kling|seedance|sora|wan2/i.test(id) ? 'video' : null;
      if (!kind) return [];
      // The current API exposes speech and transcription routes. Image/video generation
      // is intentionally surfaced as unavailable until those routes exist.
      const capability = kind === 'audio'
        ? (capabilities.includes('speech') || capabilities.includes('transcription'))
        : false;
      const parameters: Record<string, ParameterSchema> = defaultMediaParameters(kind);
      const mediaModel: MediaModel = {
        id: model.id,
        name: model.name,
        provider: provider.name,
        kind,
        served: capability,
        comingSoon: !capability,
        parameters,
      };
      return [mediaModel];
    })), [d.stats.providers]);
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
    const mediaFiltered = mediaModels(mediaCatalog, query);
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
              <div className="max-h-56 overflow-auto rounded border">
                <div className="border-b px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Chat and tools</div>
                {filtered.map(model => <button type="button" key={`${model.provider}:${model.id}`} className={`block w-full px-3 py-2 text-left text-sm ${selected?.id === model.id ? 'bg-accent' : ''}`} onClick={() => { setSelected(model); setMode(modesForModel(model)[0] || 'chat'); }}>{model.name || model.id}<span className="ml-2 text-muted-foreground">{model.provider}</span></button>)}
                <div className="border-y px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Media</div>
                {mediaFiltered.map(model => <button type="button" key={`media:${model.provider}:${model.id}`} disabled={!model.served} className={`block w-full px-3 py-2 text-left text-sm ${!model.served ? 'cursor-not-allowed opacity-50' : 'hover:bg-accent'}`} onClick={() => { if (model.served) { setSelected({ id: model.id, name: model.name, provider: model.provider, parameters: model.parameters, capabilities: { [model.kind === 'audio' ? 'speech' : model.kind]: true } }); setMode(model.kind === 'audio' ? 'speech' : model.kind); } }}>{model.name || model.id}<span className="ml-2 text-muted-foreground">{model.provider} · {model.served ? 'available' : 'Coming soon'}</span></button>)}
              </div>
              {selected ? <div className="flex flex-wrap gap-2">{availableModes.map(item => <Button key={item} type="button" variant={mode === item ? 'default' : 'outline'} size="sm" onClick={() => setMode(item)}>{modeLabel(item)}</Button>)}</div> : null}
              {mode === 'transcription' ? <div className="grid gap-2"><Label htmlFor="model-input">Audio file or recording *</Label><Input id="model-input" type="file" accept="audio/*" /><p className="text-xs text-muted-foreground">Upload an audio file. The file is sent as multipart data and is never placed in a URL.</p></div> : <div className="grid gap-4">{Object.entries(selected?.parameters ?? {}).map(([name, schema]) => <div className="grid gap-2" key={name}><Label htmlFor={`parameter-${name}`}>{schema.title ?? name}{schema.required ? ' *' : ''}</Label>{schema.enum?.length ? <div className="flex flex-wrap gap-2">{schema.enum.map(option => <Button key={option} type="button" size="sm" variant={String((name === 'input' || name === 'prompt') ? input : '') === option ? 'default' : 'outline'} onClick={() => { if (name === 'input' || name === 'prompt') setInput(option); }}>{option}</Button>)}</div> : schema.type === 'number' ? <Input id={`parameter-${name}`} type="number" min={schema.minimum} max={schema.maximum} defaultValue={schema.default as number | undefined} onChange={event => { if (name === 'input' || name === 'prompt') setInput(event.target.value); }} /> : schema.type === 'file' ? <Input id={`parameter-${name}`} type="file" accept="image/*,video/*,audio/*" /> : <Textarea id={`parameter-${name}`} rows={name === 'input' || name === 'prompt' ? 6 : 2} value={name === 'input' || name === 'prompt' ? input : String(schema.default ?? '')} onChange={event => { if (name === 'input' || name === 'prompt') setInput(event.target.value); }} placeholder={schema.description} />}</div>)}</div>}
              {(mode === 'speech' || mode === 'image' || mode === 'video') ? <p className="text-xs text-muted-foreground">Fields come from this model's provider schema. Image and video generation remain disabled until a compatible API route is available.</p> : null}
              <Button onClick={() => void run()} disabled={status === 'Running' || !selected || mode === 'image' || mode === 'video' || estimate === undefined}><Play />{status === 'Running' ? 'Running…' : mode === 'image' || mode === 'video' ? 'Coming soon' : estimate === undefined ? 'Run · no price set' : `Run ${formatUsd(estimate)}`}</Button>
              <p className="text-xs text-muted-foreground">The estimate uses published pricing only; unpriced models cannot be run from this page.</p>
              {selected && price ? <p className="text-xs text-muted-foreground">Published price: ${price.input}/1M input · ${price.output}/1M output</p> : <p className="text-xs text-muted-foreground">Price not published</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Use it in code</CardTitle><CardDescription>Equivalent API request for the selected model and current inputs.</CardDescription></CardHeader>
            <CardContent><pre className="overflow-auto rounded-lg border bg-muted/40 p-3 text-xs">{snippets?.curl ?? 'Choose a model to see the request.'}</pre></CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Output</CardTitle><CardDescription><span className="mr-2 rounded-full border px-2 py-0.5 text-xs">{status}</span>{elapsed ? `${elapsed}ms` : 'Ready'}</CardDescription></CardHeader>
            <CardContent className="grid gap-4">
              {output ? mode === 'speech' && output.startsWith('blob:') ? <audio className="w-full" controls src={output} /> : mode === 'image' && output.startsWith('http') ? <img className="max-h-96 w-full rounded-lg object-contain" src={output} alt="Generated result" /> : mode === 'video' && output.startsWith('http') ? <video className="max-h-96 w-full" controls src={output} /> : <pre className="min-h-40 whitespace-pre-wrap rounded-lg border bg-muted/40 p-4 text-sm">{output}</pre> : <div className="grid min-h-40 place-items-center rounded-lg border border-dashed text-sm text-muted-foreground">Run the selected model to see its output.</div>}
              {cost !== undefined ? <p className="text-sm">Cost: {formatUsd(cost)} · Runtime: {elapsed}ms</p> : null}
              {snippets ? <details open><summary className="flex cursor-pointer items-center gap-2 text-sm font-medium"><Code2 className="size-4" />API request · Use it in code</summary><div className="mt-3 grid gap-3 text-xs"><pre className="overflow-auto rounded border p-3">{snippets.curl}</pre><pre className="overflow-auto rounded border p-3">{snippets.python}</pre><pre className="overflow-auto rounded border p-3">{snippets.javascript}</pre><Button type="button" variant="outline" onClick={() => void navigator.clipboard?.writeText(snippets.curl)}><Copy />Copy curl</Button></div></details> : <p className="text-sm text-muted-foreground">Choose a model to see the equivalent API request.</p>}
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