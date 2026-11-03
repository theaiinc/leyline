import { useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, Code2, Copy, Search, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { apiUrl } from '@/api';
import { servableModels, filterServableModels, getServableModel, type ModelCapability, type ModelCategory } from '@/modelCatalog';

type ModelsPageProps = { route: string; go: (page: string) => void };

const categories: Array<{ value: ModelCategory | 'all'; label: string }> = [
  { value: 'all', label: 'All types' },
  { value: 'chat', label: 'Chat / text' },
  { value: 'image', label: 'Image' },
  { value: 'video', label: 'Video' },
  { value: 'audio', label: 'Audio / speech' },
  { value: 'embeddings', label: 'Embeddings' },
  { value: '3d', label: '3D' },
];

function Explorer({ go }: { go: (page: string) => void }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ModelCategory | 'all'>('all');
  const [provider, setProvider] = useState('all');
  const [freeOnly, setFreeOnly] = useState(false);
  const [capability, setCapability] = useState<ModelCapability | 'all'>('all');
  const providers = [...new Set(servableModels.filter(m => m.configured).map(m => m.provider))];
  const models = useMemo(() => {
    const selectedCapability: ModelCapability | undefined = capability === ('all' as ModelCapability | 'all') ? undefined : capability;
    return filterServableModels(
      servableModels.filter(m =>
        m.configured &&
        (category === 'all' || m.category === category) &&
        (provider === 'all' || m.provider === provider) &&
        (!selectedCapability || m.capabilities?.includes(selectedCapability)) &&
        (!freeOnly || m.freeTier),
      ),
    query,
  ), [capability, category, freeOnly, provider, query]);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-primary">Valefront models</p>
        <h1 className="text-3xl font-semibold tracking-tight">Choose a model</h1>
        <p className="mt-1 text-muted-foreground">Explore models that are configured and currently available through your Leyline router.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_10rem_10rem_auto]">
        <div className="relative"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input className="pl-9" placeholder="Search models" value={query} onChange={e => setQuery(e.target.value)} /></div>
        <select className="h-10 rounded-md border bg-background px-3 text-sm" value={category} onChange={e => setCategory(e.target.value as ModelCategory | 'all')}>{categories.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select>
        <select className="h-10 rounded-md border bg-background px-3 text-sm" value={provider} onChange={e => setProvider(e.target.value)}><option value="all">All providers</option>{providers.map(p => <option key={p} value={p}>{p}</option>)}</select>
        <select className="h-10 rounded-md border bg-background px-3 text-sm" value={capability} onChange={e => setCapability(e.target.value as ModelCapability | 'all')}><option value="all">All capabilities</option><option value="vision">Vision</option><option value="tools">Tools</option><option value="free-tier">Free tier</option></select>
        <Button variant={freeOnly ? 'default' : 'outline'} onClick={() => setFreeOnly(v => !v)}>Free tier</Button>
      </div>
      <p className="text-sm text-muted-foreground">{models.length} available model{models.length === 1 ? '' : 's'}</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {models.map(model => <Card key={model.id} className="flex flex-col transition-shadow hover:shadow-md">
          <CardHeader><div className="flex items-start justify-between gap-3"><div><CardTitle className="text-lg">{model.name}</CardTitle><CardDescription>{model.provider} · {model.id}</CardDescription></div><Badge variant="secondary">{model.category}</Badge></div></CardHeader>
          <CardContent className="flex flex-1 flex-col gap-4"><p className="text-sm text-muted-foreground">{model.description}</p><div className="mt-auto flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>{model.pricing.input !== undefined ? `$${model.pricing.input} ${model.pricing.unit}` : 'Usage priced'}</span>{model.freeTier ? <Badge variant="outline">Free tier</Badge> : null}</div><Button className="w-full justify-between" onClick={() => go(`models/${model.provider}/${encodeURIComponent(model.id)}`)}>Open playground <ChevronRight className="size-4" /></Button></CardContent>
        </Card>)}
      </div>
    </div>
  );
}

function Detail({ id, go }: { id: string; go: (page: string) => void }) {
  const model = getServableModel(decodeURIComponent(id));
  const [prompt, setPrompt] = useState('');
  const [system, setSystem] = useState('');
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<'playground' | 'api' | 'history'>('playground');
  const [history, setHistory] = useState<Array<{ prompt: string; output: string; createdAt: number }>>([]);
  const [copied, setCopied] = useState(false);
  if (!model) return <div className="space-y-4"><Button variant="ghost" onClick={() => go('models')}><ArrowLeft className="mr-2 size-4" />Models</Button><p>Model not found.</p></div>;
  const run = async () => {
    setRunning(true); setOutput('');
    try {
      const response = await fetch(apiUrl('/v1/chat/completions'), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: model.id, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }].filter(m => m.content), stream: false }) });
      const data = await response.json();
      const nextOutput = data.choices?.[0]?.message?.content || data.error?.message || 'No response';
      setOutput(nextOutput);
      setHistory(items => [{ prompt, output: nextOutput, createdAt: Date.now() }, ...items].slice(0, 20));
    } catch (error) { setOutput(error instanceof Error ? error.message : 'Request failed'); } finally { setRunning(false); }
  };
  const snippet = `curl ${apiUrl('/v1/chat/completions')} \\
  -H "Authorization: Bearer YOUR_VALEFRONT_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify({ model: model.id, messages: [{ role: 'user', content: prompt || 'Your prompt' }] })}'`;
  return <div className="space-y-6">
    <Button variant="ghost" onClick={() => go('models')}><ArrowLeft className="mr-2 size-4" />Models</Button>
    <div>
  <p className="text-sm text-muted-foreground">{model.provider} / {model.category}</p>
  <div className="flex flex-wrap items-center gap-2"><h1 className="text-3xl font-semibold">{model.name}</h1><Button variant="ghost" size="icon" aria-label="Copy model id" onClick={() => { void navigator.clipboard?.writeText(model.id); setCopied(true); }}><Copy className="size-4" /></Button>{copied ? <span className="text-xs text-muted-foreground">Copied</span> : null}</div>
  <div className="mt-2 flex flex-wrap items-center gap-2"><p className="max-w-2xl text-muted-foreground">{model.description}</p><Button variant="outline" size="sm" onClick={() => window.alert(JSON.stringify(model.schema, null, 2))}>Schema</Button></div>
</div>
<div className="flex gap-1 overflow-x-auto border-b">{(['playground', 'api', 'history'] as const).map(value => <Button key={value} variant="ghost" className={tab === value ? 'border-b-2 border-primary rounded-none' : 'rounded-none'} onClick={() => setTab(value)}>{value === 'api' ? 'API' : value === 'history' ? 'History' : 'Playground'}</Button>)}</div>
{tab === 'history' ? <Card><CardHeader><CardTitle>Run history</CardTitle><CardDescription>Recent runs from this browser session.</CardDescription></CardHeader><CardContent className="space-y-3">{history.length ? history.map((item, index) => <button key={`${item.createdAt}-${index}`} className="block w-full rounded-md border p-3 text-left hover:bg-muted" onClick={() => { setPrompt(item.prompt); setOutput(item.output); }}><div className="flex justify-between gap-3 text-xs text-muted-foreground"><span>{new Date(item.createdAt).toLocaleString()}</span><span>Re-run input</span></div><p className="mt-2 line-clamp-2 text-sm">{item.prompt}</p></button>) : <p className="text-sm text-muted-foreground">No runs yet.</p>}</CardContent></Card> : tab === 'api' ? <Card><CardHeader><CardTitle>Call {model.id}</CardTitle><CardDescription>Your key is never embedded in this snippet.</CardDescription></CardHeader><CardContent><pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs">{snippet}</pre><Button className="mt-3" variant="outline" onClick={() => void navigator.clipboard?.writeText(snippet)}><Code2 className="mr-2 size-4" />Copy curl</Button></CardContent></Card> : <div className="grid gap-6 lg:grid-cols-2">
  <Card><CardHeader><CardTitle>Input</CardTitle><CardDescription>Schema-backed controls for this model.</CardDescription></CardHeader><CardContent className="space-y-4">{model.schema.fields.filter(f => f.name === 'system').map(f => <Textarea key={f.name} placeholder={f.label} value={system} onChange={e => setSystem(e.target.value)} />)}<Textarea className="min-h-40" placeholder="What should the model do?" value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void run(); }} /><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => { setPrompt(''); setSystem(''); setOutput(''); }}>Clear</Button><Button onClick={() => void run()} disabled={running || !prompt}>{running ? 'Running…' : <><Sparkles className="mr-2 size-4" />Generate</>}</Button></div></CardContent></Card>
  <Card><CardHeader><CardTitle>{running ? 'Running' : output ? 'Done' : 'Preview'}</CardTitle><CardDescription>{output ? 'Response from your session-owned run.' : 'Your output will appear here.'}</CardDescription></CardHeader><CardContent><div className="min-h-40 whitespace-pre-wrap rounded-md bg-muted p-4 text-sm">{output || 'Ready when you are.'}</div></CardContent></Card>
</div>}
  </div>;
}

export function ModelsPage({ route, go }: ModelsPageProps) {
  const parts = route.split('/');
  return parts.length >= 3 ? <Detail id={parts[2]} go={go} /> : <Explorer go={go} />;
}