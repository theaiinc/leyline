import { Activity, Gauge, KeyRound, Server } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CodeBlock, EmptyState, PageHeader, ProviderDot, SecretValue } from '@/components/common';
import { apiUrl } from '@/api';
import type { Dashboard } from '@/hooks/use-dashboard';
import { providerTone, type LogEntry, type ProviderStats } from '@/normalization';

function Stat({ icon: Icon, label, value, hint }: { icon: typeof Activity; label: string; value: string; hint?: string }) {
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="px-4">
        <CardDescription className="flex items-center gap-2"><Icon className="size-4" />{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      {hint ? <CardContent className="px-4 text-xs text-muted-foreground">{hint}</CardContent> : null}
    </Card>
  );
}

function ready(p: ProviderStats): boolean {
  return !(p.apiKeyConfigurable && !p.apiKeyConfigured) && p.runtimeReady !== false;
}

function MetricCard({ title, empty, rows }: { title: string; empty: string; rows: Array<{ label: string; value: string; tone: string }> }) {
  return (
    <Card className="gap-3">
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {rows.length ? rows.map(row => (
          <div key={row.label} className="flex items-center justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2"><ProviderDot tone={row.tone} /><span className="truncate">{row.label}</span></span>
            <span className="shrink-0 font-medium tabular-nums">{row.value}</span>
          </div>
        )) : <p className="text-sm text-muted-foreground">{empty}</p>}
      </CardContent>
    </Card>
  );
}

function analytics(providers: ProviderStats[], logs: LogEntry[]) {
  const byModel = new Map<string, { count: number; total: number; provider: string }>();
  for (const log of logs) {
    if (!log.model) continue;
    const s = byModel.get(log.model) ?? { count: 0, total: 0, provider: log.provider };
    s.count += 1;
    s.total += log.duration || 0;
    byModel.set(log.model, s);
  }
  const popular = [...byModel].sort((a, b) => b[1].count - a[1].count).slice(0, 5)
    .map(([label, s]) => ({ label, value: `${s.count} reqs`, tone: providerTone(s.provider) }));
  const fastest = [...byModel].map(([label, s]) => ({ label, avg: s.count ? Math.round(s.total / s.count) : 0, provider: s.provider }))
    .filter(x => x.avg > 0).sort((a, b) => a.avg - b.avg).slice(0, 5)
    .map(x => ({ label: x.label, value: `${x.avg}ms`, tone: providerTone(x.provider) }));
  const quality = [...new Map(providers.flatMap(p => p.models.filter(m => m.score).map(m => [m.id, { ...m, provider: p.name }] as const))).values()]
    .sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5)
    .map(m => ({ label: m.name || m.id, value: `${m.score} Elo`, tone: providerTone(m.provider) }));
  return { popular, fastest, quality };
}

export function OverviewPage({ d, go }: { d: Dashboard; go: (page: string) => void }) {
  const { stats, session } = d;
  const providers = stats.providers;
  const readyCount = providers.filter(ready).length;
  const logs = stats.logs;
  const ok = logs.filter(l => l.status === 'success').length;
  const durations = logs.map(l => l.duration || 0).filter(Boolean);
  const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
  const { popular, fastest, quality } = analytics(providers, logs);
  const tunnel = stats.tunnel;
  const base = session?.hosted ? (session.publicUrl || window.location.origin) : tunnel?.publicBaseUrl?.replace(/\/v1$/, '') || apiUrl('');

  return (
    <>
      <PageHeader title="Overview" description="Provider health, traffic, and how clients connect to this Leyline." />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={Server} label="Providers ready" value={`${readyCount} / ${providers.length}`} hint="Keys and runtime settings in place" />
        <Stat icon={Activity} label="Recent requests" value={String(logs.length)} hint="Kept in memory since the server started" />
        <Stat icon={Gauge} label="Success rate" value={logs.length ? `${Math.round((100 * ok) / logs.length)}%` : '—'} />
        <Stat icon={KeyRound} label="Avg latency" value={avg ? `${avg}ms` : '—'} />
      </div>

      {tunnel?.enabled && tunnel.state === 'starting' ? (
        <Alert className="mt-6"><AlertTitle>Starting Cloudflare tunnel…</AlertTitle><AlertDescription>Leyline is publishing a public URL via cloudflared so cloud clients can reach it.</AlertDescription></Alert>
      ) : null}
      {tunnel?.enabled && tunnel.state === 'error' ? (
        <Alert variant="destructive" className="mt-6"><AlertTitle>Cloudflare tunnel unavailable</AlertTitle><AlertDescription>{tunnel.error || 'Install cloudflared or set LEYLINE_TUNNEL_ENABLED=false.'}</AlertDescription></Alert>
      ) : null}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Connect a client</CardTitle>
          <CardDescription>
            {session?.hosted
              ? <>People use keys you hand out on <button className="underline underline-offset-4" onClick={() => go('keys')}>Access keys</button>. Any OpenAI- or Anthropic-compatible agent works.</>
              : 'Point any OpenAI-compatible client at this endpoint.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {session?.hosted ? (
            <>
              <SecretValue label="OpenAI base URL" value={`${base}/v1`} />
              <SecretValue label="Anthropic base URL" value={base} />
              <CodeBlock>{`# Claude Code\nexport ANTHROPIC_BASE_URL=${base}\nexport ANTHROPIC_AUTH_TOKEN=ll_…   # an access key\nclaude`}</CodeBlock>
            </>
          ) : (
            <>
              <SecretValue label="OpenAI base URL" value={tunnel?.publicBaseUrl || `${base}/v1`} />
              <SecretValue label="API key" value={stats.clientAuth?.apiKey} secret />
              {stats.clientAuth?.generated ? <p className="text-xs text-muted-foreground">Generated for this server session; restarting Leyline rotates it.</p> : null}
            </>
          )}
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <MetricCard title="Most popular" empty="No requests yet" rows={popular} />
        <MetricCard title="Fastest models" empty="No latency yet" rows={fastest} />
        <MetricCard title="Quality leaders" empty="No scores available" rows={quality} />
      </div>

      {providers.length === 0 && !d.waiting ? <div className="mt-6"><EmptyState title="No providers registered" /></div> : null}
    </>
  );
}
