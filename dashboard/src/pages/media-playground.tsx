import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Download, Eraser, Image as ImageIcon, Loader2, Sparkles, Video } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, apiUrl } from '@/api';
import { cn } from '@/lib/utils';
import { ModelPicker, WaveSpeedFields, outputKind, wavespeedBody, type WsSchema } from './wavespeed-form';

/**
 * Image and video playground, laid out like a model page on WaveSpeed (Steve, 2026-11-06): the model with its price
 * and task, Input on the left (prompt + the model's parameters, Clear / Generate $price), Output on the right
 * (status, Preview / JSON), and this session's runs below. Models and prices come from /v1/pricing `media` (the
 * models Valefront sells, at the provider's official price).
 *
 * A workspace's own WaveSpeed (Your providers) adds every model its key can use (`wavespeed`): a searchable picker
 * grouped by task, and the model's own fields (its WaveSpeed schema; else Advanced JSON) instead of size/duration.
 *
 * `keyId` (the customer dash): requests go to the session-authenticated /dashboard/me/playground/… routes as that key
 * of the signed-in workspace; the key's secret never reaches the browser. Otherwise /v1 with `authHeaders`.
 */
export type MediaKind = 'image' | 'video';
export type MediaModel = {
  id: string; name: string; provider: string; kind: MediaKind; source?: string;
  /** Served by one of the workspace's own providers (Your providers): billed by that provider, not by Valefront. */
  byok?: boolean;
  /** A model of the workspace's own WaveSpeed (any model its key can use): its own fields, from its schema. */
  wavespeed?: boolean;
  /** WaveSpeed's task type (text-to-image, image-to-video, …). */
  type?: string;
  /** Offered on both the Image and Video tabs (a WaveSpeed model of another or unknown kind). */
  anyKind?: boolean;
  per_image?: number; per_image_above_pixels?: { pixels: number; per_image: number };
  per_1m_video_tokens?: number; per_1m_video_tokens_1080p?: number; max_resolution?: '720p' | '1080p';
  durations?: { min: number; max: number; default: number };
};
type Run = { id: string; model: string; kind: MediaKind; prompt: string; status: string; urls: string[]; cost?: number; ms: number; json: unknown };

const SIZES = [
  { id: '1024x1024', label: 'Square 1:1 · 1024×1024' },
  { id: '1536x1024', label: 'Landscape 3:2 · 1536×1024' },
  { id: '1024x1536', label: 'Portrait 2:3 · 1024×1536' },
  { id: '2048x2048', label: 'Square 1:1 · 2048×2048 (2K)' },
];
const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'];
const RES_PX: Record<string, [number, number]> = { '480p': [854, 480], '720p': [1280, 720], '1080p': [1920, 1080] };
const usd = (n: number) => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;
const SAMPLE: Record<MediaKind, string> = {
  image: 'A single green leaf on a white background, minimal studio photo, soft shadow',
  video: 'Gentle ocean waves at sunrise, slow camera pan along the shore, cinematic light',
};

/** Seedance bills by the finished video's tokens: about width × height × 24 fps × seconds / 1024. */
function estimateVideoTokens(resolution: string, seconds: number): number {
  const [w, h] = RES_PX[resolution] ?? RES_PX['720p']!;
  return Math.round((w * h * 24 * seconds) / 1024);
}

export function MediaPlayground({ kind, authHeaders = {}, keyId, extraModels = [], onAddCredit }: {
  kind: MediaKind; authHeaders?: Record<string, string>; keyId?: string;
  /** More models to offer: the workspace's own (WaveSpeed on Your providers), listed after Valefront's. */
  extraModels?: MediaModel[];
  /** Shown with a "no credit" refusal (402): the customer dash's Billing page. */
  onAddCredit?: () => void;
}) {
  const [models, setModels] = useState<MediaModel[]>([]);
  const [modelId, setModelId] = useState('');
  const [prompt, setPrompt] = useState(SAMPLE[kind]);
  const [size, setSize] = useState('1024x1024');
  const [n, setN] = useState(1);
  const [duration, setDuration] = useState(5);
  const [resolution, setResolution] = useState('720p');
  const [ratio, setRatio] = useState('16:9');
  const [tab, setTab] = useState<'playground' | 'api' | 'history'>('playground');
  const [view, setView] = useState<'preview' | 'json'>('preview');
  const [status, setStatus] = useState<'idle' | 'queued' | 'running' | 'succeeded' | 'failed'>('idle');
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [current, setCurrent] = useState<Run | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [copied, setCopied] = useState(false);
  const started = useRef(0);

  useEffect(() => {
    fetch(apiUrl('/v1/pricing'), { credentials: 'same-origin' }).then((r) => r.json()).then((d: { media?: MediaModel[] }) => setModels(d.media ?? [])).catch(() => undefined);
  }, []);
  const list = [...models, ...extraModels.filter((x) => !models.some((m) => m.id === x.id))].filter((m) => m.kind === kind || m.anyKind);
  const ownWaveSpeed = list.find((m) => m.wavespeed);
  // Start on the cheapest everyday model, not the priciest (a playground run is a real, charged request).
  const DEFAULT: Record<MediaKind, string> = { image: 'seedream-4-0-250828', video: 'seedance-1-0-pro-fast-251015' };
  // A WaveSpeed id typed in the picker that WaveSpeed's list doesn't have (or couldn't be read): still sent.
  const typed: MediaModel | undefined = ownWaveSpeed && modelId && !list.some((m) => m.id === modelId) && modelId.includes('/')
    ? { id: modelId, name: modelId, provider: ownWaveSpeed.provider, kind, byok: true, wavespeed: true } : undefined;
  const model = typed ?? list.find((m) => m.id === modelId) ?? list.find((m) => m.id === DEFAULT[kind]) ?? list[0];
  const ws = !!model?.wavespeed;
  const [schema, setSchema] = useState<WsSchema | null>(null);
  const [wsType, setWsType] = useState<string | undefined>(undefined);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [advanced, setAdvanced] = useState('');
  useEffect(() => {
    setSchema(null); setValues({}); setAdvanced(''); setWsType(model?.type);
    if (!model?.wavespeed || !keyId) return;
    let live = true;
    api<{ model: { schema?: WsSchema; type?: string } }>(`/dashboard/me/providers/wavespeed-models?model=${encodeURIComponent(model.id)}`)
      .then((out) => { if (live) { setSchema(out.model.schema ?? null); setWsType(out.model.type ?? model.type); } })
      .catch(() => undefined);
    return () => { live = false; };
  }, [model?.id, keyId]);
  const promptRequired = ws ? !!schema?.required.includes('prompt') : true;
  useEffect(() => {
    if (!model) return;
    if (model.id !== modelId) setModelId(model.id);
    if (model.durations) setDuration(model.durations.default);
    if (resolution === '1080p' && model.max_resolution !== '1080p') setResolution('720p');
  }, [model?.id]);
  useEffect(() => { setPrompt(SAMPLE[kind]); setCurrent(null); setStatus('idle'); setError(''); setModelId(''); }, [kind]);
  useEffect(() => {
    if (status !== 'queued' && status !== 'running') return;
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started.current) / 1000)), 500);
    return () => clearInterval(t);
  }, [status]);

  const price = useMemo(() => {
    if (!model) return null;
    if (model.byok) return { total: 0, note: `Billed by your ${model.provider.replace(/^BYOK:/, '')} account`, own: true };
    if (kind === 'image' && model.per_image !== undefined) {
      const [w, h] = size.split('x').map(Number);
      const each = model.per_image_above_pixels && w! * h! > model.per_image_above_pixels.pixels ? model.per_image_above_pixels.per_image : model.per_image;
      return { total: each * n, note: `${usd(each)} per image` };
    }
    if (kind === 'video' && model.per_1m_video_tokens !== undefined) {
      const rate = resolution === '1080p' && model.per_1m_video_tokens_1080p !== undefined ? model.per_1m_video_tokens_1080p : model.per_1m_video_tokens;
      const tokens = estimateVideoTokens(resolution, duration);
      return { total: (tokens * rate) / 1e6, note: `$${rate} per 1M video tokens · about ${tokens.toLocaleString()} tokens; charged on the actual tokens`, estimate: true };
    }
    return null;
  }, [model, kind, size, n, resolution, duration]);

  const body = ws && model ? wavespeedBody(model.id, prompt, values, advanced)
    : kind === 'image'
      ? { model: model?.id, prompt, size, n }
      : { model: model?.id, prompt, duration, resolution, ratio };
  const endpoint = kind === 'image' ? '/v1/images/generations' : '/v1/videos';
  const target = keyId
    ? { create: `/dashboard/me/playground/${kind === 'image' ? 'images' : 'videos'}`, poll: (id: string) => `/dashboard/me/playground/videos/${encodeURIComponent(id)}?keyId=${encodeURIComponent(keyId)}`, body: { ...body, keyId } }
    : { create: endpoint, poll: (id: string) => `/v1/videos/${encodeURIComponent(id)}`, body };
  const curl = `curl ${apiUrl(endpoint)} \\\n  -H "Authorization: Bearer $VALEFRONT_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(body)}'${kind === 'video' ? `\n\n# then poll until "status" is "succeeded":\ncurl ${apiUrl('/v1/videos/<id>')} -H "Authorization: Bearer $VALEFRONT_API_KEY"` : ''}`;

  async function generate() {
    if (!model || (promptRequired && !prompt.trim())) return;
    setError(''); setErrorCode(''); setView('preview'); setStatus('queued'); started.current = Date.now(); setElapsed(0);
    const headers = { 'Content-Type': 'application/json', ...authHeaders };
    try {
      const res = await fetch(apiUrl(target.create), { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify(target.body) });
      let data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorCode(typeof data?.error?.code === 'string' ? data.error.code : '');
        throw new Error(data?.error?.message || `Request failed (${res.status})`);
      }
      if (kind === 'video') {
        setStatus('running');
        for (let i = 0; i < 120 && !['succeeded', 'failed', 'cancelled', 'expired'].includes(data.status); i++) {
          await new Promise((r) => setTimeout(r, 4000));
          const poll = await fetch(apiUrl(target.poll(data.id)), { credentials: 'same-origin', headers: authHeaders });
          data = await poll.json();
          if (!poll.ok) throw new Error(data?.error?.message || 'Checking the video failed');
        }
        if (data.status !== 'succeeded') throw new Error(typeof data.error === 'string' ? data.error : `The video ${data.status || 'did not finish'}; nothing was charged.`);
      }
      const urls: string[] = kind === 'image'
        ? (data.data ?? []).map((d: { url?: string; b64_json?: string }) => d.url ?? (d.b64_json ? `data:image/png;base64,${d.b64_json}` : '')).filter(Boolean)
        : data.url ? [data.url] : [];
      const run: Run = { id: data.id ?? `img-${Date.now()}`, model: model.id, kind, prompt, status: 'succeeded', urls, cost: typeof data.cost === 'number' ? data.cost : Number(data.cost) || undefined, ms: Date.now() - started.current, json: data };
      setCurrent(run); setRuns((r) => [run, ...r].slice(0, 24)); setStatus('succeeded');
    } catch (err) {
      setStatus('failed'); setError(err instanceof Error ? err.message : String(err));
    }
  }

  const busy = status === 'queued' || status === 'running';
  const Icon = kind === 'image' ? ImageIcon : Video;
  return (
    <div className="grid gap-5">
      {/* model header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"><span>{model?.provider ?? '…'}</span><span>/</span>
            {ownWaveSpeed ? <ModelPicker models={list} value={model?.id} onChange={setModelId} allowCustom /> : (
              <Select value={model?.id ?? ''} onValueChange={setModelId}>
                <SelectTrigger className="h-8 w-auto min-w-56 font-semibold text-foreground" aria-label="Model"><SelectValue placeholder="Model" /></SelectTrigger>
                <SelectContent>{list.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}</SelectContent>
              </Select>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge variant="secondary"><Icon className="size-3" />{ws ? (wsType ? wsType.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : 'WaveSpeed model') : kind === 'image' ? 'Text to image' : 'Text to video'}</Badge>
            {price ? <Badge variant="outline">{price.note}</Badge> : null}
            {model?.source ? <a className="text-xs text-muted-foreground underline" href={model.source} target="_blank" rel="noreferrer">Official price</a> : null}
          </div>
        </div>
        <div className="flex rounded-lg border p-0.5" role="tablist">
          {(['playground', 'api', 'history'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
              className={cn('rounded-md px-3 py-1.5 text-sm capitalize', tab === t ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground')}>{t === 'api' ? 'API' : t}</button>
          ))}
        </div>
      </div>

      {tab === 'api' ? (
        <Card><CardHeader><CardTitle>Call it from your code</CardTitle></CardHeader><CardContent>
          <div className="mb-2 flex justify-end"><Button variant="outline" size="sm" onClick={() => { void navigator.clipboard.writeText(curl); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy'}</Button></div>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs leading-relaxed">{curl}</pre>
        </CardContent></Card>
      ) : tab === 'history' ? (
        <Card><CardHeader><CardTitle>This session</CardTitle></CardHeader><CardContent>
          {runs.length === 0 ? <p className="text-sm text-muted-foreground">Nothing generated yet.</p> : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {runs.map((r) => (
                <button key={r.id} onClick={() => { setCurrent(r); setTab('playground'); setStatus('succeeded'); }} className="overflow-hidden rounded-lg border text-left">
                  {outputKind(r.urls[0] ?? '') === 'image' ? <img src={r.urls[0]} alt="" className="aspect-square w-full object-cover" />
                    : outputKind(r.urls[0] ?? '') === 'audio' ? <div className="flex aspect-square w-full items-center justify-center bg-muted text-xs">Audio</div>
                      : <video src={r.urls[0]} className="aspect-video w-full object-cover" muted />}
                  <div className="p-2 text-xs"><div className="truncate font-medium">{r.model}</div><div className="text-muted-foreground">{r.cost !== undefined ? usd(r.cost) : '—'} · {(r.ms / 1000).toFixed(1)}s</div></div>
                </button>
              ))}
            </div>
          )}
        </CardContent></Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,26rem)_1fr]">
          {/* input */}
          <Card className="gap-4">
            <CardHeader><CardTitle>Input</CardTitle></CardHeader>
            <CardContent className="grid gap-4">
              {!ws || !schema || 'prompt' in schema.properties ? (
                <div className="grid gap-1.5"><Label htmlFor="mp-prompt">Prompt{promptRequired ? ' *' : ''}</Label>
                  <Textarea id="mp-prompt" rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe what you want" /></div>
              ) : null}
              {ws ? (
                <WaveSpeedFields schema={schema} type={wsType} values={values} setValues={setValues} advanced={advanced} setAdvanced={setAdvanced} onError={setError} />
              ) : kind === 'image' ? (
                <>
                  <div className="grid gap-1.5"><Label>Size</Label>
                    <Select value={size} onValueChange={setSize}><SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{SIZES.map((s) => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}</SelectContent></Select></div>
                  <div className="grid gap-1.5"><Label>Number of images · {n}</Label>
                    <input type="range" min={1} max={4} value={n} onChange={(e) => setN(Number(e.target.value))} className="accent-primary" /></div>
                </>
              ) : (
                <>
                  <div className="grid gap-1.5"><Label>Duration · {duration}s</Label>
                    <input type="range" min={model?.durations?.min ?? 2} max={model?.durations?.max ?? 12} value={duration} onChange={(e) => setDuration(Number(e.target.value))} className="accent-primary" /></div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="grid gap-1.5"><Label>Resolution</Label>
                      <Select value={resolution} onValueChange={setResolution}><SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>{['480p', '720p', ...(model?.max_resolution === '1080p' ? ['1080p'] : [])].map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent></Select></div>
                    <div className="grid gap-1.5"><Label>Aspect ratio</Label>
                      <Select value={ratio} onValueChange={setRatio}><SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>{RATIOS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent></Select></div>
                  </div>
                </>
              )}
              <div className="flex gap-2 pt-1">
                <Button variant="outline" onClick={() => { setPrompt(''); setCurrent(null); setStatus('idle'); setError(''); setErrorCode(''); }}><Eraser />Clear</Button>
                <Button className="flex-1" disabled={busy || !model || (promptRequired && !prompt.trim())} onClick={() => void generate()}>
                  {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}{busy ? 'Generating…' : `Generate${price && !price.own ? ` ${price.estimate ? '≈ ' : ''}${usd(price.total)}` : ''}`}
                </Button>
              </div>
              {kind === 'video' && !ws ? <p className="text-xs text-muted-foreground">Videos usually take 30 seconds to a few minutes. You're charged only when one is finished, by its actual tokens.</p> : null}
              {ws ? <p className="text-xs text-muted-foreground">Runs on your WaveSpeed account, billed by WaveSpeed; Valefront charges nothing. {kind === 'video' ? 'Runs as a job: usually 30 seconds to a few minutes.' : ''}</p> : null}
            </CardContent>
          </Card>

          {/* output */}
          <Card className="gap-3">
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm">
                <span className={cn('size-2 rounded-full', status === 'succeeded' ? 'bg-success' : status === 'failed' ? 'bg-destructive' : busy ? 'animate-pulse bg-warning' : 'bg-muted-foreground/50')} />
                <span className="capitalize">{status}</span>
                {busy ? <span className="tabular-nums text-muted-foreground">{elapsed}s</span> : null}
                {current && status === 'succeeded' ? <span className="text-muted-foreground">· {(current.ms / 1000).toFixed(1)}s{current.cost !== undefined ? ` · charged ${usd(current.cost)}` : ''}</span> : null}
              </div>
              <div className="flex rounded-md border p-0.5 text-xs">
                {(['preview', 'json'] as const).map((v) => <button key={v} onClick={() => setView(v)} className={cn('rounded px-2 py-1 capitalize', view === v ? 'bg-accent text-accent-foreground' : 'text-muted-foreground')}>{v === 'json' ? 'JSON' : 'Preview'}</button>)}
              </div>
            </CardHeader>
            <CardContent>
              {error ? (
                <div className="mb-3 grid gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  <p>{error}</p>
                  {errorCode === 'insufficient_credit' && onAddCredit ? <div><Button size="sm" onClick={onAddCredit}>Add credit</Button></div> : null}
                </div>
              ) : null}
              {view === 'json' ? <pre className="max-h-[32rem] overflow-auto rounded-md bg-muted p-3 text-xs">{current ? JSON.stringify(current.json, null, 2) : '{}'}</pre>
                : current && current.urls.length ? (
                  <div className={cn('grid gap-3', current.urls.length > 1 && 'sm:grid-cols-2')}>
                    {current.urls.map((u) => (
                      <div key={u} className="group relative overflow-hidden rounded-lg border bg-muted/30">
                        {outputKind(u) === 'image' ? <img src={u} alt="Generated" className="w-full object-contain" />
                          : outputKind(u) === 'audio' ? <audio src={u} controls className="w-full p-3" />
                            : <video src={u} controls autoPlay loop className="w-full" />}
                        <a href={u} target="_blank" rel="noreferrer" download className="absolute top-2 right-2 rounded-md bg-background/80 p-1.5 opacity-0 transition group-hover:opacity-100" aria-label="Open or download"><Download className="size-4" /></a>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex aspect-video flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-sm text-muted-foreground">
                    {busy ? <><Loader2 className="size-6 animate-spin" />{status === 'queued' ? 'Starting…' : 'Generating…'}</> : <><Icon className="size-6" />Your {kind} will appear here</>}
                  </div>
                )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
