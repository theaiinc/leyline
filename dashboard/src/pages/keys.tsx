import { useEffect, useState, type FormEvent } from 'react';
import { MoreHorizontal, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CodeBlock, EmptyState, PageHeader, SecretValue, ToneBadge, fmt, when } from '@/components/common';
import { api, type HostedSettings, type IssuedKey, type KeyCaps } from '@/api';
import type { Dashboard } from '@/hooks/use-dashboard';

function capText(c: KeyCaps): string {
  const parts: string[] = [];
  if (c.tokensPerMonth) parts.push(`${fmt(c.tokensPerMonth)} tok/mo`);
  if (c.requestsPerDay) parts.push(`${fmt(c.requestsPerDay)} req/day`);
  if (c.requestsPerMinute) parts.push(`${fmt(c.requestsPerMinute)} req/min`);
  if (c.models?.length) parts.push(c.models.join(', '));
  return parts.length ? parts.join(' · ') : 'No limits';
}

type CapForm = { tokensPerMonth: string; requestsPerDay: string; requestsPerMinute: string; models: string };
const toForm = (c: KeyCaps = {}): CapForm => ({
  tokensPerMonth: c.tokensPerMonth ? String(c.tokensPerMonth) : '',
  requestsPerDay: c.requestsPerDay ? String(c.requestsPerDay) : '',
  requestsPerMinute: c.requestsPerMinute ? String(c.requestsPerMinute) : '',
  models: (c.models ?? []).join(', '),
});
const fromForm = (f: CapForm): KeyCaps => {
  const n = (v: string) => (v.trim() ? Number(v) : null);
  const models = f.models.split(',').map(s => s.trim()).filter(Boolean);
  return { tokensPerMonth: n(f.tokensPerMonth), requestsPerDay: n(f.requestsPerDay), requestsPerMinute: n(f.requestsPerMinute), models: models.length ? models : null };
};

function CapFields({ value, onChange, offered }: { value: CapForm; onChange: (v: CapForm) => void; offered: string[] }) {
  const set = (k: keyof CapForm) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <div className="grid gap-1.5"><Label htmlFor="cap-tok">Tokens a month</Label><Input id="cap-tok" type="number" min={1} placeholder="No limit" value={value.tokensPerMonth} onChange={set('tokensPerMonth')} /></div>
      <div className="grid gap-1.5"><Label htmlFor="cap-day">Requests a day</Label><Input id="cap-day" type="number" min={1} placeholder="No limit" value={value.requestsPerDay} onChange={set('requestsPerDay')} /></div>
      <div className="grid gap-1.5"><Label htmlFor="cap-min">Requests a minute</Label><Input id="cap-min" type="number" min={1} placeholder="No limit" value={value.requestsPerMinute} onChange={set('requestsPerMinute')} /></div>
      <div className="grid gap-1.5 sm:col-span-3">
        <Label htmlFor="cap-models">Models</Label>
        <Input id="cap-models" placeholder={offered.length ? `All offered (${offered.join(', ')})` : 'All offered'} value={value.models} onChange={set('models')} />
        <p className="text-xs text-muted-foreground">Comma-separated; <code className="font-mono">*</code> matches anything, e.g. <code className="font-mono">gemini-*</code>. Empty: every offered model.</p>
      </div>
    </div>
  );
}

export function KeysPage({ d }: { d: Dashboard }) {
  const [keys, setKeys] = useState<IssuedKey[] | null>(null);
  const [settings, setSettings] = useState<HostedSettings | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<IssuedKey | null>(null);
  const [revoking, setRevoking] = useState<IssuedKey | null>(null);
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);

  const load = async () => {
    try {
      const [k, s] = await Promise.all([api<{ keys: IssuedKey[] }>('/admin/api/keys'), api<HostedSettings>('/admin/api/settings')]);
      setKeys(k.keys.sort((a, b) => b.createdAt - a.createdAt));
      setSettings(s);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load keys');
    }
  };
  useEffect(() => { void load(); }, []);

  const base = settings?.publicUrl || d.session?.publicUrl || window.location.origin;
  const offered = settings?.models ?? [];
  const visible = (keys ?? []).filter(k => showRevoked || !k.revokedAt);
  const revokedCount = (keys ?? []).filter(k => k.revokedAt).length;

  return (
    <>
      <PageHeader
        title="Access keys"
        description="Keys you hand out so people can use this Leyline from their coding agents, on your provider accounts. Each has its own caps; usage resets each calendar month (UTC)."
        actions={<Button onClick={() => setCreating(true)}><Plus />New key</Button>}
      />

      {keys === null ? null : visible.length === 0 ? (
        <EmptyState title="No keys yet">Create one, set its caps, and send it to the person it's for.</EmptyState>
      ) : (
        <Card className="py-0">
          <CardContent className="overflow-x-auto px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead className="min-w-48">This month</TableHead>
                  <TableHead>Caps</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead className="w-10 pr-4" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map(k => {
                  const tokens = (k.usage?.promptTokens ?? 0) + (k.usage?.completionTokens ?? 0);
                  const pct = k.caps.tokensPerMonth ? Math.min(100, Math.round((100 * tokens) / k.caps.tokensPerMonth)) : null;
                  return (
                    <TableRow key={k.id} className={k.revokedAt ? 'opacity-60' : undefined}>
                      <TableCell className="pl-4">
                        <div className="font-medium">{k.name}</div>
                        <div className="text-xs text-muted-foreground">Created {new Date(k.createdAt).toLocaleDateString()}</div>
                      </TableCell>
                      <TableCell>
                        <code className="font-mono text-xs whitespace-nowrap">{k.prefix}…</code>
                        <div className="mt-1">{k.revokedAt ? <ToneBadge tone="danger">Revoked</ToneBadge> : <ToneBadge tone="success">Active</ToneBadge>}</div>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm tabular-nums">{fmt(tokens)} tokens{pct !== null ? ` · ${pct}%` : ''}</div>
                        {pct !== null ? <Progress value={pct} className="mt-1.5 h-1.5" /> : null}
                        <div className="mt-1 text-xs text-muted-foreground tabular-nums">{fmt(k.usage?.requests ?? 0)} requests</div>
                      </TableCell>
                      <TableCell className="max-w-64 text-sm whitespace-normal">{capText(k.caps)}</TableCell>
                      <TableCell className="text-sm whitespace-nowrap text-muted-foreground">{when(k.lastUsedAt)}</TableCell>
                      <TableCell className="pr-4">
                        {k.revokedAt ? null : (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`Actions for ${k.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onSelect={() => setEditing(k)}>Edit caps</DropdownMenuItem>
                              <DropdownMenuItem variant="destructive" onSelect={() => setRevoking(k)}>Revoke</DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      {revokedCount ? <Button variant="link" className="mt-2 px-0" onClick={() => setShowRevoked(v => !v)}>{showRevoked ? 'Hide' : 'Show'} {revokedCount} revoked</Button> : null}

      <CreateDialog open={creating} onOpenChange={setCreating} offered={offered} onCreated={(key, name) => { setCreated({ key, name }); void load(); }} />
      <EditDialog k={editing} onClose={() => setEditing(null)} offered={offered} onSaved={load} />
      <RevokeDialog k={revoking} onClose={() => setRevoking(null)} onDone={load} />

      <Dialog open={Boolean(created)} onOpenChange={open => { if (!open) setCreated(null); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Key for {created?.name}</DialogTitle>
            <DialogDescription>Copy it now: it isn't stored and can't be shown again.</DialogDescription>
          </DialogHeader>
          {created ? (
            <div className="grid min-w-0 gap-4">
              <SecretValue label="Key" value={created.key} />
              <div className="grid gap-1.5"><Label>Claude Code</Label><CodeBlock>{`export ANTHROPIC_BASE_URL=${base}\nexport ANTHROPIC_AUTH_TOKEN=${created.key}\nclaude`}</CodeBlock></div>
              <div className="grid gap-1.5"><Label>Cursor, Codex, OpenCode, Cline, any OpenAI-compatible agent</Label><CodeBlock>{`Base URL:  ${base}/v1\nAPI key:   ${created.key}\nModel:     ${offered[0] ?? 'auto'}`}</CodeBlock></div>
            </div>
          ) : null}
          <DialogFooter><Button onClick={() => setCreated(null)}>Done</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CreateDialog({ open, onOpenChange, offered, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; offered: string[]; onCreated: (key: string, name: string) => void }) {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [caps, setCaps] = useState<CapForm>(toForm());
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setName(''); setNote(''); setCaps(toForm()); } }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const { key } = await api<{ key: string }>('/admin/api/keys', { method: 'POST', body: { name, note: note || undefined, caps: fromForm(caps) } });
      onOpenChange(false);
      onCreated(key, name);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not create the key');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader><DialogTitle>New access key</DialogTitle><DialogDescription>Who it's for, and how much they can use.</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-1.5"><Label htmlFor="key-name">Name</Label><Input id="key-name" required maxLength={80} placeholder="e.g. Minh (Claude Code)" value={name} onChange={e => setName(e.target.value)} /></div>
          <div className="grid gap-1.5"><Label htmlFor="key-note">Note (optional)</Label><Input id="key-note" maxLength={200} value={note} onChange={e => setNote(e.target.value)} /></div>
          <CapFields value={caps} onChange={setCaps} offered={offered} />
          <DialogFooter><Button type="submit" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create key'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({ k, onClose, offered, onSaved }: { k: IssuedKey | null; onClose: () => void; offered: string[]; onSaved: () => void }) {
  const [caps, setCaps] = useState<CapForm>(toForm());
  useEffect(() => { if (k) setCaps(toForm(k.caps)); }, [k?.id]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!k) return;
    try {
      await api(`/admin/api/keys/${k.id}`, { method: 'PATCH', body: { caps: fromForm(caps) } });
      toast.success(`Caps for ${k.name} saved.`);
      onClose();
      onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save caps');
    }
  }
  return (
    <Dialog open={Boolean(k)} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader><DialogTitle>Caps for {k?.name}</DialogTitle><DialogDescription>Takes effect within half a minute.</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          <CapFields value={caps} onChange={setCaps} offered={offered} />
          <DialogFooter><Button type="submit">Save caps</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RevokeDialog({ k, onClose, onDone }: { k: IssuedKey | null; onClose: () => void; onDone: () => void }) {
  async function revoke() {
    if (!k) return;
    try {
      await api(`/admin/api/keys/${k.id}`, { method: 'DELETE' });
      toast.success(`${k.name}'s key revoked.`);
      onClose();
      onDone();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not revoke the key');
    }
  }
  return (
    <Dialog open={Boolean(k)} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Revoke {k?.name}'s key?</DialogTitle><DialogDescription>Agents using it stop working at once. This can't be undone; make a new key instead.</DialogDescription></DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" onClick={revoke}>Revoke</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
