import React, { FormEvent, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import {
  ApiKeyStatusResponse,
  familyOf,
  formatLogTime,
  formatLogUsage,
  InstanceFamily,
  LogEntry,
  normalizeApiKeyStatusResponse,
  normalizeProviderInstancesResponse,
  normalizeRouting,
  normalizeStatsResponse,
  PersistenceMode,
  providerDescription,
  providerStatusLabel,
  providerTone,
  ProviderInstancesResponse,
  ProviderStats,
  RoutingStatus,
  sourceLabel,
  StatsResponse,
  statusTone,
  ClientAuthInfo,
  TunnelInfo,
} from './normalization';

const LOCAL_KEY_PREFIX = 'leyline.apiKey.';
const LOCAL_MODE_PREFIX = 'leyline.persistence.';
const LOCAL_RUNTIME_PREFIX = 'leyline.runtime.';
const LOG_ERROR_MAX_LENGTH = 60;
const API_STARTUP_RETRY_DELAY = 1000;
const API_BASE = (import.meta.env.VITE_LEYLINE_API_BASE_URL || window.location.origin).replace(/\/$/, '');

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function localKey(provider: string): string {
  return `${LOCAL_KEY_PREFIX}${provider}`;
}

function localModeKey(provider: string): string {
  return `${LOCAL_MODE_PREFIX}${provider}`;
}

function localRuntimeKey(provider: string): string {
  return `${LOCAL_RUNTIME_PREFIX}${provider}`;
}

function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'success' | 'warning' | 'danger'; children: React.ReactNode }) {
  return <span className={cn('badge', `badge-${tone}`)}>{children}</span>;
}

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <section className={cn('card', className)}>{children}</section>;
}

function Button({
  variant = 'primary',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'destructive' | 'ghost' }) {
  return <button {...props} className={cn('button', `button-${variant}`, props.className)} />;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function truncateLogError(error?: string): string {
  if (!error) return '-';
  if (error.length <= LOG_ERROR_MAX_LENGTH) return error;
  return `${error.slice(0, LOG_ERROR_MAX_LENGTH - 3)}...`;
}

function maskValue(value: string, visible = 8): string {
  if (value.length <= visible) return '•'.repeat(Math.max(value.length, 8));
  return `${value.slice(0, visible)}${'•'.repeat(18)}${value.slice(-4)}`;
}

function SecretValue({ label, value, secret = false }: { label: string; value?: string; secret?: boolean }) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const displayValue = value ? (secret && !visible ? maskValue(value) : value) : 'Not available';

  async function copyValue() {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="secret-row">
      <span>{label}</span>
      <code title={secret && !visible ? 'Hidden' : value}>{displayValue}</code>
      <div className="secret-actions">
        {secret && value ? (
          <Button type="button" variant="ghost" onClick={() => setVisible(current => !current)}>
            {visible ? 'Hide' : 'Show'}
          </Button>
        ) : null}
        <Button type="button" variant="secondary" onClick={copyValue} disabled={!value}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

function App() {
  const [status, setStatus] = useState<ApiKeyStatusResponse | null>(null);
  const [stats, setStats] = useState<StatsResponse>({ providers: [], logs: [] });
  const [selectedProvider, setSelectedProvider] = useState('');
  const [persistenceMode, setPersistenceMode] = useState<PersistenceMode>('keychain');
  const [apiKey, setApiKey] = useState('');
  const [arcanaReference, setArcanaReference] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [message, setMessage] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [rehydrated, setRehydrated] = useState(false);
  const [instanceFamilies, setInstanceFamilies] = useState<InstanceFamily[]>([]);

  const localStorageAvailable = useMemo(() => {
    try {
      const testKey = 'leyline.localStorage.test';
      window.localStorage.setItem(testKey, '1');
      window.localStorage.removeItem(testKey);
      return true;
    } catch {
      return false;
    }
  }, []);

  const providers = status?.providers || [];
  const persistence = status?.persistence;
  const routing = status?.routing;
  const activeProvider = providers.find(provider => provider.name === selectedProvider) || providers[0];
  const keychainAvailable = Boolean(persistence?.modes.keychain.available);
  // arcanaAvailable only means "this secret store supports Arcana somewhere" — it does not mean
  // *this* provider already has a reference configured, so it must not drive the default mode
  // (every new/unconfigured provider would otherwise default to an Arcana reference field instead
  // of a plain API key field). Use hasResolvedArcanaReference for defaulting instead.
  const arcanaAvailable = Boolean(activeProvider?.arcanaAvailable);
  const hasResolvedArcanaReference = Boolean(activeProvider?.arcanaReference);
  const savedPersistenceMode: PersistenceMode = activeProvider
    ? (localStorageAvailable
      ? window.localStorage.getItem(localModeKey(activeProvider.name)) as PersistenceMode | null
      : null) || (activeProvider.source === 'arcana'
        ? 'arcana'
        : activeProvider.configured
          ? 'keychain'
          : hasResolvedArcanaReference
            ? 'arcana'
            : keychainAvailable
              ? 'keychain'
              : arcanaAvailable
                ? 'arcana'
                : 'localStorage')
    : persistenceMode;
  const keyFormDirty = Boolean(
    activeProvider
    && (
      Boolean(apiKey.trim())
      || persistenceMode !== savedPersistenceMode
      || (persistenceMode === 'arcana' && arcanaReference.trim() !== (activeProvider.arcanaReference || ''))
    ),
  );
  const savedBaseUrl = activeProvider?.runtimeConfig?.baseUrl || '';
  const savedModel = activeProvider?.runtimeConfig?.model || activeProvider?.defaultModel || '';
  const runtimeFormDirty = Boolean(
    activeProvider?.runtimeConfigurable
    && (baseUrl.trim() !== savedBaseUrl || model.trim() !== savedModel),
  );

  async function fetchApiKeyStatus() {
    const response = await fetch(apiUrl('/dashboard/api-keys'));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to fetch API key status');
    const normalized = normalizeApiKeyStatusResponse(data);
    setStatus(normalized);
    if (!selectedProvider) {
      const preferred = normalized.routing?.fixedProvider
        || normalized.providers.find(p => familyOf(p.name, p.family) === 'AzureOpenAI' && p.configured)?.name
        || normalized.providers[0]?.name;
      if (preferred) setSelectedProvider(preferred);
    }
    return normalized;
  }

  async function fetchStats() {
    const response = await fetch(apiUrl('/dashboard/stats'));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to fetch dashboard stats');
    setStats(normalizeStatsResponse(data));
  }

  async function fetchProviderInstances() {
    const response = await fetch(apiUrl('/dashboard/provider-instances'));
    const data = await response.json();
    if (!response.ok) throw new Error('Failed to fetch provider instances');
    const normalized: ProviderInstancesResponse = normalizeProviderInstancesResponse(data);
    setInstanceFamilies(normalized.families);
  }

  async function rehydrateLocalKeys(data: ApiKeyStatusResponse) {
    if (!localStorageAvailable) return;

    await Promise.all(data.providers.map(async provider => {
      if (window.localStorage.getItem(localModeKey(provider.name)) !== 'localStorage') return;
      const storedKey = window.localStorage.getItem(localKey(provider.name));
      if (!storedKey) return;

      const response = await fetch(apiUrl('/dashboard/api-keys'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: provider.name,
          apiKey: storedKey,
          persistence: 'localStorage',
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || `Failed to rehydrate ${provider.name} localStorage key`);
      }
    }));
  }

  async function rehydrateLocalRuntime(data: ApiKeyStatusResponse) {
    if (!localStorageAvailable) return;

    await Promise.all(data.providers.map(async provider => {
      if (!provider.runtimeConfigurable) return;
      const storedRuntime = window.localStorage.getItem(localRuntimeKey(provider.name));
      if (!storedRuntime) return;

      let parsed: { baseUrl?: string; model?: string };
      try {
        parsed = JSON.parse(storedRuntime);
      } catch {
        return;
      }

      const response = await fetch(apiUrl('/dashboard/api-keys'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: provider.name,
          baseUrl: parsed.baseUrl,
          model: parsed.model,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || `Failed to rehydrate ${provider.name} runtime settings`);
      }
    }));
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      let data: ApiKeyStatusResponse | undefined;
      while (!cancelled) {
        try {
          data = await fetchApiKeyStatus();
          setMessage('');
          break;
        } catch (error) {
          setMessage('Waiting for Leyline API…');
          await new Promise(resolve => window.setTimeout(resolve, API_STARTUP_RETRY_DELAY));
        }
      }

      if (cancelled || !data) return;

      try {
        if (!rehydrated) {
          await rehydrateLocalKeys(data);
          await rehydrateLocalRuntime(data);
          if (cancelled) return;
          setRehydrated(true);
          await fetchApiKeyStatus();
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Failed to load dashboard');
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [rehydrated]);

  useEffect(() => {
    if (!rehydrated) return;

    fetchStats().catch(error => {
      setMessage(error instanceof Error ? error.message : 'Failed to load dashboard stats');
    });
    fetchProviderInstances().catch(error => {
      setMessage(error instanceof Error ? error.message : 'Failed to load provider instances');
    });
    const interval = window.setInterval(fetchStats, 5000);
    return () => window.clearInterval(interval);
  }, [rehydrated]);

  useEffect(() => {
    if (!activeProvider) return;

    const savedMode = localStorageAvailable
      ? window.localStorage.getItem(localModeKey(activeProvider.name)) as PersistenceMode | null
      : null;
    const nextMode = savedMode
      || (hasResolvedArcanaReference ? 'arcana' : keychainAvailable ? 'keychain' : arcanaAvailable ? 'arcana' : 'localStorage');

    setPersistenceMode(nextMode);
    setBaseUrl(activeProvider.runtimeConfig?.baseUrl || '');
    setModel(activeProvider.runtimeConfig?.model || activeProvider.defaultModel || '');
    setArcanaReference(activeProvider.arcanaReference || '');
    setApiKey('');
  }, [activeProvider?.name, persistence?.modes.arcana.available, persistence?.modes.keychain.available]);

  async function saveKey(event: FormEvent) {
    event.preventDefault();
    if (!activeProvider) return;
    if (persistenceMode !== 'arcana' && !apiKey.trim()) {
      setMessage('Paste a key before saving. Blank keys never clear an existing key.');
      return;
    }
    if (persistenceMode === 'localStorage' && !localStorageAvailable) {
      setMessage('localStorage is not available in this browser.');
      return;
    }

    setMessage('Saving API key...');
    const response = await fetch(apiUrl('/dashboard/api-keys'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: activeProvider.name,
        apiKey: persistenceMode === 'arcana' ? undefined : apiKey,
        arcanaReference: persistenceMode === 'arcana' ? arcanaReference : undefined,
        persistence: persistenceMode,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error || 'Failed to save API key');
      return;
    }

    if (persistenceMode === 'localStorage') {
      window.localStorage.setItem(localKey(activeProvider.name), apiKey);
      window.localStorage.setItem(localModeKey(activeProvider.name), 'localStorage');
    } else if (persistenceMode !== 'arcana') {
      window.localStorage.removeItem(localKey(activeProvider.name));
      window.localStorage.setItem(localModeKey(activeProvider.name), persistenceMode);
    }

    setApiKey('');
    setMessage(`${activeProvider.name} key saved using ${sourceLabel(data.source)}.`);
    await fetchApiKeyStatus();
    await fetchStats();
  }

  async function saveRuntimeSettings(event: FormEvent) {
    event.preventDefault();
    if (!activeProvider) return;

    setMessage('Saving runtime settings...');
    const response = await fetch(apiUrl('/dashboard/api-keys'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: activeProvider.name,
        baseUrl,
        model,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error || 'Failed to save runtime settings');
      return;
    }

    setMessage(`${activeProvider.name} runtime settings saved to Apple Keychain.`);
    if (localStorageAvailable) {
      window.localStorage.setItem(localRuntimeKey(activeProvider.name), JSON.stringify({ baseUrl, model }));
    }
    await fetchApiKeyStatus();
    await fetchStats();
  }

  async function clearKey() {
    if (!activeProvider) return;
    const confirmed = window.confirm(`Clear the ${activeProvider.name} key from Leyline and this browser? Runtime URL/model settings will be kept.`);
    if (!confirmed) return;

    setMessage('Clearing API key...');
    const response = await fetch(apiUrl(`/dashboard/api-keys/${encodeURIComponent(activeProvider.name)}`), {
      method: 'DELETE',
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error || 'Failed to clear API key');
      return;
    }

    if (localStorageAvailable) {
      window.localStorage.removeItem(localKey(activeProvider.name));
      window.localStorage.removeItem(localModeKey(activeProvider.name));
    }
    setApiKey('');
    setMessage(`${activeProvider.name} key cleared.`);
    await fetchApiKeyStatus();
    await fetchStats();
  }

  async function addInstance(family: InstanceFamily, config: Record<string, string>) {
    setMessage(`Adding ${family.displayName} instance...`);
    const response = await fetch(apiUrl('/dashboard/provider-instances'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ family: family.family, config }),
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error || `Failed to add ${family.displayName} instance`);
      return;
    }

    setMessage(`Added ${family.displayName} instance "${data.label || data.name}" — set its key in the API Keys card below.`);
    await Promise.all([fetchApiKeyStatus(), fetchStats(), fetchProviderInstances()]);
    setSelectedProvider(data.name);
  }

  async function removeInstance(family: InstanceFamily, id: string) {
    const confirmed = window.confirm(`Remove this ${family.displayName} instance? Its saved key and settings will be deleted.`);
    if (!confirmed) return;

    setMessage(`Removing ${family.displayName} instance...`);
    const response = await fetch(apiUrl(`/dashboard/provider-instances/${encodeURIComponent(family.family)}/${encodeURIComponent(id)}`), {
      method: 'DELETE',
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error || `Failed to remove ${family.displayName} instance`);
      return;
    }

    setMessage(`${family.displayName} instance removed.`);
    if (selectedProvider === `${family.baseName}:${id}`) setSelectedProvider('');
    await Promise.all([fetchApiKeyStatus(), fetchStats(), fetchProviderInstances()]);
  }

  async function updateRouting(body: Record<string, unknown>, successMessage?: string) {
    const response = await fetch(apiUrl('/dashboard/routing'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      setMessage(data.error || 'Failed to update routing');
      return false;
    }

    const normalized = normalizeRouting(data);
    setStatus(current => (current ? { ...current, routing: normalized } : current));
    if (successMessage) setMessage(successMessage);
    return true;
  }

  function toggleModel(providerName: string, modelId: string, enable: boolean) {
    const pool = routing?.enabledModels ?? {};
    const next: Record<string, string[]> = Object.fromEntries(
      Object.entries(pool).map(([provider, models]) => [provider, [...models]]),
    );
    const current = next[providerName] ?? [];
    next[providerName] = enable
      ? [...new Set([...current, modelId])]
      : current.filter(id => id !== modelId);
    if (next[providerName].length === 0) delete next[providerName];
    void updateRouting({ enabledModels: next });
  }

  function pinModelInstance(modelId: string, providerName: string) {
    const pins = { ...(routing?.modelPins ?? {}) };
    if (providerName) pins[modelId] = providerName;
    else delete pins[modelId];
    void updateRouting({ modelPins: pins });
  }

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Leyline Router</p>
          <h1>Provider Control Center</h1>
          <p className="hero-copy">Configure provider keys, Azure runtime settings, quotas, model coverage, and recent request flow from one place.</p>
        </div>
        <Button variant="secondary" onClick={() => Promise.all([fetchApiKeyStatus(), fetchStats(), fetchProviderInstances()])}>Refresh</Button>
      </header>

      {message ? <div className="notice" role="status" aria-live="polite">{message}</div> : null}

      <TunnelBanner tunnel={stats.tunnel} clientAuth={stats.clientAuth} />

      <RoutingPanel routing={routing} providers={stats.providers} onUpdate={updateRouting} />

      <section className="grid grid-3">
        {[...providers]
          .sort((a, b) => familyOf(a.name, a.family).localeCompare(familyOf(b.name, b.family)) || a.name.localeCompare(b.name))
          .map(provider => {
          const statusInfo = providerStatusLabel(provider);
          const family = instanceFamilies.find(f => f.family === (provider.family || provider.name));
          const removable = Boolean(family && provider.name !== family.baseName);
          return (
          <div
            key={provider.name}
            role="button"
            tabIndex={0}
            className={cn('provider-card', activeProvider?.name === provider.name && 'provider-card-active')}
            onClick={() => setSelectedProvider(provider.name)}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') setSelectedProvider(provider.name);
            }}
          >
            <span className={cn('provider-dot', `provider-bg-${providerTone(provider.name, provider.family)}`)} />
            <strong>{provider.label || provider.name}</strong>
            <Badge tone={statusInfo.tone}>{statusInfo.label}</Badge>
            <small>{providerDescription(provider.name, provider.family) || sourceLabel(provider.source)}</small>
            {removable && family ? (
              <Button
                type="button"
                variant="ghost"
                onClick={event => { event.stopPropagation(); void removeInstance(family, provider.name.slice(family.baseName.length + 1)); }}
              >
                Remove
              </Button>
            ) : null}
          </div>
        );})}
      </section>

      <InstanceFamiliesPanel families={instanceFamilies} onAdd={addInstance} />

      <section className="grid grid-2">
        <Card>
          <div className="section-heading">
            <div>
              <p className="eyebrow">API Keys</p>
              <h2>{activeProvider?.name || 'Provider'} key persistence</h2>
            </div>
            {activeProvider ? <Badge tone={activeProvider.persisted ? 'success' : activeProvider.configured ? 'warning' : 'danger'}>{sourceLabel(activeProvider.source)}</Badge> : null}
          </div>

          <div className="status-list">
            <div><span>Server persistence</span><strong>{persistence?.server.mode === 'keychain' ? 'Apple Keychain' : 'Memory fallback'}</strong></div>
            <div><span>Keychain service</span><strong>{persistence?.server.service || 'Not available'}</strong></div>
            <div><span>Current key</span><strong>{activeProvider?.configured ? 'Configured' : 'Missing'}</strong></div>
            {activeProvider?.runtimeConfigurable ? (
              <div><span>Azure runtime</span><strong>{activeProvider.runtimeReady ? 'Ready' : 'Needs base URL'}</strong></div>
            ) : null}
          </div>

          {activeProvider?.name === 'OpenAI' ? (
            <p className="callout warning">OpenAI here means api.openai.com. Azure deployments use the <strong>AzureOpenAI</strong> card instead.</p>
          ) : null}
          {activeProvider && familyOf(activeProvider.name, activeProvider.family) === 'AzureOpenAI' && activeProvider.configured && activeProvider.runtimeReady === false ? (
            <p className="callout warning">Your Azure key is saved, but the base URL is missing after restart. Save the Azure base URL below — it is stored in Keychain with your key.</p>
          ) : null}

          {persistence?.server.warning ? <p className="callout warning">{persistence.server.warning}</p> : null}

          <form onSubmit={saveKey} className="stack">
            <fieldset className="radio-group">
              <legend>Choose where this key should live</legend>
              <label>
                <input
                  type="radio"
                  name="persistence"
                  value="keychain"
                  checked={persistenceMode === 'keychain'}
                  disabled={!persistence?.modes.keychain.available}
                  onChange={() => setPersistenceMode('keychain')}
                />
                Apple Keychain
                <small>
                  {keychainAvailable
                    ? 'Most secure server-side option on macOS.'
                    : 'Unavailable on this server. Use localStorage or memory, or check macOS Keychain access.'}
                </small>
              </label>
              <label>
                <input
                  type="radio"
                  name="persistence"
                  value="arcana"
                  checked={persistenceMode === 'arcana'}
                  disabled={!arcanaAvailable}
                  onChange={() => setPersistenceMode('arcana')}
                />
                Arcana
                <small>
                  {arcanaAvailable
                    ? arcanaReference
                      ? 'Resolve this provider key from the configured Arcana reference.'
                      : 'Enter an Arcana reference for this provider.'
                    : 'No Arcana reference is available for this provider.'}
                </small>
              </label>
              <label>
                <input
                  type="radio"
                  name="persistence"
                  value="localStorage"
                  checked={persistenceMode === 'localStorage'}
                  disabled={!localStorageAvailable}
                  onChange={() => setPersistenceMode('localStorage')}
                />
                Browser localStorage
                <small>Browser-local fallback; re-sent to Leyline when this dashboard opens.</small>
              </label>
              <label>
                <input
                  type="radio"
                  name="persistence"
                  value="memory"
                  checked={persistenceMode === 'memory'}
                  onChange={() => setPersistenceMode('memory')}
                />
                Server memory
                <small>Available until this server process exits.</small>
              </label>
            </fieldset>

            {persistenceMode === 'arcana' ? (
              <>
                <Field label="Arcana reference" hint="Example: arcana://llmapi/arion/api-key">
                  <input
                    type="text"
                    value={arcanaReference}
                    onChange={event => setArcanaReference(event.target.value)}
                    placeholder="arcana://provider/name"
                    autoComplete="off"
                  />
                </Field>
                <p className="callout">The secret stays in Arcana. Leyline keeps only this reference in the running server and resolves it for this provider.</p>
              </>
            ) : (
              <Field label="API key" hint="Saving a blank field is ignored. Use Clear key to remove a key.">
                <input
                  type="password"
                  value={apiKey}
                  onChange={event => setApiKey(event.target.value)}
                  placeholder="Paste API key"
                  autoComplete="off"
                />
              </Field>
            )}
            <div className="actions">
              <Button type="submit" disabled={!keyFormDirty}>Save Key</Button>
              <Button type="button" variant="destructive" onClick={clearKey} disabled={!activeProvider?.configured}>Clear Key</Button>
            </div>
          </form>
        </Card>

        <Card>
          <div className="section-heading">
            <div>
              <p className="eyebrow">Runtime</p>
              <h2>{activeProvider && familyOf(activeProvider.name, activeProvider.family) === 'AzureOpenAI' ? 'Azure OpenAI URL and deployment' : 'Provider runtime'}</h2>
            </div>
            <Badge tone={activeProvider?.runtimeConfigurable ? (activeProvider.runtimeReady ? 'success' : 'warning') : 'neutral'}>
              {activeProvider?.runtimeConfigurable ? (activeProvider.runtimeReady ? 'Ready' : 'Needs base URL') : 'Not applicable'}
            </Badge>
          </div>
          <p className="muted">
            {activeProvider && familyOf(activeProvider.name, activeProvider.family) === 'AzureOpenAI'
              ? 'Azure base URL and deployment persist in Apple Keychain across restarts. Example: https://your-resource.services.ai.azure.com/openai/v1'
              : 'Runtime settings persist in Apple Keychain on macOS when supported. Browser localStorage is used as a dashboard fallback.'}
          </p>
          <form onSubmit={saveRuntimeSettings} className="stack">
            <Field label="Base URL" hint="Example: https://your-resource.services.ai.azure.com/openai/v1">
              <input
                value={baseUrl}
                onChange={event => setBaseUrl(event.target.value)}
                disabled={!activeProvider?.runtimeConfigurable}
                aria-label="Azure base URL"
              />
            </Field>
            <Field label="Model or deployment">
              <input
                value={model}
                onChange={event => setModel(event.target.value)}
                disabled={!activeProvider?.runtimeConfigurable}
                aria-label="Azure model or deployment"
              />
            </Field>
            <Button type="submit" variant="secondary" disabled={!runtimeFormDirty}>Save Settings</Button>
          </form>
        </Card>
      </section>

      <NetworkPanel
        providers={stats.providers}
        search={modelSearch}
        setSearch={setModelSearch}
        routing={routing}
        onToggleModel={toggleModel}
        onPinModel={pinModelInstance}
      />
      <PlaygroundPanel providers={stats.providers} clientAuth={stats.clientAuth} />
      <AnalyticsPanel providers={stats.providers} logs={stats.logs} />
      <LogsPanel logs={stats.logs} tunnel={stats.tunnel} clientAuth={stats.clientAuth} />
    </main>
  );
}

function poolIsActive(routing?: RoutingStatus): boolean {
  return Boolean(routing && Object.values(routing.enabledModels).some(models => models.length > 0));
}

function RoutingPanel({
  routing,
  providers,
  onUpdate,
}: {
  routing?: RoutingStatus;
  providers: ProviderStats[];
  onUpdate: (body: Record<string, unknown>, successMessage?: string) => Promise<boolean>;
}) {
  const [pinnedProvider, setPinnedProvider] = useState('');
  const [pinnedModel, setPinnedModel] = useState('');

  useEffect(() => {
    setPinnedProvider(routing?.fixedProvider || '');
    setPinnedModel(routing?.fixedModel || '');
  }, [routing?.fixedProvider, routing?.fixedModel]);

  const pinned = Boolean(routing?.singleModelEnabled);
  const poolActive = poolIsActive(routing);
  const poolCount = routing
    ? Object.values(routing.enabledModels).reduce((total, models) => total + models.length, 0)
    : 0;
  const pinnedProviderModels = providers.find(provider => provider.name === pinnedProvider)?.models || [];

  async function pinModel(event: FormEvent) {
    event.preventDefault();
    if (!pinnedModel.trim()) return;
    await onUpdate(
      { mode: 'pinned', pinnedProvider, pinnedModel: pinnedModel.trim() },
      `Router pinned to ${pinnedProvider ? `${pinnedProvider} / ` : ''}${pinnedModel.trim()}.`,
    );
  }

  async function useAutoRouting() {
    await onUpdate({ mode: 'auto' }, 'Auto routing enabled.');
  }

  async function resetPool() {
    await onUpdate({ enabledModels: {} }, 'Model selection cleared — routing across all models.');
  }

  return (
    <Card>
      <div className="section-heading">
        <div>
          <p className="eyebrow">Routing</p>
          <h2>Model routing</h2>
        </div>
        <Badge tone={pinned ? 'warning' : 'success'}>
          {pinned
            ? `Pinned: ${routing?.fixedModel || 'unset'}`
            : poolActive
              ? `Auto: ${poolCount} model${poolCount === 1 ? '' : 's'} selected`
              : 'Auto: all models'}
        </Badge>
      </div>

      <div className="routing-modes">
        <div
          role="button"
          tabIndex={0}
          className={cn('provider-card', !pinned && 'provider-card-active')}
          onClick={() => { if (pinned) void useAutoRouting(); }}
          onKeyDown={event => {
            if (pinned && (event.key === 'Enter' || event.key === ' ')) void useAutoRouting();
          }}
        >
          <strong>Auto routing</strong>
          <small>
            {poolActive
              ? `Route requests across the ${poolCount} selected model${poolCount === 1 ? '' : 's'}. Use the Route toggles below to change the selection.`
              : 'Route requests across every available model. Toggle Route on specific models below to restrict the pool.'}
          </small>
          {!pinned && poolActive ? (
            <Button type="button" variant="ghost" onClick={event => { event.stopPropagation(); void resetPool(); }}>
              Clear selection (use all models)
            </Button>
          ) : null}
        </div>

        <form
          className={cn('provider-card', pinned && 'provider-card-active')}
          onSubmit={pinModel}
        >
          <strong>Pinned model</strong>
          <small>Send every request to one provider and model. Requests that name another model are still forced to the pinned one.</small>
          <div className="routing-pin-fields">
            <select
              value={pinnedProvider}
              onChange={event => setPinnedProvider(event.target.value)}
              aria-label="Pinned provider"
            >
              <option value="">Infer provider</option>
              {providers.map(provider => (
                <option key={provider.name} value={provider.name}>{provider.name}</option>
              ))}
            </select>
            <input
              value={pinnedModel}
              onChange={event => setPinnedModel(event.target.value)}
              placeholder="Model id (free text)"
              list="pinned-model-options"
              aria-label="Pinned model"
            />
            <datalist id="pinned-model-options">
              {pinnedProviderModels.map(model => (
                <option key={model.id} value={model.id} />
              ))}
            </datalist>
            <Button type="submit" variant="secondary" disabled={!pinnedModel.trim()}>
              {pinned ? 'Update pin' : 'Pin'}
            </Button>
          </div>
        </form>
      </div>

      <p className="muted">
        Tip: clients can also request a specific model per call — set <code>"model"</code> to the model id
        in the request and Leyline routes it to the provider that serves it. Use <code>"model": "auto"</code>
        to let the router pick from the pool.
      </p>
    </Card>
  );
}

function InstanceFamiliesPanel({
  families,
  onAdd,
}: {
  families: InstanceFamily[];
  onAdd: (family: InstanceFamily, config: Record<string, string>) => Promise<void>;
}) {
  if (families.length === 0) return null;

  return (
    <section className="grid grid-2">
      {families.map(family => (
        <InstanceFamilyForm key={family.family} family={family} onAdd={onAdd} />
      ))}
    </section>
  );
}

function InstanceFamilyForm({
  family,
  onAdd,
}: {
  family: InstanceFamily;
  onAdd: (family: InstanceFamily, config: Record<string, string>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await onAdd(family, values);
      setValues({});
    } finally {
      setSubmitting(false);
    }
  }

  // The key itself is set afterward via the API Keys card below (same persistence-mode
  // choice as every other provider) — this form only collects non-secret config.
  const visibleFields = family.fields.filter(field => field.role !== 'secret');
  const canSubmit = visibleFields.every(field => !field.required || Boolean(values[field.key]?.trim()));

  return (
    <Card>
      <div className="section-heading">
        <div>
          <p className="eyebrow">Multi-instance</p>
          <h2>Add {family.displayName} endpoint</h2>
        </div>
        <Badge tone="neutral">{family.instances.length} extra instance{family.instances.length === 1 ? '' : 's'}</Badge>
      </div>
      <p className="muted">
        Register another {family.displayName} account with its own endpoint and deployed model.
        After it's added, select it above and set its key in the API Keys card.
      </p>
      <form onSubmit={submit} className="stack">
        {visibleFields.map(field => (
          <Field key={field.key} label={field.label}>
            <input
              type="text"
              value={values[field.key] || ''}
              placeholder={field.placeholder}
              onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))}
              autoComplete="off"
            />
          </Field>
        ))}
        <Button type="submit" disabled={submitting || !canSubmit}>{submitting ? 'Adding…' : `Add ${family.displayName} instance`}</Button>
      </form>
    </Card>
  );
}

function NetworkPanel({
  providers,
  search,
  setSearch,
  routing,
  onToggleModel,
  onPinModel,
}: {
  providers: ProviderStats[];
  search: string;
  setSearch: (value: string) => void;
  routing?: RoutingStatus;
  onToggleModel: (provider: string, modelId: string, enable: boolean) => void;
  onPinModel: (modelId: string, providerName: string) => void;
}) {
  const normalizedSearch = search.toLowerCase();
  const poolActive = poolIsActive(routing);
  const modelIndex = routing?.modelIndex ?? {};

  return (
    <Card>
      <div className="section-heading">
        <div>
          <p className="eyebrow">Network</p>
          <h2>Provider status and models</h2>
        </div>
        <input className="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search models..." aria-label="Search models" />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Default Model</th>
              <th>Models</th>
              <th>Minute</th>
              <th>Daily</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {providers.map(provider => {
              const quotaMinute = provider.quota?.requestsPerMinute ?? '∞';
              const quotaDay = provider.quota?.requestsPerDay ?? '∞';
              const rateLimited = Boolean(provider.quota && (provider.usage.minute >= provider.quota.requestsPerMinute || provider.usage.day >= provider.quota.requestsPerDay));
              const missingKey = Boolean(provider.apiKeyConfigurable && !provider.apiKeyConfigured);
              const missingRuntime = Boolean(provider.runtimeReady === false && provider.apiKeyConfigured);
              const filteredModels = provider.models.filter(model => {
                if (!normalizedSearch) return true;
                return [model.id, model.name, model.description].some(value => value?.toLowerCase().includes(normalizedSearch));
              });

              const enabledForProvider = routing?.enabledModels[provider.name] || [];

              return (
                <tr key={provider.name}>
                  <td><strong className={`provider-text-${providerTone(provider.name)}`}>{provider.name}</strong></td>
                  <td><code>{provider.defaultModel}</code></td>
                  <td>
                    <details open={Boolean(search)}>
                      <summary>
                        {filteredModels.length} / {provider.models.length} models
                        {poolActive ? ` — ${enabledForProvider.length} routed` : ''}
                      </summary>
                      <div className="model-list">
                        {filteredModels.length ? filteredModels.map(model => {
                          const routed = enabledForProvider.includes(model.id);
                          const offeredBy = modelIndex[model.id] ?? [];
                          const ambiguous = offeredBy.length > 1;
                          return (
                          <div key={model.id} className="model-row">
                            <label className="model-toggle" title={poolActive
                              ? (routed ? 'In the routing pool' : 'Excluded from auto routing')
                              : 'No pool selected — auto routing uses all models. Toggle to start a selection.'}>
                              <input
                                type="checkbox"
                                checked={routed}
                                onChange={event => onToggleModel(provider.name, model.id, event.target.checked)}
                              />
                              <span>Route</span>
                            </label>
                            <div className="model-meta">
                              <strong>{model.name || model.id}</strong>
                              <small>{model.id}</small>
                              {model.description ? <small>{model.description}</small> : null}
                            </div>
                            {ambiguous ? (
                              <select
                                aria-label={`Preferred instance for ${model.id}`}
                                value={routing?.modelPins?.[model.id] || ''}
                                onChange={event => onPinModel(model.id, event.target.value)}
                              >
                                <option value="">Priority order (unpinned)</option>
                                {offeredBy.map(name => (
                                  <option key={name} value={name}>{name}</option>
                                ))}
                              </select>
                            ) : null}
                          </div>
                        );}) : <span className="muted">No matching models</span>}
                      </div>
                    </details>
                  </td>
                  <td>{provider.usage.minute} / {quotaMinute}</td>
                  <td>{provider.usage.day} / {quotaDay}</td>
                  <td>
                    {rateLimited ? <Badge tone="warning">Rate limited</Badge> : missingRuntime ? <Badge tone="warning">Needs base URL</Badge> : missingKey ? <Badge tone="danger">Missing key</Badge> : <Badge tone="success">Available</Badge>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function PlaygroundPanel({
  providers,
  clientAuth,
}: {
  providers: ProviderStats[];
  clientAuth?: ClientAuthInfo;
}) {
  const [providerName, setProviderName] = useState('');
  const [modelId, setModelId] = useState('');
  const [prompt, setPrompt] = useState('Say hello in one sentence.');
  const [response, setResponse] = useState('');
  const [error, setError] = useState('');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [sending, setSending] = useState(false);

  const activeProvider = providers.find(p => p.name === providerName) || providers[0];
  const models = activeProvider?.models ?? [];

  useEffect(() => {
    if (!providerName && providers[0]) setProviderName(providers[0].name);
  }, [providers, providerName]);

  useEffect(() => {
    if (!activeProvider) return;
    if (!models.some(m => m.id === modelId)) {
      setModelId(models[0]?.id || activeProvider.defaultModel || '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProvider?.name]);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!activeProvider || !modelId.trim() || !prompt.trim()) return;

    setSending(true);
    setError('');
    setResponse('');
    const started = performance.now();
    try {
      const res = await fetch(apiUrl('/v1/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${clientAuth?.apiKey || ''}`,
          'X-Leyline-Force-Provider': activeProvider.name,
        },
        body: JSON.stringify({
          model: modelId.trim(),
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const data = await res.json();
      setLatencyMs(Math.round(performance.now() - started));
      if (!res.ok) {
        setError(data?.error?.message || 'Request failed');
        return;
      }
      setResponse(data.choices?.[0]?.message?.content || '(empty response)');
    } catch (err) {
      setLatencyMs(Math.round(performance.now() - started));
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      <div className="section-heading">
        <div>
          <p className="eyebrow">Playground</p>
          <h2>Test a provider and model</h2>
        </div>
      </div>
      <p className="muted">
        Sends one request straight to the selected provider instance via <code>/v1/chat/completions</code>,
        bypassing routing pools and pins so you can confirm a specific combination works.
      </p>
      <form onSubmit={send} className="stack">
        <div className="routing-pin-fields">
          <select value={activeProvider?.name || ''} onChange={event => setProviderName(event.target.value)} aria-label="Playground provider">
            {providers.map(provider => (
              <option key={provider.name} value={provider.name}>{provider.label || provider.name}</option>
            ))}
          </select>
          <select value={modelId} onChange={event => setModelId(event.target.value)} aria-label="Playground model">
            {models.map(model => (
              <option key={model.id} value={model.id}>{model.name || model.id}</option>
            ))}
          </select>
        </div>
        <Field label="Prompt">
          <textarea value={prompt} onChange={event => setPrompt(event.target.value)} rows={3} />
        </Field>
        <div className="actions">
          <Button type="submit" disabled={sending || !activeProvider || !modelId.trim()}>{sending ? 'Sending…' : 'Send'}</Button>
          {latencyMs !== null ? <small className="muted">{latencyMs}ms</small> : null}
        </div>
      </form>
      {error ? <p className="callout warning">{error}</p> : null}
      {response ? <pre className="playground-response">{response}</pre> : null}
    </Card>
  );
}

function AnalyticsPanel({ providers, logs }: { providers: ProviderStats[]; logs: LogEntry[] }) {
  const modelStats = new Map<string, { count: number; totalDuration: number; provider: string }>();
  logs.forEach(log => {
    if (!log.model) return;
    const stat = modelStats.get(log.model) || { count: 0, totalDuration: 0, provider: log.provider };
    stat.count += 1;
    stat.totalDuration += log.duration || 0;
    modelStats.set(log.model, stat);
  });

  const usage = [...modelStats.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 5);
  const latency = [...modelStats.entries()]
    .map(([name, stat]) => ({ name, avg: stat.count ? Math.round(stat.totalDuration / stat.count) : 0, provider: stat.provider }))
    .filter(item => item.avg > 0)
    .sort((a, b) => a.avg - b.avg)
    .slice(0, 5);
  const quality = Array.from(new Map(providers.flatMap(provider => provider.models
    .filter(model => model.score)
    .map(model => [model.id, { ...model, provider: provider.name }])).values()))
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 5);

  return (
    <section className="grid grid-3">
      <MetricCard title="Most Popular" empty="No requests yet" rows={usage.map(([name, stat]) => ({ label: name, value: `${stat.count} reqs`, tone: providerTone(stat.provider) }))} />
      <MetricCard title="Fastest Models" empty="No latency yet" rows={latency.map(item => ({ label: item.name, value: `${item.avg}ms`, tone: providerTone(item.provider) }))} />
      <MetricCard title="Quality Leaders" empty="No scores available" rows={quality.map(model => ({ label: model.name || model.id, value: `${model.score} Elo`, tone: providerTone(model.provider) }))} />
    </section>
  );
}

function MetricCard({ title, empty, rows }: { title: string; empty: string; rows: Array<{ label: string; value: string; tone: string }> }) {
  return (
    <Card>
      <h2>{title}</h2>
      {rows.length ? rows.map(row => (
        <div className="metric-row" key={row.label}>
          <span><i className={`provider-bg-${row.tone}`} />{row.label}</span>
          <strong>{row.value}</strong>
        </div>
      )) : <p className="muted">{empty}</p>}
    </Card>
  );
}

function TunnelBanner({ tunnel, clientAuth }: { tunnel?: TunnelInfo; clientAuth?: ClientAuthInfo }) {
  if (!tunnel?.enabled) return null;

  if (tunnel.state === 'starting') {
    return (
      <div className="notice tunnel-banner">
        <strong>Starting Cloudflare tunnel…</strong>
        <span>Cloud clients cannot reach localhost — Leyline is publishing a public URL via cloudflared.</span>
      </div>
    );
  }

  if (tunnel.state === 'error') {
    return (
      <div className="notice tunnel-banner tunnel-banner-error">
        <strong>Cloudflare tunnel unavailable</strong>
        <span>{tunnel.error || 'Install cloudflared or set LEYLINE_TUNNEL_ENABLED=false.'}</span>
        {tunnel.localUrl ? <code className="empty-state-command">Local only: {tunnel.localUrl}</code> : null}
      </div>
    );
  }

  if (tunnel.state !== 'ready' || !tunnel.publicBaseUrl) return null;

  return (
    <div className="notice tunnel-banner tunnel-banner-ready">
      <strong>Public endpoint ready</strong>
      <span>Use this URL for cloud clients (Cursor, remote agents) that block private networks.</span>
      <div className="secret-list">
        <SecretValue label="OpenAI baseURL" value={tunnel.publicBaseUrl} />
        <SecretValue label="API key" value={clientAuth?.apiKey} secret />
      </div>
      {clientAuth?.generated ? <small>Generated for this server session. Restarting Leyline rotates it.</small> : null}
      {tunnel.publicUrl ? <code className="empty-state-command">Dashboard: {tunnel.publicUrl}/dashboard</code> : null}
    </div>
  );
}

function LogsPanel({ logs, tunnel, clientAuth }: { logs: LogEntry[]; tunnel?: TunnelInfo; clientAuth?: ClientAuthInfo }) {
  const sortedLogs = [...logs].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, 50);
  const hasLogs = sortedLogs.length > 0;
  const endpointBase = tunnel?.publicBaseUrl || 'http://localhost:3417/v1';
  const authToken = clientAuth?.apiKey || 'leyline';
  const exampleCurl = `curl -X POST ${endpointBase}/chat/completions -H 'Authorization: Bearer ${authToken}' -H 'Content-Type: application/json' -d '{"model":"auto","messages":[{"role":"user","content":"Hello Leyline"}]}'`;

  return (
    <Card>
      <div className="section-heading">
        <div>
          <p className="eyebrow">Activity</p>
          <h2>Recent request logs</h2>
        </div>
      </div>
      {!hasLogs ? (
        <div className="empty-state">
          <strong>No requests yet</strong>
          <span>Send a chat completion through the router and it will appear here.</span>
          <code className="empty-state-command">{exampleCurl}</code>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Request</th>
                <th>Provider</th>
                <th>Model</th>
                <th>Status</th>
                <th>Duration</th>
                <th>Usage</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {sortedLogs.map((log, index) => (
                <tr key={`${log.timestamp}-${log.provider}-${index}`}>
                  <td>{formatLogTime(log.timestamp)}</td>
                  <td><code>{log.requestId || '-'}</code></td>
                  <td><strong className={`provider-text-${providerTone(log.provider)}`}>{log.provider}</strong></td>
                  <td>{log.model || '-'}</td>
                  <td><Badge tone={statusTone(log.status)}>{log.status}</Badge></td>
                  <td>{log.duration ? `${log.duration}ms` : '-'}</td>
                  <td>{formatLogUsage(log.usage)}</td>
                  <td title={log.error || undefined}>{truncateLogError(log.error)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
