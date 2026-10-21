import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, PageHeader, ProviderDot, fmt } from '@/components/common';
import { api, type IssuedKey } from '@/api';
import { money } from '@/pages/keys';
import { providerTone } from '@/normalization';
import { shapeDailySpend } from '@/lib/spending-shaping';
import { Alert as AlertBox, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertsCard, urgentAlert, type Alert } from '@/pages/alerts-card';

type Line = { usd: number; requests: number; tokens: number };
type Spend = {
  month: string;
  usd: number;
  requests: number;
  tokens?: number;
  byProvider?: Record<string, Line>;
  byModel?: Record<string, Line & { provider: string; model: string }>;
};
type SpendResponse = { spend: Spend; months: string[]; monthlyBudgetUsd: number | null };
const DAILY_DATA_START = '2026-10-21';
const lineLabel = (id: string) => {
  if (!id.includes('/')) return id;
  const [provider, ...model] = id.split('/');
  return `${model.join('/')} (${provider})`;
};
const chartColor = (id: string, index: number) => {
  if (id === 'Other') return 'hsl(var(--muted-foreground))';
  const provider = id.split('/')[0];
  const tone = providerTone(provider);
  return `hsl(${tone} ${Math.max(35, 62 - (index % 3) * 10)}%)`;
};

const share = (part: number, total: number) => {
  return total > 0 ? String(Math.round((100 * part) / total)) + '%' : '—';
};

export function SpendingPage() {
  const [month, setMonth] = useState<string | null>(null);
  const [data, setData] = useState<SpendResponse | null>(null);
  const [keys, setKeys] = useState<IssuedKey[]>([]);
  const [alertLog, setAlertLog] = useState<Alert[]>([]);

  useEffect(() => {
    api<SpendResponse>('/admin/api/spend' + (month ? '?month=' + month : ''))
      .then(setData)
      .catch(error => toast.error(error instanceof Error ? error.message : 'Could not load spending'));
  }, [month]);
  useEffect(() => {
    api<{ keys: IssuedKey[] }>('/admin/api/keys').then(r => setKeys(r.keys)).catch(() => undefined);
  }, []);

  const spend = data?.spend;
  const current = !month || month === data?.months[0];
  const currentLimit = current ? data?.monthlyBudgetUsd : null;
  const urgent = currentLimit && spend && spend.usd >= currentLimit * 0.8
    ? urgentAlert(alertLog, spend.usd, currentLimit)
    : undefined;
  const months = data ? [...new Set([spend!.month, ...data.months])] : [];
  const providers = Object.entries(spend?.byProvider ?? {}).sort((a, b) => b[1].usd - a[1].usd || b[1].requests - a[1].requests);
  const models = Object.values(spend?.byModel ?? {}).sort((a, b) => b.usd - a.usd || b.requests - a.requests);
  const byKey = keys.filter(k => (k.usage?.requests ?? 0) > 0).sort((a, b) => (b.usage?.usd ?? 0) - (a.usage?.usd ?? 0));
  const unattributed = spend ? spend.requests - providers.reduce((n, [, l]) => n + l.requests, 0) : 0;
  const [chartMode, setChartMode] = useState<'usd' | 'tokens'>('usd');
  const daily = useMemo(() => spend ? shapeDailySpend(spend, chartMode) : null, [spend, chartMode]);

  return (
    <>
      <PageHeader
        title="Spending"
        description="What requests through this Leyline cost, by the provider that served them and the model that answered, at the prices set on Offered models."
        actions={months.length ? (
          <Select value={spend?.month} onValueChange={setMonth}>
            <SelectTrigger className="w-36" aria-label="Month"><SelectValue /></SelectTrigger>
            <SelectContent>{months.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
          </Select>
        ) : null}
      />

      {urgent ? (
        <AlertBox variant={urgent.threshold >= 100 ? 'destructive' : 'default'} className="mb-4">
          <AlertTitle>{urgent.threshold >= 100 ? 'Monthly limit reached' : String(urgent.threshold) + '% of the monthly limit spent'}</AlertTitle>
          <AlertDescription>{urgent.message}</AlertDescription>
        </AlertBox>
      ) : null}
      {spend ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card className="gap-2 py-4">
              <CardHeader className="px-4"><CardDescription>Spent in {spend.month}</CardDescription><CardTitle className="text-2xl tabular-nums">{money(spend.usd)}</CardTitle></CardHeader>
              {current && data?.monthlyBudgetUsd ? (
                <CardContent className="grid gap-1.5 px-4">
                  <Progress value={Math.min(100, (100 * spend.usd) / data.monthlyBudgetUsd)} className="h-1.5" />
                  <span className="text-xs text-muted-foreground">{'of the $' + data.monthlyBudgetUsd + ' monthly limit'}</span>
                </CardContent>
              ) : null}
            </Card>
            <Card className="gap-2 py-4">
              <CardHeader className="px-4"><CardDescription>Requests</CardDescription><CardTitle className="text-2xl tabular-nums">{fmt(spend.requests)}</CardTitle></CardHeader>
            </Card>
            <Card className="gap-2 py-4">
              <CardHeader className="px-4"><CardDescription>Tokens</CardDescription><CardTitle className="text-2xl tabular-nums">{fmt(spend.tokens ?? 0)}</CardTitle></CardHeader>
            </Card>
          </div>

          {spend.byDay ? (
            <Card className="mt-6 gap-3">
              <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div>
                  <CardTitle>Daily spend</CardTitle>
                  <CardDescription>Top six provider/model lines for {spend.month}; the remainder is grouped as Other.</CardDescription>
                </div>
                <div className="flex gap-1 rounded-md border p-1">
                  <button type="button" className={chartMode === 'usd' ? 'rounded bg-muted px-2 py-1 text-xs font-medium' : 'rounded px-2 py-1 text-xs'} onClick={() => setChartMode('usd')}>Dollars</button>
                  <button type="button" className={chartMode === 'tokens' ? 'rounded bg-muted px-2 py-1 text-xs font-medium' : 'rounded px-2 py-1 text-xs'} onClick={() => setChartMode('tokens')}>Tokens</button>
                </div>
              </CardHeader>
              <CardContent>
                {daily?.points.length ? (
                  <div className="overflow-x-auto">
                    <div className="flex h-56 min-w-[640px] items-end gap-1 border-b border-l p-3">
                      {(() => {
                        const maxTotal = Math.max(...daily.points.map((item) => daily.series.reduce((sum, id) => sum + Number(item[id] ?? 0), 0)));
                        return daily.points.map((point) => {
                          const total = daily.series.reduce((sum, id) => sum + Number(point[id] ?? 0), 0);
                          const tooltip = Object.entries(spend.byDay?.[point.day] ?? {}).map(([id, line]) => `${lineLabel(id)} ${chartMode === 'usd' ? money(line.usd) : fmt(line.tokens) + ' tokens'}`).join('; ');
                          const barHeight = total && maxTotal ? Math.max(2, (100 * total) / maxTotal) : 0;
                        return (
                          <div key={point.day} className="group flex h-full flex-1 flex-col justify-end" title={`${point.day}: ${tooltip}`}>
                            <div className="flex flex-col justify-end" style={{ height: String(barHeight) + '%' }}>
                              {daily.series.map((id, index) => {
                                const value = Number(point[id] ?? 0);
                                const segmentHeight = total ? (100 * value) / total : 0;
                                return <div key={id} className="min-h-0" style={{ height: String(segmentHeight) + '%', backgroundColor: chartColor(id, index) }} title={lineLabel(id) + ': ' + (chartMode === 'usd' ? money(value) : fmt(value))} />;
                              })}
                            </div>
                            <span className="mt-1 truncate text-[10px] text-muted-foreground">{point.day.slice(8)}</span>
                          </div>
                          );
                        });
                      })()}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {daily.series.map((id, index) => <span key={id}><i className="mr-1 inline-block size-2 rounded-sm" style={{ backgroundColor: chartColor(id, index) }} />{lineLabel(id)}</span>)}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No daily spend recorded for this month. Daily breakdown starts {DAILY_DATA_START}; earlier monthly totals are not backfilled.</p>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card className="mt-6">
              <CardContent className="pt-6 text-sm text-muted-foreground">Daily breakdown starts {DAILY_DATA_START}; earlier monthly totals are not backfilled.</CardContent>
            </Card>
          )}

          {spend.requests === 0 ? (
            <div className="mt-6 grid gap-4">
              <EmptyState title={'Nothing spent in ' + spend.month} />
              <AlertsCard onLog={setAlertLog} />
            </div>
          ) : (
            <div className="mt-6 grid gap-4 xl:grid-cols-2">
              <Card className="gap-3">
                <CardHeader><CardTitle>By provider</CardTitle></CardHeader>
                <CardContent className="overflow-x-auto px-0">
                  <Table>
                    <TableHeader><TableRow><TableHead className="pl-6">Provider</TableHead><TableHead className="text-right">Spent</TableHead><TableHead className="text-right">Share</TableHead><TableHead className="text-right">Requests</TableHead><TableHead className="pr-6 text-right">Tokens</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {providers.map(([name, l]) => (
                        <TableRow key={name}>
                          <TableCell className="pl-6"><span className="flex items-center gap-2"><ProviderDot tone={providerTone(name.split(':')[0])} />{name}</span></TableCell>
                          <TableCell className="text-right tabular-nums">{money(l.usd)}</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">{share(l.usd, spend.usd)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmt(l.requests)}</TableCell>
                          <TableCell className="pr-6 text-right tabular-nums">{fmt(l.tokens)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {unattributed > 0 ? <p className="px-6 pt-3 text-xs text-muted-foreground">{fmt(unattributed)} earlier request{unattributed === 1 ? '' : 's'} this month were recorded before spend was split by provider.</p> : null}
                </CardContent>
              </Card>

              <Card className="gap-3">
                <CardHeader><CardTitle>By model</CardTitle></CardHeader>
                <CardContent className="overflow-x-auto px-0">
                  <Table>
                    <TableHeader><TableRow><TableHead className="pl-6">Model</TableHead><TableHead className="text-right">Spent</TableHead><TableHead className="text-right">Requests</TableHead><TableHead className="text-right">Tokens</TableHead><TableHead className="pr-6 text-right">Per request</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {models.map(l => (
                        <TableRow key={l.provider + '/' + l.model}>
                          <TableCell className="pl-6">
                            <div className="font-mono text-xs">{l.model}</div>
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><ProviderDot tone={providerTone(l.provider.split(':')[0])} className="size-2" />{l.provider}</div>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{money(l.usd)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmt(l.requests)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmt(l.tokens)}</TableCell>
                          <TableCell className="pr-6 text-right tabular-nums text-muted-foreground">{l.requests ? money(l.usd / l.requests) : '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              {current && byKey.length ? (
                <Card className="gap-3 xl:col-span-2">
                  <CardHeader><CardTitle>By access key</CardTitle><CardDescription>This month; the owner's playground isn't a key, so it shows only in the totals.</CardDescription></CardHeader>
                  <CardContent className="overflow-x-auto px-0">
                    <Table>
                      <TableHeader><TableRow><TableHead className="pl-6">Key</TableHead><TableHead className="text-right">Spent</TableHead><TableHead className="text-right">Requests</TableHead><TableHead className="pr-6">Models asked for</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {byKey.map(k => (
                          <TableRow key={k.id}>
                            <TableCell className="pl-6"><div className="font-medium">{k.name}</div><code className="font-mono text-xs text-muted-foreground">{k.prefix}…</code></TableCell>
                            <TableCell className="text-right tabular-nums">
                              {money(k.usage?.usd ?? 0)}
                              {k.caps.usdPerMonth ? (
                                <span className="text-muted-foreground">{' / $' + k.caps.usdPerMonth}</span>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{fmt(k.usage?.requests ?? 0)}</TableCell>
                            <TableCell className="pr-6 text-xs text-muted-foreground">
                              {Object.entries(k.usage?.byModel ?? {}).sort((a, b) => (b[1].usd ?? 0) - (a[1].usd ?? 0)).map(([m, l]) => m + " " + money(l.usd ?? 0)).join(" · ")}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              ) : null}
              <AlertsCard onLog={setAlertLog} />
            </div>
          )}
        </>
      ) : null}
    </>
  );
}
