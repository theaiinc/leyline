import { update, type DocStore, type IssuedKey, type IssuedKeys } from './issued-keys';

/**
 * Cost alerts for hosted Leyline: when this month's spend crosses a share of the monthly limit (50 / 80 / 100 % by
 * default), or an access key crosses a share of its own dollars-a-month cap (80 / 100 %), the owner hears about it
 * once — by email, a webhook (Slack, Discord, anything that takes a JSON POST) and on the dashboard.
 *
 * "Once" holds across Worker instances: each crossing is claimed in the store (compare-and-set) before it's sent.
 * Store: alerts/{yyyy-mm} = { sent: { "budget:80": at, "key:{id}:100": at }, log: [newest first] }.
 */

export type AlertSettings = {
  /** Percent of the monthly limit. */
  thresholds: number[];
  /** Percent of a key's own dollars-a-month cap. */
  keyThresholds: number[];
  /** Who gets the email; empty: the admin emails. */
  emails: string[];
  /** Slack / Discord / any JSON webhook; null: none. */
  webhookUrl: string | null;
  /** Email on/off (the webhook is off when there's no URL). */
  email: boolean;
};

export const DEFAULT_ALERTS: AlertSettings = { thresholds: [50, 80, 100], keyThresholds: [80, 100], emails: [], webhookUrl: null, email: true };

export type Alert = {
  id: string;
  at: number;
  kind: 'budget' | 'key' | 'test';
  month: string;
  threshold: number;
  usd: number;
  limitUsd: number;
  keyId?: string;
  keyName?: string;
  message: string;
  /** What happened on each channel: "sent", "off", or an error. */
  delivery?: { email?: string; webhook?: string };
};

type AlertDoc = { sent: Record<string, number>; log: Alert[] };

/** How the owner is reached: the host provides email (the Worker's Email Sending binding); the webhook is plain fetch. */
export type AlertChannels = {
  sendEmail?: (to: string[], subject: string, text: string) => Promise<void>;
  fetchImpl?: typeof fetch;
};

const percents = (v: unknown, fallback: number[]) => {
  if (!Array.isArray(v)) return fallback;
  const out = [...new Set(v.map(Number).filter((n) => Number.isFinite(n) && n > 0 && n <= 1000).map((n) => Math.round(n)))].sort((a, b) => a - b);
  return out.slice(0, 10);
};

export function cleanAlertSettings(input: Partial<AlertSettings> | null | undefined): AlertSettings {
  const emails = Array.isArray(input?.emails)
    ? [...new Set(input!.emails.map((e) => String(e).trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))].slice(0, 10)
    : [];
  const url = typeof input?.webhookUrl === 'string' ? input.webhookUrl.trim() : '';
  return {
    thresholds: percents(input?.thresholds, DEFAULT_ALERTS.thresholds),
    keyThresholds: percents(input?.keyThresholds, DEFAULT_ALERTS.keyThresholds),
    emails,
    webhookUrl: /^https:\/\/\S+$/.test(url) ? url.slice(0, 500) : null,
    email: input?.email !== false,
  };
}

const money = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);

/** The highest threshold at or under `pct`, if any. */
function crossed(pct: number, thresholds: number[]): number | null {
  const hit = thresholds.filter((t) => pct >= t);
  return hit.length ? hit[hit.length - 1] : null;
}

export class CostAlerts {
  constructor(private readonly store: DocStore, private readonly keys: IssuedKeys, private readonly now: () => number = Date.now) {}

  /** This month's (or another month's) alerts, newest first. */
  async log(month = monthOf(this.now())): Promise<Alert[]> {
    return (await this.store.get<AlertDoc>(`alerts/${month}`))?.value.log ?? [];
  }

  /**
   * After a request was counted: alert on any threshold newly crossed by the monthly total or by this key.
   * Cheap when nothing crossed (no extra reads beyond the spend it already has to look at).
   */
  async check(settings: AlertSettings, budgetUsd: number | null, key: IssuedKey | null, ctx: { to: string[]; publicUrl: string }, channels: AlertChannels): Promise<Alert[]> {
    const month = monthOf(this.now());
    const due: Array<{ id: string; build: () => Alert }> = [];
    if (budgetUsd && settings.thresholds.length) {
      const spend = await this.keys.spend(month);
      const t = crossed((100 * spend.usd) / budgetUsd, settings.thresholds);
      if (t !== null) {
        due.push({
          // The alert id remains stable for API compatibility; claim compares the saved limit so changing it re-arms the threshold.
          id: `budget:${t}`,
          build: () => ({
            id: `budget:${t}`, at: this.now(), kind: 'budget', month, threshold: t, usd: spend.usd, limitUsd: budgetUsd,
            message: t >= 100
              ? `Leyline has reached its ${money(budgetUsd)} monthly limit (${money(spend.usd)} spent in ${month}). Requests are refused until the 1st (UTC) or until you raise the limit.`
              : `Leyline has spent ${money(spend.usd)} of its ${money(budgetUsd)} monthly limit in ${month} (${t}%).`,
          }),
        });
      }
    }
    if (key?.caps.usdPerMonth && settings.keyThresholds.length) {
      const cap = key.caps.usdPerMonth;
      const usage = await this.keys.usage(key.id, month);
      const used = usage.usd ?? 0;
      const t = crossed((100 * used) / cap, settings.keyThresholds);
      if (t !== null) {
        due.push({
          id: `key:${key.id}:${t}`,
          build: () => ({
            id: `key:${key.id}:${t}`, at: this.now(), kind: 'key', month, threshold: t, usd: used, limitUsd: cap, keyId: key.id, keyName: key.name,
            message: t >= 100
              ? `The access key "${key.name}" has used its ${money(cap)} for ${month}; it's refused until the 1st (UTC) or until you raise its cap.`
              : `The access key "${key.name}" has used ${money(used)} of its ${money(cap)} for ${month} (${t}%).`,
          }),
        });
      }
    }
    const fired: Alert[] = [];
    for (const d of due) {
      const alert = await this.claim(month, d.id, d.build);
      if (alert) fired.push(await this.deliver(month, alert, settings, ctx, channels));
    }
    return fired;
  }

  /** A test alert through every channel, now. */
  async test(settings: AlertSettings, ctx: { to: string[]; publicUrl: string }, channels: AlertChannels): Promise<Alert> {
    const month = monthOf(this.now());
    const alert: Alert = { id: `test:${this.now()}`, at: this.now(), kind: 'test', month, threshold: 0, usd: 0, limitUsd: 0, message: 'This is a test alert from Leyline. Cost alerts will arrive here.' };
    await update<AlertDoc>(this.store, `alerts/${month}`, (cur) => ({ sent: cur?.sent ?? {}, log: [alert, ...(cur?.log ?? [])].slice(0, 100) }));
    return this.deliver(month, alert, settings, ctx, channels);
  }

  /** Mark a crossing as alerted; a changed budget limit re-arms the same threshold. */
  private async claim(month: string, id: string, build: () => Alert): Promise<Alert | null> {
    let alert: Alert | null = null;
    await update<AlertDoc>(this.store, `alerts/${month}`, (cur) => {
      const doc = cur ?? { sent: {}, log: [] };
      const candidate = build();
      const previous = doc.log.find((item) => item.id === id);
      if (doc.sent[id] && (!previous || previous.limitUsd === candidate.limitUsd)) {
        alert = null;
        return doc;
      }
      alert = candidate;
      return { sent: { ...doc.sent, [id]: alert.at }, log: [alert, ...doc.log].slice(0, 100) };
    });
    return alert;
  }

  private async deliver(month: string, alert: Alert, settings: AlertSettings, ctx: { to: string[]; publicUrl: string }, channels: AlertChannels): Promise<Alert> {
    const subject = alert.kind === 'test' ? 'Leyline: test alert' : alert.threshold >= 100 ? `Leyline: ${alert.kind === 'key' ? `key "${alert.keyName}" ` : ''}limit reached` : `Leyline: ${alert.threshold}% of ${alert.kind === 'key' ? `key "${alert.keyName}"'s cap` : 'the monthly limit'} spent`;
    const text = `${alert.message}\n\nSpending: ${ctx.publicUrl}/dashboard/#/spending`;
    const delivery: { email?: string; webhook?: string } = {};
    const tasks: Promise<void>[] = [];
    if (!settings.email || !ctx.to.length) delivery.email = 'off';
    else if (!channels.sendEmail) delivery.email = 'not available on this host';
    else tasks.push(channels.sendEmail(ctx.to, subject, text).then(() => { delivery.email = 'sent'; }, (e) => { delivery.email = String(e instanceof Error ? e.message : e).slice(0, 200); }));
    if (!settings.webhookUrl) delivery.webhook = 'off';
    else {
      const f = channels.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
      // `text` for Slack, `content` for Discord; the rest for anything else.
      const body = JSON.stringify({ text: `*${subject}*\n${text}`, content: `**${subject}**\n${text}`, alert });
      tasks.push(f(settings.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
        .then((r) => { delivery.webhook = r.ok ? 'sent' : `HTTP ${r.status}`; }, (e) => { delivery.webhook = String(e instanceof Error ? e.message : e).slice(0, 200); }));
    }
    await Promise.all(tasks);
    const done = { ...alert, delivery };
    await update<AlertDoc>(this.store, `alerts/${month}`, (cur) => ({ sent: cur?.sent ?? {}, log: (cur?.log ?? []).map((a) => (a.id === alert.id && a.at === alert.at ? done : a)) }))
      .catch(() => undefined);
    return done;
  }
}
