import { useMemo, useRef, useState } from 'react';
import { ChevronDown, Plus, Search, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * The Playground's parts for a workspace's own WaveSpeed (Your providers): a searchable model picker grouped by task
 * (there are hundreds), and a form built from the model's own request fields (WaveSpeed's GET /models schema), with
 * upload or URL for image, video and audio inputs, and an Advanced JSON box for anything else.
 */

export type WsField = { type?: string; description?: string; default?: unknown; enum?: unknown[]; minimum?: number; maximum?: number; items?: { type?: string }; title?: string };
export type WsSchema = { properties: Record<string, WsField>; required: string[] };
export type PickerModel = { id: string; name: string; provider: string; type?: string; byok?: boolean };

const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Fields we set ourselves, or that the main prompt box covers. */
const HIDDEN = new Set(['prompt', 'enable_sync_mode', 'enable_base64_output', 'webhook']);
/** A field that takes a file (image, images, mask_image, video, audio_url, reference_images, …). */
export const isFileField = (name: string) => /(^|_)(image|images|mask|video|videos|audio|audios|file|files|init_image|reference)(_url|_urls|s)?($|_)/i.test(name) || /_(image|video|audio)_?urls?$/i.test(name);
const fileAccept = (name: string) => (/video/i.test(name) ? 'video/*' : /audio/i.test(name) ? 'audio/*' : 'image/*');

function typeLabel(type: string | undefined): string {
  if (!type) return 'Other';
  return type.split('-').map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ');
}

/** A button showing the model, opening a search box with the models grouped by task (inline, so it works on a phone). */
export function ModelPicker({ models, value, onChange, allowCustom }: { models: PickerModel[]; value?: string; onChange: (id: string) => void; allowCustom?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const current = models.find((m) => m.id === value);
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hits = models.filter((m) => !needle || m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle) || (m.type ?? '').includes(needle));
    const by = new Map<string, PickerModel[]>();
    for (const m of hits) {
      const g = m.byok ? typeLabel(m.type) : 'Sold by Valefront';
      (by.get(g) ?? by.set(g, []).get(g)!).push(m);
    }
    return [...by.entries()].sort(([a], [b]) => (a === 'Sold by Valefront' ? -1 : b === 'Sold by Valefront' ? 1 : a.localeCompare(b)));
  }, [models, q]);
  const custom = allowCustom && /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/.test(q.trim()) && !models.some((m) => m.id === q.trim());
  const total = groups.reduce((n, [, l]) => n + l.length, 0);
  return (
    <div className="grid w-full gap-2 sm:w-auto">
      <Button variant="outline" className="h-8 w-full justify-between font-semibold sm:w-auto sm:min-w-64" aria-expanded={open} aria-label="Model" onClick={() => setOpen((o) => !o)}>
        <span className="truncate">{current?.name ?? value ?? 'Choose a model'}</span><ChevronDown className="opacity-60" />
      </Button>
      {open ? (
        <div className="grid w-full gap-2 rounded-lg border bg-background p-2 shadow-sm sm:w-[28rem]">
          <div className="relative">
            <Search className="absolute top-2.5 left-2 size-4 text-muted-foreground" />
            <Input autoFocus className="pl-8" placeholder={`Search ${models.length} models`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search models" />
          </div>
          <div className="max-h-80 overflow-y-auto">
            {custom ? (
              <button className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent" onClick={() => { onChange(q.trim()); setOpen(false); setQ(''); }}>
                Use <code>{q.trim()}</code> <span className="text-xs text-muted-foreground">(any WaveSpeed model id)</span>
              </button>
            ) : null}
            {groups.map(([group, list]) => (
              <div key={group} className="py-1">
                <div className="px-2 py-1 text-xs font-medium text-muted-foreground">{group} · {list.length}</div>
                {list.slice(0, 200).map((m) => (
                  <button key={m.id} onClick={() => { onChange(m.id); setOpen(false); setQ(''); }}
                    className={cn('grid w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent', m.id === value && 'bg-accent')}>
                    <span className="truncate">{m.name}</span>
                    {m.name !== m.id ? <span className="truncate text-xs text-muted-foreground">{m.id}</span> : null}
                  </button>
                ))}
                {list.length > 200 ? <p className="px-2 py-1 text-xs text-muted-foreground">{list.length - 200} more: search to narrow down.</p> : null}
              </div>
            ))}
            {total === 0 && !custom ? <p className="px-2 py-3 text-sm text-muted-foreground">No model matches.</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_FILE_BYTES) return reject(new Error(`${file.name} is over 20 MB; pass a URL instead.`));
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('Could not read the file'));
    r.readAsDataURL(file);
  });
}

/** One file input: a URL, or a file from this device (sent inline; Valefront uploads it to your WaveSpeed). */
function FileValue({ name, value, onChange, onError }: { name: string; value: string; onChange: (v: string) => void; onError: (msg: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const inline = value.startsWith('data:');
  return (
    <div className="grid gap-2">
      <div className="flex gap-2">
        <Input value={inline ? 'File from this device' : value} readOnly={inline} placeholder="https://… or upload" onChange={(e) => onChange(e.target.value)} aria-label={name} />
        <input ref={ref} type="file" accept={fileAccept(name)} className="hidden" onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          try { onChange(await readFile(f)); } catch (err) { onError(err instanceof Error ? err.message : String(err)); }
        }} />
        <Button type="button" variant="outline" size="icon" onClick={() => ref.current?.click()} aria-label={`Upload ${name}`}><Upload /></Button>
        {value ? <Button type="button" variant="ghost" size="icon" onClick={() => onChange('')} aria-label={`Clear ${name}`}><X /></Button> : null}
      </div>
      {value && fileAccept(name) === 'image/*' && (inline || /^https?:\/\//.test(value)) ? <img src={value} alt="" className="max-h-32 w-fit rounded border object-contain" /> : null}
    </div>
  );
}

const label = (name: string) => name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/**
 * The model's own fields. `values` holds only what the customer set (WaveSpeed applies its defaults to the rest,
 * shown as placeholders). Without a schema: an input image (for image-to-… models) and the Advanced JSON box.
 */
export function WaveSpeedFields({ schema, type, values, setValues, advanced, setAdvanced, onError }: {
  schema: WsSchema | null; type?: string; values: Record<string, unknown>; setValues: (v: Record<string, unknown>) => void;
  advanced: string; setAdvanced: (v: string) => void; onError: (msg: string) => void;
}) {
  const set = (k: string, v: unknown) => {
    const next = { ...values };
    if (v === '' || v === undefined || (Array.isArray(v) && v.length === 0)) delete next[k];
    else next[k] = v;
    setValues(next);
  };
  const entries = schema ? Object.entries(schema.properties).filter(([k]) => !HIDDEN.has(k)) : [];
  const needsImage = !schema && /^image-to-/.test(type ?? '');
  const advancedError = (() => {
    if (!advanced.trim()) return '';
    try {
      const v = JSON.parse(advanced);
      return v && typeof v === 'object' && !Array.isArray(v) ? '' : 'Advanced JSON must be an object, e.g. {"seed": 42}';
    } catch {
      return 'Advanced JSON is not valid JSON.';
    }
  })();
  return (
    <>
      {needsImage ? (
        <div className="grid gap-1.5"><Label>Image</Label><FileValue name="image" value={String(values.image ?? '')} onChange={(v) => set('image', v)} onError={onError} /></div>
      ) : null}
      {entries.map(([name, f]) => {
        const req = schema!.required.includes(name);
        const title = <Label htmlFor={`ws-${name}`} title={f.description}>{label(name)}{req ? ' *' : ''}</Label>;
        const hint = f.description ? <p className="text-xs text-muted-foreground">{f.description}</p> : null;
        const ph = f.default !== undefined ? `Default: ${typeof f.default === 'object' ? JSON.stringify(f.default) : String(f.default)}` : '';
        const v = values[name];
        if (Array.isArray(f.enum) && f.enum.length) {
          return (
            <div key={name} className="grid gap-1.5">{title}
              <select id={`ws-${name}`} className="h-9 rounded-md border bg-background px-2 text-sm" value={v === undefined ? '' : JSON.stringify(v)}
                onChange={(e) => set(name, e.target.value ? JSON.parse(e.target.value) : undefined)}>
                <option value="">{ph || 'Default'}</option>
                {f.enum.map((o) => <option key={JSON.stringify(o)} value={JSON.stringify(o)}>{String(o)}</option>)}
              </select>{hint}</div>
          );
        }
        if (f.type === 'boolean') {
          return (
            <label key={name} className="flex items-center gap-2 text-sm" title={f.description}>
              <select id={`ws-${name}`} className="h-8 rounded-md border bg-background px-2 text-sm" value={v === undefined ? '' : String(v)} onChange={(e) => set(name, e.target.value === '' ? undefined : e.target.value === 'true')}>
                <option value="">{f.default !== undefined ? `Default (${String(f.default)})` : 'Default'}</option><option value="true">On</option><option value="false">Off</option>
              </select>
              {label(name)}{req ? ' *' : ''}
            </label>
          );
        }
        if (f.type === 'integer' || f.type === 'number') {
          return (
            <div key={name} className="grid gap-1.5">{title}
              <Input id={`ws-${name}`} type="number" inputMode="decimal" step={f.type === 'integer' ? 1 : 'any'} min={f.minimum} max={f.maximum} placeholder={ph}
                value={v === undefined ? '' : String(v)} onChange={(e) => set(name, e.target.value === '' ? undefined : Number(e.target.value))} />{hint}</div>
          );
        }
        if (isFileField(name) && (f.type === 'array' || /s$/.test(name)) && f.type !== 'string') {
          const list = Array.isArray(v) ? (v as string[]) : [];
          return (
            <div key={name} className="grid gap-1.5">{title}
              {list.map((item, i) => <FileValue key={i} name={name} value={item} onChange={(nv) => set(name, nv ? list.map((x, j) => (j === i ? nv : x)) : list.filter((_, j) => j !== i))} onError={onError} />)}
              <div><Button type="button" variant="outline" size="sm" onClick={() => set(name, [...list, ''])}><Plus />Add</Button></div>{hint}</div>
          );
        }
        if (isFileField(name)) {
          return <div key={name} className="grid gap-1.5">{title}<FileValue name={name} value={String(v ?? '')} onChange={(nv) => set(name, nv)} onError={onError} />{hint}</div>;
        }
        if (f.type === 'string' || f.type === undefined) {
          const long = /prompt|text|lyrics/i.test(name);
          return (
            <div key={name} className="grid gap-1.5">{title}
              {long ? <Textarea id={`ws-${name}`} rows={2} placeholder={ph} value={String(v ?? '')} onChange={(e) => set(name, e.target.value)} />
                : <Input id={`ws-${name}`} placeholder={ph} value={String(v ?? '')} onChange={(e) => set(name, e.target.value)} />}{hint}</div>
          );
        }
        return <p key={name} className="text-xs text-muted-foreground"><code>{name}</code> ({f.type}): set it in Advanced JSON.</p>;
      })}
      <details className="grid gap-1.5" open={!schema && !needsImage ? true : undefined}>
        <summary className="cursor-pointer text-sm font-medium">Advanced JSON</summary>
        <Textarea rows={4} className="mt-1.5 font-mono text-xs" placeholder={'{"seed": 42}'} value={advanced} onChange={(e) => setAdvanced(e.target.value)} aria-label="Advanced JSON" />
        <p className={cn('text-xs', advancedError ? 'text-destructive' : 'text-muted-foreground')}>{advancedError || "Any of the model's fields, sent to WaveSpeed as they are (over the ones above)."}</p>
      </details>
    </>
  );
}

/** The request body for a WaveSpeed model: prompt, the fields set, then Advanced JSON over them (invalid JSON: ignored). */
export function wavespeedBody(model: string, prompt: string, values: Record<string, unknown>, advanced: string): Record<string, unknown> {
  let extra: Record<string, unknown> = {};
  try {
    const v = advanced.trim() ? JSON.parse(advanced) : {};
    if (v && typeof v === 'object' && !Array.isArray(v)) extra = v;
  } catch {
    // shown under the box; not sent
  }
  const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '' && !(Array.isArray(v) && v.every((x) => x === ''))).map(([k, v]) => [k, Array.isArray(v) ? v.filter((x) => x !== '') : v]));
  return { model, ...(prompt.trim() ? { prompt } : {}), ...clean, ...extra };
}

/** What a generated file is, by its URL: video, audio, or an image. */
export function outputKind(url: string): 'video' | 'audio' | 'image' {
  const path = url.split('?')[0]!.toLowerCase();
  if (/^data:video\//.test(url) || /\.(mp4|webm|mov|m4v)$/.test(path)) return 'video';
  if (/^data:audio\//.test(url) || /\.(mp3|wav|ogg|m4a|flac|aac)$/.test(path)) return 'audio';
  return 'image';
}
