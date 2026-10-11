import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, PageHeader, ProviderDot, fmt } from '@/components/common';
import { api, type IssuedKey } from '@/api';
import { money } from '@/pages/keys';
import { providerTone } from '@/normalization';
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

const share = (part: number, total: number) => (total > 0 ? `${Math.round((100 * part) / total)}%` : '—');

export function SpendingPage() {
  const [month, setMonth] = useState<string | null>(null);
  const [data, setData] = useState<SpendResponse | null>(null);
  const [keys, setKeys] = useState<IssuedKey[]>([]);
  const [alertLog, setAlertLog] = useState<Alert[]>([]);
  const urgent = urgentAlert(alertLog);

  useEffect(() => {
    api<SpendResponse>(`/admin/api/spend${month ? `?month=${month}` : ''}`)
      .then(setData)
      .catch(error => toast.error(error instanceof Error ? error.message : 'Could not load spending'));
  }, [month]);
  useEffect(() => {
    api<{ keys: IssuedKey[] }>('/admin/api/keys').then(r => setKeys(r.keys)).catch(() => undefined);
  }, []);

  const spend = data?.spend;
  const current = !month || month === data?.months[0];
  const months = data ? [...new Set([spend!.month, ...data.months])] : [];
  const providers = Object.entries(spend?.byProvider ?? {}).sort((a, b) => b[1].usd - a[1].usd || b[1].requests - a[1].requests);
  const models = Object.values(spend?.byModel ?? {}).sort((a, b) => b.usd - a.usd || b.requests - a.requests);
  const byKey = keys.filter(k => (k.usage?.requests ?? 0) > 0).sort((a, b) => (b.usage?.usd ?? 0) - (a.usage?.usd ?? 0));
  const unattributed = spend ? spend.requests - providers.reduce((n, [, l]) => n + l.requests, 0) : 0;

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
          <AlertTitle>{urgent.threshold >= 100 ? 'Monthly limit reached' : `${urgent.threshold}% of the monthly limit spent`}</AlertTitle>
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
                  <span className="text-xs text-muted-foreground">of the ${data.monthlyBudgetUsd} monthly limit</span>
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

          {spend.requests === 0 ? <div className="mt-6 grid gap-4"><EmptyState title={`Nothing spent in ${spend.month}`} /><AlertsCard onLog={setAlertLog} /></div> : (
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
                        <TableRow key={`${l.provider}/${l.model}`}>
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
                            <TableCell className="text-right tabular-nums">{money(k.usage?.usd ?? 0)}{k.caps.usdPerMonth ? <span className="text-muted-foreground"> / ${k.caps.usdPerMonth}</span> : null}</TableCell>
                            <TableCell className="text-right tabular-nums">{fmt(k.usage?.requests ?? 0)}</TableCell>
                            <TableCell className="pr-6 text-xs text-muted-foreground">
                              {Object.entries(k.usage?.byModel ?? {}).sort((a, b) => (b[1].usd ?? 0) - (a[1].usd ?? 0)).map(([m, l]) => `${m} ${money(l.usd ?? 0)}`).join(' · ')}
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
