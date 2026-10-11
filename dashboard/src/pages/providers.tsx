import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { PageHeader, ProviderDot, ToneBadge } from '@/components/common';
import { api } from '@/api';
import { localKey, localModeKey, localRuntimeKey, type Dashboard } from '@/hooks/use-dashboard';
import { cn } from '@/lib/utils';
import {
  familyOf,
  type InstanceFamily,
  type PersistenceMode,
  providerDescription,
  providerStatusLabel,
  providerTone,
  sourceLabel,
} from '@/normalization';

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function ProvidersPage({ d }: { d: Dashboard }) {
  const { status, families, session, storeLabel, localStorageAvailable } = d;
  const hosted = Boolean(session?.hosted);
  const providers = useMemo(() => [...(status?.providers ?? [])]
    .sort((a, b) => familyOf(a.name, a.family).localeCompare(familyOf(b.name, b.family)) || a.name.localeCompare(b.name)), [status]);
  const [selected, setSelected] = useState('');
  const active = providers.find(p => p.name === selected) ?? providers.find(p => p.name === status?.routing?.fixedProvider) ?? providers[0];
  const persistence = status?.persistence;
  const keychainAvailable = Boolean(persistence?.modes.keychain.available);
  const arcanaAvailable = Boolean(active?.arcanaAvailable);

  const savedMode: PersistenceMode = active
    ? ((localStorageAvailable && !hosted ? window.localStorage.getItem(localModeKey(active.name)) as PersistenceMode | null : null)
      || (active.source === 'arcana' ? 'arcana'
        : active.configured ? (active.source === 'memory' ? 'memory' : 'keychain')
          : active.arcanaReference ? 'arcana'
            : keychainAvailable ? 'keychain'
              : arcanaAvailable ? 'arcana'
                : hosted ? 'memory' : 'localStorage'))
    : 'keychain';

  const [mode, setMode] = useState<PersistenceMode>('keychain');
  const [apiKey, setApiKey] = useState('');
  const [arcanaReference, setArcanaReference] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');

  useEffect(() => {
    if (!active) return;
    setMode(savedMode);
    setApiKey('');
    setArcanaReference(active.arcanaReference || '');
    setBaseUrl(active.runtimeConfig?.baseUrl || '');
    setModel(active.runtimeConfig?.model || active.defaultModel || '');
  }, [active?.name, persistence?.modes.keychain.available, persistence?.modes.arcana.available]);

  const keyDirty = Boolean(active && (apiKey.trim() || mode !== savedMode || (mode === 'arcana' && arcanaReference.trim() !== (active.arcanaReference || ''))));
  const runtimeDirty = Boolean(active?.runtimeConfigurable && (baseUrl.trim() !== (active.runtimeConfig?.baseUrl || '') || model.trim() !== (active.runtimeConfig?.model || active.defaultModel || '')));
  const isAzure = active ? familyOf(active.name, active.family) === 'AzureOpenAI' : false;

  async function saveKey(event: FormEvent) {
    event.preventDefault();
    if (!active) return;
    if (mode !== 'arcana' && !apiKey.trim()) return void toast.error('Paste a key before saving. A blank field never clears a key.');
    try {
      const data = await api<{ source?: string }>('/dashboard/api-keys', {
        method: 'POST',
        body: { provider: active.name, apiKey: mode === 'arcana' ? undefined : apiKey, arcanaReference: mode === 'arcana' ? arcanaReference : undefined, persistence: mode },
      });
      if (!hosted && localStorageAvailable) {
        if (mode === 'localStorage') {
          window.localStorage.setItem(localKey(active.name), apiKey);
          window.localStorage.setItem(localModeKey(active.name), 'localStorage');
        } else if (mode !== 'arcana') {
          window.localStorage.removeItem(localKey(active.name));
          window.localStorage.setItem(localModeKey(active.name), mode);
        }
      }
      setApiKey('');
      toast.success(`${active.name} key saved (${sourceLabel(data.source, storeLabel)}).`);
      await Promise.all([d.refreshStatus(), d.refreshStats()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save the key');
    }
  }

  async function clearKey() {
    if (!active || !window.confirm(`Clear the ${active.name} key? Runtime URL and model settings are kept.`)) return;
    try {
      await api(`/dashboard/api-keys/${encodeURIComponent(active.name)}`, { method: 'DELETE' });
      if (localStorageAvailable) {
        window.localStorage.removeItem(localKey(active.name));
        window.localStorage.removeItem(localModeKey(active.name));
      }
      toast.success(`${active.name} key cleared.`);
      await Promise.all([d.refreshStatus(), d.refreshStats()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not clear the key');
    }
  }

  async function saveRuntime(event: FormEvent) {
    event.preventDefault();
    if (!active) return;
    try {
      await api('/dashboard/api-keys', { method: 'POST', body: { provider: active.name, baseUrl, model } });
      if (!hosted && localStorageAvailable) window.localStorage.setItem(localRuntimeKey(active.name), JSON.stringify({ baseUrl, model }));
      toast.success(`${active.name} runtime settings saved.`);
      await Promise.all([d.refreshStatus(), d.refreshStats()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save runtime settings');
    }
  }

  async function removeInstance(family: InstanceFamily, id: string) {
    if (!window.confirm(`Remove this ${family.displayName} instance? Its saved key and settings are deleted.`)) return;
    try {
      await api(`/dashboard/provider-instances/${encodeURIComponent(family.family)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast.success(`${family.displayName} instance removed.`);
      if (selected === `${family.baseName}:${id}`) setSelected('');
      await d.refreshAll();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not remove the instance');
    }
  }

  const modes: Array<{ value: PersistenceMode; label: string; hint: string; available: boolean; show: boolean }> = [
    { value: 'keychain', label: storeLabel, hint: keychainAvailable ? (hosted ? 'Kept in the cloud project; survives restarts and deploys.' : 'Most secure server-side option on macOS.') : 'Unavailable on this server.', available: keychainAvailable, show: true },
    { value: 'arcana', label: 'Arcana', hint: arcanaAvailable ? 'Resolve this key from an Arcana reference.' : 'No Arcana reference is available for this provider.', available: arcanaAvailable, show: !hosted || arcanaAvailable },
    { value: 'localStorage', label: 'Browser localStorage', hint: 'Browser-local fallback; re-sent to Leyline when this dashboard opens.', available: localStorageAvailable, show: !hosted },
    { value: 'memory', label: 'Server memory', hint: hosted ? 'Until this instance restarts (deploys and scale-downs restart it).' : 'Until this server process exits.', available: true, show: true },
  ];

  return (
    <>
      <PageHeader
        title="Providers"
        description={hosted ? 'The provider accounts this Leyline uses. Everyone with an access key is served from these.' : 'Provider keys, runtime settings, and extra endpoints.'}
        actions={families.map(family => <AddInstanceDialog key={family.family} family={family} d={d} onAdded={setSelected} />)}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {providers.map(provider => {
          const s = providerStatusLabel(provider);
          const family = families.find(f => f.family === (provider.family || provider.name));
          const removable = Boolean(family && provider.name !== family.baseName);
          return (
            <button
              key={provider.name}
              type="button"
              onClick={() => setSelected(provider.name)}
              className={cn('flex flex-col gap-2 rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent/50', active?.name === provider.name && 'border-primary ring-1 ring-primary')}
            >
              <div className="flex w-full items-center gap-2">
                <ProviderDot tone={providerTone(provider.name, provider.family)} />
                <span className="truncate font-medium">{provider.label || provider.name}</span>
                <ToneBadge tone={s.tone} className="ml-auto">{s.label}</ToneBadge>
              </div>
              <p className="text-xs text-muted-foreground">{providerDescription(provider.name, provider.family) || sourceLabel(provider.source, storeLabel)}</p>
              {removable && family ? (
                <span
                  role="button"
                  tabIndex={0}
                  className="inline-flex w-fit items-center gap-1 text-xs text-destructive hover:underline"
                  onClick={event => { event.stopPropagation(); void removeInstance(family, provider.name.slice(family.baseName.length + 1)); }}
                  onKeyDown={event => { if (event.key === 'Enter') { event.stopPropagation(); void removeInstance(family, provider.name.slice(family.baseName.length + 1)); } }}
                >
                  <Trash2 className="size-3" />Remove
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {active ? (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{active.label || active.name} key</CardTitle>
              <CardDescription>Where this provider's API key lives.</CardDescription>
              <CardAction><ToneBadge tone={active.persisted ? 'success' : active.configured ? 'warning' : 'danger'}>{sourceLabel(active.source, storeLabel)}</ToneBadge></CardAction>
            </CardHeader>
            <CardContent>
              <form onSubmit={saveKey} className="grid gap-4">
                {active.name === 'OpenAI' ? <Alert><AlertDescription>OpenAI here means api.openai.com. Azure deployments use the AzureOpenAI provider.</AlertDescription></Alert> : null}
                {isAzure && active.configured && active.runtimeReady === false ? <Alert><AlertDescription>The Azure key is saved but the base URL is missing. Save it under Runtime.</AlertDescription></Alert> : null}
                {persistence?.server.warning ? <Alert variant="destructive"><AlertDescription>{persistence.server.warning}</AlertDescription></Alert> : null}

                <RadioGroup value={mode} onValueChange={value => setMode(value as PersistenceMode)} className="gap-2">
                  {modes.filter(m => m.show).map(m => (
                    <Label key={m.value} htmlFor={`mode-${m.value}`} className={cn('flex items-start gap-3 rounded-lg border p-3 font-normal', !m.available && 'opacity-50', mode === m.value && 'border-primary')}>
                      <RadioGroupItem id={`mode-${m.value}`} value={m.value} disabled={!m.available} className="mt-0.5" />
                      <span className="grid gap-0.5">
                        <span className="font-medium">{m.label}</span>
                        <span className="text-xs text-muted-foreground">{m.hint}</span>
                      </span>
                    </Label>
                  ))}
                </RadioGroup>

                {mode === 'arcana' ? (
                  <Field id="arcana-ref" label="Arcana reference" hint="The secret stays in Arcana; Leyline keeps only this reference.">
                    <Input id="arcana-ref" value={arcanaReference} onChange={e => setArcanaReference(e.target.value)} placeholder="arcana://provider/name" autoComplete="off" />
                  </Field>
                ) : (
                  <Field id="api-key" label="API key" hint="Saving a blank field is ignored. Use Clear key to remove a key.">
                    <Input id="api-key" type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Paste API key" autoComplete="off" />
                  </Field>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={!keyDirty}>Save key</Button>
                  <Button type="button" variant="outline" className="text-destructive" onClick={clearKey} disabled={!active.configured}>Clear key</Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{isAzure ? 'Azure OpenAI URL and deployment' : 'Runtime'}</CardTitle>
              <CardDescription>
                {active.runtimeConfigurable
                  ? `Base URL and default model, saved in ${storeLabel}.`
                  : 'This provider has no runtime settings.'}
              </CardDescription>
              <CardAction>
                <ToneBadge tone={active.runtimeConfigurable ? (active.runtimeReady ? 'success' : 'warning') : 'neutral'}>
                  {active.runtimeConfigurable ? (active.runtimeReady ? 'Ready' : 'Needs base URL') : 'Not applicable'}
                </ToneBadge>
              </CardAction>
            </CardHeader>
            <CardContent>
              <form onSubmit={saveRuntime} className="grid gap-4">
                <Field id="base-url" label="Base URL" hint={isAzure ? 'Example: https://your-resource.services.ai.azure.com/openai/v1' : undefined}>
                  <Input id="base-url" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} disabled={!active.runtimeConfigurable} />
                </Field>
                <Field id="model" label="Model or deployment">
                  <Input id="model" value={model} onChange={e => setModel(e.target.value)} disabled={!active.runtimeConfigurable} />
                </Field>
                <div><Button type="submit" variant="secondary" disabled={!runtimeDirty}>Save settings</Button></div>
              </form>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </>
  );
}

function AddInstanceDialog({ family, d, onAdded }: { family: InstanceFamily; d: Dashboard; onAdded: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // The key itself is set afterwards on the provider's key card; this only collects non-secret config.
  const fields = family.fields.filter(f => f.role !== 'secret');
  const canSubmit = fields.every(f => !f.required || Boolean(values[f.key]?.trim()));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const data = await api<{ name: string; label?: string }>('/dashboard/provider-instances', { method: 'POST', body: { family: family.family, config: values } });
      toast.success(`Added ${family.displayName} "${data.label || data.name}". Set its key below.`);
      setValues({});
      setOpen(false);
      await d.refreshAll();
      onAdded(data.name);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not add the ${family.displayName} instance`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button variant="outline" size="sm"><Plus />{family.displayName} endpoint</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add {family.displayName} endpoint</DialogTitle>
          <DialogDescription>Another {family.displayName} account with its own endpoint and model ({family.instances.length} extra so far).</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4">
          {fields.map(field => (
            <Field key={field.key} id={`inst-${field.key}`} label={field.label}>
              <Input id={`inst-${field.key}`} value={values[field.key] || ''} placeholder={field.placeholder} autoComplete="off" onChange={e => setValues(v => ({ ...v, [field.key]: e.target.value }))} />
            </Field>
          ))}
          <DialogFooter><Button type="submit" disabled={busy || !canSubmit}>{busy ? 'Adding…' : 'Add endpoint'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
