import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CodeBlock, EmptyState, PageHeader, ProviderDot, ToneBadge } from '@/components/common';
import { apiUrl } from '@/api';
import type { Dashboard } from '@/hooks/use-dashboard';
import { formatLogTime, formatLogUsage, providerTone, statusTone } from '@/normalization';

export function ActivityPage({ d }: { d: Dashboard }) {
  const logs = [...d.stats.logs].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, 100);
  const base = d.session?.hosted ? `${d.session.publicUrl || window.location.origin}/v1` : d.stats.tunnel?.publicBaseUrl || apiUrl('/v1');
  const token = d.session?.hosted ? 'll_…' : d.stats.clientAuth?.apiKey || 'leyline';
  return (
    <>
      <PageHeader title="Activity" description="Recent requests through this Leyline (newest first, kept in memory)." />
      {logs.length === 0 ? (
        <EmptyState title="No requests yet">
          <p className="mb-3">Send a chat completion through the router and it shows up here.</p>
          <CodeBlock>{`curl -X POST ${base}/chat/completions \\\n  -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' \\\n  -d '{"model":"auto","messages":[{"role":"user","content":"Hello Leyline"}]}'`}</CodeBlock>
        </EmptyState>
      ) : (
        <Card className="py-0">
          <CardContent className="overflow-x-auto px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Time</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead>Usage</TableHead>
                  <TableHead className="pr-4">Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log, i) => (
                  <TableRow key={`${log.timestamp}-${log.provider}-${i}`}>
                    <TableCell className="pl-4 whitespace-nowrap" title={log.requestId}>{formatLogTime(log.timestamp)}</TableCell>
                    <TableCell><span className="flex items-center gap-2"><ProviderDot tone={providerTone(log.provider)} />{log.provider}</span></TableCell>
                    <TableCell className="font-mono text-xs">{log.model || '—'}</TableCell>
                    <TableCell><ToneBadge tone={statusTone(log.status)}>{log.status}</ToneBadge></TableCell>
                    <TableCell className="text-right tabular-nums">{log.duration ? `${log.duration}ms` : '—'}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatLogUsage(log.usage)}</TableCell>
                    <TableCell className="max-w-72 truncate pr-4 text-muted-foreground" title={log.error}>{log.error || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </>
  );
}
