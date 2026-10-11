import { useEffect, useState } from 'react';
import { Bell, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ToneBadge, when } from '@/components/common';
import { api } from '@/api';

export type AlertSettings = { thresholds: number[]; keyThresholds: number[]; emails: string[]; webhookUrl: string | null; email: boolean };
export type Alert = {
  id: string; at: number; kind: 'budget' | 'key' | 'test'; month: string; threshold: number; usd: number; limitUsd: number;
  keyName?: string; message: string; delivery?: { email?: string; webhook?: string };
};
type AlertsResponse = { log: Alert[]; settings: AlertSettings; emailAvailable: boolean; to: string[] };

const list = (v: string) => v.split(',').map(s => s.trim()).filter(Boolean);
const deliveryTone = (d?: string) => (d === 'sent' ? 'success' : d === 'off' || !d ? 'neutral' : 'danger');

/** The latest alert at or over 80% of the monthly limit this month, for a banner. */
export function urgentAlert(log: Alert[]): Alert | undefined {
  return log.find(a => a.kind === 'budget' && a.threshold >= 80);
}

export function AlertsCard({ onLog }: { onLog?: (log: Alert[]) => void }) {
  const [data, setData] = useState<AlertsResponse | null>(null);
  const [email, setEmail] = useState(true);
  const [emails, setEmails] = useState('');
  const [webhook, setWebhook] = useState('');
  const [thresholds, setThresholds] = useState('');
  const [keyThresholds, setKeyThresholds] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const r = await api<AlertsResponse>('/admin/api/alerts');
    setData(r);
    onLog?.(r.log);
    setEmail(r.settings.email);
    setEmails(r.settings.emails.join(', '));
    setWebhook(r.settings.webhookUrl ?? '');
    setThresholds(r.settings.thresholds.join(', '));
    setKeyThresholds(r.settings.keyThresholds.join(', '));
  };
  useEffect(() => { load().catch(error => toast.error(error instanceof Error ? error.message : 'Could not load alerts')); }, []);

  const draft: AlertSettings = {
    email,
    emails: list(emails),
    webhookUrl: webhook.trim() || null,
    thresholds: list(thresholds).map(Number),
    keyThresholds: list(keyThresholds).map(Number),
  };
  // Field by field: the server's object lists its keys in another order.
  const same = (a: AlertSettings, b: AlertSettings) => a.email === b.email && a.webhookUrl === b.webhookUrl
    && a.emails.join() === b.emails.join() && a.thresholds.join() === b.thresholds.join() && a.keyThresholds.join() === b.keyThresholds.join();
  const dirty = data !== null && !same(draft, data.settings);

  async function save() {
    setBusy(true);
    try {
      await api('/admin/api/settings', { method: 'PUT', body: { alerts: draft } });
      await load();
      toast.success('Alert settings saved.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    try {
      const { alert } = await api<{ alert: Alert }>('/admin/api/alerts/test', { method: 'POST' });
      const parts = [`email: ${alert.delivery?.email}`, `webhook: ${alert.delivery?.webhook}`];
      (alert.delivery?.email === 'sent' || alert.delivery?.webhook === 'sent' ? toast.success : toast.error)(`Test alert — ${parts.join(', ')}`);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not send a test');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="gap-3 xl:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Bell className="size-4" />Alerts</CardTitle>
        <CardDescription>Once per month for each threshold crossed: of the monthly limit, and of an access key's own dollars-a-month cap.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 lg:grid-cols-2">
        <div className="grid gap-4">
          <label className="flex items-start justify-between gap-3 rounded-lg border p-3">
            <span className="grid gap-0.5">
              <span className="text-sm font-medium">Email</span>
              <span className="text-xs text-muted-foreground">
                {data && !data.emailAvailable ? 'Not available on this host.' : `To ${list(emails).length ? list(emails).join(', ') : `the admins (${data?.to.join(', ') ?? '…'})`}.`}
              </span>
            </span>
            <Switch checked={email} onCheckedChange={setEmail} aria-label="Email alerts" />
          </label>
          <div className="grid gap-1.5">
            <Label htmlFor="alert-emails">Send to (comma-separated; empty: the admins)</Label>
            <Input id="alert-emails" value={emails} onChange={e => setEmails(e.target.value)} placeholder={data?.to.join(', ')} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="alert-webhook">Webhook (Slack, Discord, or any JSON POST)</Label>
            <Input id="alert-webhook" value={webhook} onChange={e => setWebhook(e.target.value)} placeholder="https://hooks.slack.com/services/…" autoComplete="off" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="alert-thresholds">Monthly limit at (%)</Label>
              <Input id="alert-thresholds" value={thresholds} onChange={e => setThresholds(e.target.value)} placeholder="50, 80, 100" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="alert-key-thresholds">Each key's cap at (%)</Label>
              <Input id="alert-key-thresholds" value={keyThresholds} onChange={e => setKeyThresholds(e.target.value)} placeholder="80, 100" />
            </div>
          </div>
        </div>
        <div className="grid content-start gap-2">
          <Label>This month</Label>
          {data?.log.length ? (
            <div className="grid max-h-80 gap-2 overflow-y-auto">
              {data.log.map(a => (
                <div key={`${a.id}-${a.at}`} className="rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <ToneBadge tone={a.kind === 'test' ? 'neutral' : a.threshold >= 100 ? 'danger' : a.threshold >= 80 ? 'warning' : 'neutral'}>
                      {a.kind === 'test' ? 'Test' : a.kind === 'key' ? `Key ${a.threshold}%` : `Limit ${a.threshold}%`}
                    </ToneBadge>
                    <span className="text-xs text-muted-foreground">{when(a.at)}</span>
                  </div>
                  <p className="mt-1.5">{a.message}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <ToneBadge tone={deliveryTone(a.delivery?.email)}>email: {a.delivery?.email ?? 'sending…'}</ToneBadge>
                    <ToneBadge tone={deliveryTone(a.delivery?.webhook)}>webhook: {a.delivery?.webhook ?? 'sending…'}</ToneBadge>
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-muted-foreground">No alerts this month.</p>}
        </div>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button onClick={save} disabled={!dirty || busy}>Save</Button>
        <Button variant="outline" onClick={test} disabled={busy || dirty}><Send />Send a test alert</Button>
        {dirty ? <span className="text-xs text-muted-foreground">Save before testing.</span> : null}
      </CardFooter>
    </Card>
  );
}
