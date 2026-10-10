import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Plus, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PageHeader, when } from '@/components/common';
import { api, type HostedSettings } from '@/api';
import type { Dashboard } from '@/hooks/use-dashboard';

type Row = { from: string; to: string };

export function OfferedPage({ d }: { d: Dashboard }) {
  const [settings, setSettings] = useState<HostedSettings | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const apply = (s: HostedSettings) => {
    setSettings(s);
    setModels(s.models);
    setRows(Object.entries(s.aliases).map(([from, to]) => ({ from, to })));
  };
  useEffect(() => {
    api<HostedSettings>('/admin/api/settings').then(apply).catch(error => toast.error(error instanceof Error ? error.message : 'Could not load settings'));
  }, []);

  // Every model the providers report, to pick from.
  const known = useMemo(() => [...new Set(d.stats.providers.flatMap(p => p.models.map(m => m.id)))].sort(), [d.stats.providers]);
  const aliases = Object.fromEntries(rows.filter(r => r.from.trim() && r.to.trim()).map(r => [r.from.trim(), r.to.trim()]));
  const dirty = settings !== null && (JSON.stringify(models) !== JSON.stringify(settings.models) || JSON.stringify(aliases) !== JSON.stringify(settings.aliases));

  function add(model: string) {
    const m = model.trim();
    if (m && !models.includes(m)) setModels([...models, m]);
    setDraft('');
  }

  function claudeAliases() {
    const strong = models.find(m => !m.includes('*')) ?? '';
    const fast = models.find(m => /flash|mini|haiku|small|lite/i.test(m)) ?? strong;
    const next = rows.filter(r => !r.from.startsWith('claude-'));
    next.push({ from: 'claude-opus-*', to: strong }, { from: 'claude-sonnet-*', to: strong }, { from: 'claude-haiku-*', to: fast });
    setRows(next);
  }

  async function save() {
    setSaving(true);
    try {
      apply(await api<HostedSettings>('/admin/api/settings', { method: 'PUT', body: { models, aliases } }));
      toast.success('Offered models saved.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  const unknownTargets = Object.values(aliases).filter(t => models.length && !models.some(m => m === t || (m.includes('*') && new RegExp(`^${m.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(t))));

  return (
    <>
      <PageHeader
        title="Offered models"
        description="What access keys can use. A key can be narrowed further on Access keys."
        actions={<Button onClick={save} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save changes'}</Button>}
      />
      {settings && !settings.saved ? <Alert className="mb-4"><AlertDescription>Showing the defaults from the server's environment. Saving here makes the dashboard the source from now on.</AlertDescription></Alert> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Models</CardTitle>
            <CardDescription>Model ids listed on <code className="font-mono text-xs">/v1/models</code> and allowed in requests. <code className="font-mono text-xs">*</code> matches anything. None: whatever the router can serve.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="flex flex-wrap gap-2">
              {models.length ? models.map(m => (
                <Badge key={m} variant="secondary" className="gap-1 py-1 pr-1 font-mono">
                  {m}
                  <button type="button" className="rounded-sm p-0.5 hover:bg-background" onClick={() => setModels(models.filter(x => x !== m))} aria-label={`Remove ${m}`}><X className="size-3" /></button>
                </Badge>
              )) : <span className="text-sm text-muted-foreground">Every model the router can serve.</span>}
            </div>
            <form className="flex gap-2" onSubmit={e => { e.preventDefault(); add(draft); }}>
              <Input value={draft} onChange={e => setDraft(e.target.value)} placeholder="Model id, e.g. gpt-5.5" list="known-models" aria-label="Add a model" />
              <datalist id="known-models">{known.map(m => <option key={m} value={m} />)}</datalist>
              <Button type="submit" variant="secondary" disabled={!draft.trim()}><Plus />Add</Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Aliases</CardTitle>
            <CardDescription>Map a requested model to one you offer. Claude Code asks for <code className="font-mono text-xs">claude-*</code> models, so alias those to what you want it to use.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {rows.map((row, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input className="font-mono text-xs" value={row.from} placeholder="claude-sonnet-*" aria-label="Requested model" onChange={e => setRows(rows.map((r, j) => (j === i ? { ...r, from: e.target.value } : r)))} />
                <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                <Input className="font-mono text-xs" value={row.to} placeholder="gpt-5.5" list="offered-models" aria-label="Model used" onChange={e => setRows(rows.map((r, j) => (j === i ? { ...r, to: e.target.value } : r)))} />
                <Button type="button" variant="ghost" size="icon" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove alias"><X /></Button>
              </div>
            ))}
            <datalist id="offered-models">{[...models.filter(m => !m.includes('*')), ...known].map(m => <option key={m} value={m} />)}</datalist>
            {unknownTargets.length ? <p className="text-xs text-warning">Not in the offered list: {unknownTargets.join(', ')}</p> : null}
          </CardContent>
          <CardFooter className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setRows([...rows, { from: '', to: '' }])}><Plus />Alias</Button>
            <Button type="button" variant="outline" size="sm" onClick={claudeAliases} disabled={!models.some(m => !m.includes('*'))}><Sparkles />Claude Code aliases</Button>
          </CardFooter>
        </Card>
      </div>
      {settings?.saved ? <p className="mt-4 text-xs text-muted-foreground">Last saved {when(settings.saved.at)}{settings.saved.by && settings.saved.by !== 'token' ? ` by ${settings.saved.by}` : ''}.</p> : null}
    </>
  );
}
