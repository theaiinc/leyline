import React, { FormEvent, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import {
  ApiKeyStatusResponse,
  formatLogTime,
  formatLogUsage,
  LogEntry,
  normalizeApiKeyStatusResponse,
  normalizeStatsResponse,
  PersistenceMode,
  providerDescription,
  providerStatusLabel,
  providerTone,
  ProviderStats,
  sourceLabel,
  StatsResponse,
  statusTone,
  TunnelInfo,
} from './normalization';

const LOCAL_KEY_PREFIX = 'leyline.apiKey.';
const LOCAL_MODE_PREFIX = 'leyline.persistence.';
const LOCAL_RUNTIME_PREFIX = 'leyline.runtime.';
const LOG_ERROR_MAX_LENGTH = 60;

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

function App() {
  const [status, setStatus] = useState<ApiKeyStatusResponse | null>(null);
  const [stats, setStats] = useState<StatsResponse>({ providers: [], logs: [] });
  const [selectedProvider, setSelectedProvider] = useState('');
  const [persistenceMode, setPersistenceMode] = useState<PersistenceMode>('keychain');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [message, setMessage] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [rehydrated, setRehydrated] = useState(false);

  const providers = status?.providers || [];
  const persistence = status?.persistence;
  const activeProvider = providers.find(provider => provider.name === selectedProvider) || providers[0];
  const keychainAvailable = Boolean(persistence?.modes.keychain.available);

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

  async function fetchApiKeyStatus() {
    const response = await fetch('/dashboard/api-keys');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to fetch API key status');
    const normalized = normalizeApiKeyStatusResponse(data);
    setStatus(normalized);
    if (!selectedProvider) {
      const preferred = normalized.routing?.fixedProvider
        || normalized.providers.find(p => p.name === 'AzureOpenAI' && p.configured)?.name
        || normalized.providers[0]?.name;
      if (preferred) setSelectedProvider(preferred);
    }
    return normalized;
  }

  async function fetchStats() {
    const response = await fetch('/dashboard/stats');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to fetch dashboard stats');
    setStats(normalizeStatsResponse(data));
  }

  async function rehydrateLocalKeys(data: ApiKeyStatusResponse) {
    if (!localStorageAvailable) return;

    await Promise.all(data.providers.map(async provider => {
      if (window.localStorage.getItem(localModeKey(provider.name)) !== 'localStorage') return;
      const storedKey = window.localStorage.getItem(localKey(provider.name));
      if (!storedKey) return;

      const response = await fetch('/dashboard/api-keys', {
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

      const response = await fetch('/dashboard/api-keys', {
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
      try {
        const data = await fetchApiKeyStatus();
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
    const interval = window.setInterval(fetchStats, 5000);
    return () => window.clearInterval(interval);
  }, [rehydrated]);

  useEffect(() => {
    if (!activeProvider) return;

    const savedMode = localStorageAvailable
      ? window.localStorage.getItem(localModeKey(activeProvider.name)) as PersistenceMode | null
      : null;
    const nextMode = savedMode || (keychainAvailable ? 'keychain' : 'localStorage');

    setPersistenceMode(nextMode);
    setBaseUrl(activeProvider.runtimeConfig?.baseUrl || '');
    setModel(activeProvider.runtimeConfig?.model || activeProvider.defaultModel || '');
    setApiKey('');
  }, [activeProvider?.name, persistence?.modes.keychain.available]);

  async function saveKey(event: FormEvent) {
    event.preventDefault();
    if (!activeProvider) return;
    if (!apiKey.trim()) {
      setMessage('Paste a key before saving. Blank keys never clear an existing key.');
      return;
    }
    if (persistenceMode === 'localStorage' && !localStorageAvailable) {
      setMessage('localStorage is not available in this browser.');
      return;
    }

    setMessage('Saving API key...');
    const response = await fetch('/dashboard/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: activeProvider.name,
        apiKey,
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
    } else {
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
    const response = await fetch('/dashboard/api-keys', {
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
    const response = await fetch(`/dashboard/api-keys/${encodeURIComponent(activeProvider.name)}`, {
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

  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Leyline Router</p>
          <h1>Provider Control Center</h1>
          <p className="hero-copy">Configure provider keys, Azure runtime settings, quotas, model coverage, and recent request flow from one place.</p>
        </div>
        <Button variant="secondary" onClick={() => Promise.all([fetchApiKeyStatus(), fetchStats()])}>Refresh</Button>
      </header>

      {message ? <div className="notice" role="status" aria-live="polite">{message}</div> : null}

      <TunnelBanner tunnel={stats.tunnel} clientApiKey="leyline" />

      {status?.routing?.fixedProvider ? (
        <div className="notice">
          Router is pinned to <strong>{status.routing.fixedProvider}</strong>
          {status.routing.fixedModel ? <> / <code>{status.routing.fixedModel}</code></> : null}.
          Configure keys on that provider card — OpenAI and Azure OpenAI use separate Keychain entries.
        </div>
      ) : null}

      <section className="grid grid-3">
        {providers.map(provider => {
          const statusInfo = providerStatusLabel(provider);
          return (
          <button
            key={provider.name}
            type="button"
            className={cn('provider-card', activeProvider?.name === provider.name && 'provider-card-active')}
            onClick={() => setSelectedProvider(provider.name)}
          >
            <span className={cn('provider-dot', `provider-bg-${providerTone(provider.name)}`)} />
            <strong>{provider.name}</strong>
            <Badge tone={statusInfo.tone}>{statusInfo.label}</Badge>
            <small>{providerDescription(provider.name) || sourceLabel(provider.source)}</small>
          </button>
        );})}
      </section>

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
          {activeProvider?.name === 'AzureOpenAI' && activeProvider.configured && activeProvider.runtimeReady === false ? (
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

            <Field label="API key" hint="Saving a blank field is ignored. Use Clear key to remove a key.">
              <input
                type="password"
                value={apiKey}
                onChange={event => setApiKey(event.target.value)}
                placeholder="Paste API key"
                autoComplete="off"
              />
            </Field>
            <div className="actions">
              <Button type="submit">Save Key</Button>
              <Button type="button" variant="destructive" onClick={clearKey} disabled={!activeProvider?.configured}>Clear Key</Button>
            </div>
          </form>
        </Card>

        <Card>
          <div className="section-heading">
            <div>
              <p className="eyebrow">Runtime</p>
              <h2>{activeProvider?.name === 'AzureOpenAI' ? 'Azure OpenAI URL and deployment' : 'Provider runtime'}</h2>
            </div>
            <Badge tone={activeProvider?.runtimeConfigurable ? (activeProvider.runtimeReady ? 'success' : 'warning') : 'neutral'}>
              {activeProvider?.runtimeConfigurable ? (activeProvider.runtimeReady ? 'Ready' : 'Needs base URL') : 'Not applicable'}
            </Badge>
          </div>
          <p className="muted">
            {activeProvider?.name === 'AzureOpenAI'
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
            <Button type="submit" variant="secondary" disabled={!activeProvider?.runtimeConfigurable}>Save Settings</Button>
          </form>
        </Card>
      </section>

      <NetworkPanel providers={stats.providers} search={modelSearch} setSearch={setModelSearch} />
      <AnalyticsPanel providers={stats.providers} logs={stats.logs} />
      <LogsPanel logs={stats.logs} tunnel={stats.tunnel} />
    </main>
  );
}

function NetworkPanel({ providers, search, setSearch }: { providers: ProviderStats[]; search: string; setSearch: (value: string) => void }) {
  const normalizedSearch = search.toLowerCase();

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

              return (
                <tr key={provider.name}>
                  <td><strong className={`provider-text-${providerTone(provider.name)}`}>{provider.name}</strong></td>
                  <td><code>{provider.defaultModel}</code></td>
                  <td>
                    <details open={Boolean(search)}>
                      <summary>{filteredModels.length} / {provider.models.length} models</summary>
                      <div className="model-list">
                        {filteredModels.length ? filteredModels.map(model => (
                          <div key={model.id} className="model-row">
                            <strong>{model.name || model.id}</strong>
                            <small>{model.id}</small>
                            {model.description ? <small>{model.description}</small> : null}
                          </div>
                        )) : <span className="muted">No matching models</span>}
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

function TunnelBanner({ tunnel, clientApiKey }: { tunnel?: TunnelInfo; clientApiKey: string }) {
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
      <code className="empty-state-command">OpenAI baseURL: {tunnel.publicBaseUrl}</code>
      <code className="empty-state-command">API key: {clientApiKey}</code>
      {tunnel.publicUrl ? <code className="empty-state-command">Dashboard: {tunnel.publicUrl}/dashboard</code> : null}
    </div>
  );
}

function LogsPanel({ logs, tunnel }: { logs: LogEntry[]; tunnel?: TunnelInfo }) {
  const sortedLogs = [...logs].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, 50);
  const hasLogs = sortedLogs.length > 0;
  const endpointBase = tunnel?.publicBaseUrl || 'http://localhost:3000/v1';
  const exampleCurl = `curl -X POST ${endpointBase}/chat/completions -H 'Authorization: Bearer leyline' -H 'Content-Type: application/json' -d '{"model":"auto","messages":[{"role":"user","content":"Hello Leyline"}]}'`;

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
