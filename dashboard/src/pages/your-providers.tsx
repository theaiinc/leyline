import { useCallback, useEffect, useState } from 'react';
import { Plug, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api';
import { PageHeader } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

/**
 * dash "Your providers": the customer's own provider accounts (bring your own key), used only by their keys for the
 * models listed, billed by that provider (src/core/workspace-providers.ts). Keys are write-only: sent when added or
 * replaced, never shown again.
 */

type Kind = 'azure-openai' | 'openai-compatible' | 'anthropic' | 'wavespeed';
type ProviderView = {
  id: string; kind: Kind; label: string; baseUrl: string; deployment: string | null; apiVersion: string | null; models: string[];
  /** WaveSpeed: every model the key can use (models is then empty). */
  allModels?: boolean;
  enabled: boolean; createdAt: number; updatedAt: number; spendLine: string;
};
type TestResult = { ok: boolean; model: string; status: number | null; ms: number };
/** WaveSpeed's live model list per provider (GET /dashboard/me/providers/wavespeed-models); count null: not readable now. */
type WsSummary = { id: string; live: boolean; count: number | null };

const KINDS: Array<{ value: Kind; label: string; baseUrl: string; hint: string }> = [
  { value: 'azure-openai', label: 'Azure OpenAI', baseUrl: 'https://<resource>.openai.azure.com/openai/v1', hint: 'Each model is a deployment name on your resource.' },
  { value: 'openai-compatible', label: 'OpenAI-compatible', baseUrl: 'https://openrouter.ai/api/v1', hint: 'OpenAI, OpenRouter, LLM API or any gateway with /chat/completions.' },
  { value: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', hint: 'Claude models, with your Anthropic API key.' },
  { value: 'wavespeed', label: 'WaveSpeed (images and video)', baseUrl: 'https://api.wavespeed.ai/api/v3', hint: 'Every model your WaveSpeed account can use (images, video, audio) on /v1/images/generations and /v1/videos (and the Playground), with your WaveSpeed API key, billed by WaveSpeed.' },
];
/** Base URL and models are optional for these (a default base URL; WaveSpeed: every model the key can use). */
const OPTIONAL_URL: Kind[] = ['anthropic', 'wavespeed'];
const kindLabel = (k: Kind) => KINDS.find((x) => x.value === k)?.label ?? k;
const date = (t: number) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const splitModels = (text: string) => text.split(/[\n,]/).map((m) => m.trim()).filter(Boolean);

function fail(err: unknown) {
  toast.error(err instanceof Error ? err.message : String(err));
}

export function YourProvidersPage() {
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [kind, setKind] = useState<Kind>('openai-compatible');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [deployment, setDeployment] = useState('');
  const [models, setModels] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [replacing, setReplacing] = useState<{ id: string; key: string } | null>(null);

  const [wsLists, setWsLists] = useState<Record<string, WsSummary>>({});
  const [restricting, setRestricting] = useState<{ id: string; text: string } | null>(null);
  const load = useCallback(async () => {
    const out = await api<{ providers: ProviderView[] }>('/dashboard/me/providers');
    setProviders(out.providers);
    if (out.providers.some((p) => p.kind === 'wavespeed' && p.enabled)) {
      // The live count of each WaveSpeed provider's models (read with its key; cached a few minutes on the server).
      const ws = await api<{ providers: WsSummary[] }>('/dashboard/me/providers/wavespeed-models').catch(() => ({ providers: [] as WsSummary[] }));
      setWsLists(Object.fromEntries(ws.providers.map((p) => [p.id, p])));
    }
  }, []);
  useEffect(() => { void load().catch(fail); }, [load]);

  const spec = KINDS.find((k) => k.value === kind)!;
  async function add() {
    setBusy('add');
    try {
      await api('/dashboard/me/providers', {
        method: 'POST',
        body: {
          kind, label, apiKey,
          ...(baseUrl.trim() ? { baseUrl } : {}),
          ...(kind === 'azure-openai' && deployment.trim() ? { deployment } : {}),
          ...(models.trim() ? { models: splitModels(models) } : {}),
        },
      });
      toast.success(`Added "${label}".`);
      setLabel(''); setBaseUrl(''); setDeployment(''); setModels(''); setApiKey('');
      await load();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }
  async function test(p: ProviderView) {
    setBusy(p.id);
    try {
      const result = await api<TestResult>(`/dashboard/me/providers/${p.id}/test`, { method: 'POST', body: {} });
      setTests((t) => ({ ...t, [p.id]: result }));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }
  async function update(p: ProviderView, body: Record<string, unknown>, done: string) {
    setBusy(p.id);
    try {
      await api(`/dashboard/me/providers/${p.id}`, { method: 'PATCH', body });
      toast.success(done);
      await load();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }
  async function remove(p: ProviderView) {
    if (!window.confirm(`Remove "${p.label}"? Its key is deleted, and its models stop working with your keys.`)) return;
    setBusy(p.id);
    try {
      await api(`/dashboard/me/providers/${p.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  const canAdd = label.trim() && apiKey.trim() && (OPTIONAL_URL.includes(kind) || baseUrl.trim()) && (models.trim() || kind === 'wavespeed' || (kind === 'azure-openai' && deployment.trim()));
  return (<>
    <PageHeader title="Your providers" description="Your own provider accounts, used only by your keys. Requests to them are billed by that provider, not by Valefront." />
    <Card className="mb-4 gap-4">
      <CardHeader>
        <CardTitle>Add a provider</CardTitle>
        <CardDescription>Your keys can then ask for the models you list here. The API key is stored encrypted and never shown again.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:max-w-lg">
          <div className="grid gap-1">
            <Label htmlFor="byok-kind">Kind</Label>
            <select id="byok-kind" className="h-9 rounded-md border bg-background px-2 text-sm" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
            <p className="text-xs text-muted-foreground">{spec.hint}</p>
          </div>
          <div className="grid gap-1"><Label htmlFor="byok-label">Name</Label><Input id="byok-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. My Azure" maxLength={40} /></div>
          <div className="grid gap-1">
            <Label htmlFor="byok-url">Base URL{OPTIONAL_URL.includes(kind) ? <span className="font-normal text-muted-foreground"> (optional)</span> : null}</Label>
            <Input id="byok-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={spec.baseUrl} />
          </div>
          {kind === 'azure-openai' ? (
            <div className="grid gap-1"><Label htmlFor="byok-deployment">Deployment</Label><Input id="byok-deployment" value={deployment} onChange={(e) => setDeployment(e.target.value)} placeholder="e.g. gpt-5.5" /></div>
          ) : null}
          <div className="grid gap-1">
            <Label htmlFor="byok-models">Models{kind === 'azure-openai' ? <span className="font-normal text-muted-foreground"> (default: the deployment)</span> : kind === 'wavespeed' ? <span className="font-normal text-muted-foreground"> (optional)</span> : null}</Label>
            <Textarea id="byok-models" value={models} onChange={(e) => setModels(e.target.value)} placeholder={kind === 'wavespeed' ? 'Leave empty for all models your WaveSpeed account can use, or one model id per line to allow only those (e.g. wavespeed-ai/flux-dev)' : 'One model id per line'} rows={3} />
            {kind === 'wavespeed' ? <p className="text-xs text-muted-foreground">Empty: every model WaveSpeed lists for your key, including new ones as WaveSpeed adds them.</p> : null}
          </div>
          <div className="grid gap-1"><Label htmlFor="byok-key">API key</Label><Input id="byok-key" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} /></div>
          <div><Button disabled={!canAdd || busy === 'add'} onClick={add}><Plus />Add provider</Button></div>
        </div>
      </CardContent>
    </Card>
    <Card className="mb-4 gap-4">
      <CardHeader>
        <CardTitle>Your providers</CardTitle>
        <CardDescription>A model listed here goes to your provider, even if Valefront also offers it. Usage shows on Spending as its own line, at no charge.</CardDescription>
      </CardHeader>
      <CardContent>
        {!providers ? <Skeleton className="h-16" /> : providers.length === 0 ? <p className="text-sm text-muted-foreground">No providers yet.</p> : (
          <div className="grid gap-2">
            {providers.map((p) => {
              const result = tests[p.id];
              return (
                <div key={p.id} className="grid gap-3 rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 font-medium"><Plug className="size-3.5" />{p.label}</div>
                      <div className="truncate text-xs text-muted-foreground" title={p.baseUrl}>{kindLabel(p.kind)} · <code>{p.baseUrl}</code> · added {date(p.createdAt)}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch id={`byok-on-${p.id}`} checked={p.enabled} disabled={busy === p.id} onCheckedChange={(on) => update(p, { enabled: on }, on ? `"${p.label}" is on.` : `"${p.label}" is off.`)} />
                      <Label htmlFor={`byok-on-${p.id}`} className="text-xs">{p.enabled ? 'On' : 'Off'}</Label>
                    </div>
                    <Button variant="outline" size="sm" disabled={busy === p.id} onClick={() => test(p)}>Test</Button>
                    <Button variant="outline" size="sm" disabled={busy === p.id} onClick={() => setReplacing({ id: p.id, key: '' })}>Replace key</Button>
                    <Button variant="outline" size="sm" disabled={busy === p.id} onClick={() => remove(p)}>Remove</Button>
                  </div>
                  {p.kind === 'wavespeed' ? (
                    <div className="grid gap-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        {p.allModels ? (
                          <span>All models your WaveSpeed account can use{wsLists[p.id]?.count != null ? ` (${wsLists[p.id]!.count})` : p.enabled ? ' (the list could not be read just now; any WaveSpeed model id still works)' : ''}</span>
                        ) : (
                          <span>Only these{wsLists[p.id]?.count != null ? ` (${wsLists[p.id]!.count} on WaveSpeed's list)` : ''}:</span>
                        )}
                        <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setRestricting({ id: p.id, text: p.models.join('\n') })}>{p.allModels ? 'Allow only some' : 'Edit'}</Button>
                        {!p.allModels ? <Button variant="link" size="sm" className="h-auto p-0 text-xs" disabled={busy === p.id} onClick={() => update(p, { models: 'all' }, `"${p.label}" serves all your WaveSpeed models.`)}>Use all models</Button> : null}
                      </div>
                      {!p.allModels ? <div className="flex flex-wrap gap-1.5">{p.models.map((m) => <code key={m} className="rounded bg-muted px-1.5 py-0.5 text-xs">{m}</code>)}</div> : null}
                      {restricting?.id === p.id ? (
                        <div className="grid gap-2 border-t pt-3">
                          <Label htmlFor={`byok-restrict-${p.id}`}>Models to allow (one per line; empty: all)</Label>
                          <Textarea id={`byok-restrict-${p.id}`} rows={3} value={restricting.text} onChange={(e) => setRestricting({ id: p.id, text: e.target.value })} placeholder="wavespeed-ai/flux-dev" />
                          <div className="flex gap-2">
                            <Button size="sm" disabled={busy === p.id} onClick={async () => { const list = splitModels(restricting.text); await update(p, { models: list.length ? list : 'all' }, list.length ? `"${p.label}" serves ${list.length} model${list.length === 1 ? '' : 's'}.` : `"${p.label}" serves all your WaveSpeed models.`); setRestricting(null); }}>Save</Button>
                            <Button size="sm" variant="ghost" onClick={() => setRestricting(null)}>Cancel</Button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : <div className="flex flex-wrap gap-1.5">{p.models.map((m) => <code key={m} className="rounded bg-muted px-1.5 py-0.5 text-xs">{m}</code>)}</div>}
                  {result ? (
                    <p className={result.ok ? 'text-xs text-emerald-600 dark:text-emerald-400' : 'text-xs text-destructive'}>
                      {result.ok ? (p.kind === 'wavespeed' ? `Works: the key reads your WaveSpeed balance (${result.ms} ms; nothing generated).` : `Works: ${result.model} answered in ${result.ms} ms.`) : `Failed for ${result.model}${result.status ? ` (HTTP ${result.status})` : ''}. Check the URL, the key and the model.`}
                    </p>
                  ) : null}
                  {replacing?.id === p.id ? (
                    <div className="flex flex-wrap items-end gap-2 border-t pt-3">
                      <div className="grid min-w-[16rem] flex-1 gap-1"><Label htmlFor={`byok-rekey-${p.id}`}>New API key</Label><Input id={`byok-rekey-${p.id}`} type="password" autoComplete="off" value={replacing.key} onChange={(e) => setReplacing({ id: p.id, key: e.target.value })} /></div>
                      <Button size="sm" disabled={!replacing.key.trim() || busy === p.id} onClick={async () => { await update(p, { apiKey: replacing.key }, `Replaced the key of "${p.label}".`); setReplacing(null); }}>Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setReplacing(null)}>Cancel</Button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  </>);
}
