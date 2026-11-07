import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Eraser, Loader2, Send } from 'lucide-react';
import { apiUrl, ROUTING_STRATEGY_OPTIONS, type RoutingStrategy } from '@/api';
import { formatUsd } from '@/lib/cost';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/** A chat model of the workspace's own providers (Your providers), billed by that provider. */
export type OwnChatModel = { id: string; provider: string; byok: true };
type SoldModel = { id: string; name?: string; input: number; output: number; free_tier?: boolean };
type Turn = { role: 'user' | 'assistant'; content: string };
type Reply = { model: string; route?: string; ms: number; input: number; output: number; cost?: number; byok: boolean };

const STRATEGIES = ROUTING_STRATEGY_OPTIONS.map((s) => s.value);
const strategyLabel = (s: RoutingStrategy) => ROUTING_STRATEGY_OPTIONS.find((o) => o.value === s)?.label ?? s;

/**
 * Chat as one of the customer's keys (POST /dashboard/me/playground/chat): the same request, admission, price and
 * spend lines as that key calling /v1/chat/completions; only the key's id leaves the browser. The models: `auto` and
 * the routing strategies, the chat models Valefront sells (/v1/pricing), and the workspace's own (Your providers).
 * The answer carries what the run was charged (`cost`); a model of the customer's own provider is $0 here.
 */
export function ChatPlayground({ keyId, keyStrategy, ownModels, onAddCredit }: {
  keyId: string; keyStrategy: RoutingStrategy | null; ownModels: OwnChatModel[]; onAddCredit: () => void;
}) {
  const [sold, setSold] = useState<SoldModel[]>([]);
  const [model, setModel] = useState('auto');
  const [maxTokens, setMaxTokens] = useState('');
  const [prompt, setPrompt] = useState('');
  const [thread, setThread] = useState<Array<Turn & { reply?: Reply }>>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [total, setTotal] = useState(0);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(apiUrl('/v1/pricing?format=json'), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then((r) => r.json())
      .then((d: { models?: SoldModel[] }) => setSold((d.models ?? []).filter((m) => typeof m.id === 'string' && typeof m.input === 'number' && typeof m.output === 'number')))
      .catch(() => undefined);
  }, []);
  useEffect(() => { if (thread.length || sending) end.current?.scrollIntoView({ block: 'nearest' }); }, [thread.length, sending]);

  const ownIds = new Set(ownModels.map((m) => m.id));
  const soldModel = sold.find((m) => m.id === model);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = prompt.trim();
    if (!text || sending) return;
    const history: Turn[] = [...thread.map(({ role, content }) => ({ role, content })), { role: 'user', content: text }];
    setThread((t) => [...t, { role: 'user', content: text }]);
    setPrompt('');
    setError(null);
    setSending(true);
    const started = performance.now();
    try {
      const limit = Number(maxTokens);
      const res = await fetch(apiUrl('/dashboard/me/playground/chat'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyId, model, messages: history, ...(Number.isInteger(limit) && limit > 0 ? { max_tokens: limit } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      const ms = Math.round(performance.now() - started);
      if (!res.ok) {
        const e = data?.error;
        setError({ message: (typeof e === 'string' ? e : e?.message) || `Request failed (${res.status})`, code: e?.code });
        // The question stays in the box to try again; it isn't part of the thread.
        setThread((t) => t.slice(0, -1));
        setPrompt(text);
        return;
      }
      const served = typeof data.model === 'string' && data.model ? data.model : model;
      const byok = ownIds.has(served) || ownIds.has(model);
      const cost = typeof data.cost === 'number' ? data.cost : byok ? 0 : undefined;
      const reply: Reply = {
        model: served, ms, byok, cost,
        route: res.headers.get('X-Valefront-Route') ?? undefined,
        input: Number(data.usage?.prompt_tokens ?? 0), output: Number(data.usage?.completion_tokens ?? 0),
      };
      setThread((t) => [...t, { role: 'assistant', content: data.choices?.[0]?.message?.content || '(empty response)', reply }]);
      if (cost !== undefined) setTotal((n) => n + cost);
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err) });
      setThread((t) => t.slice(0, -1));
      setPrompt(text);
    } finally {
      setSending(false);
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
  };

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4">
      <Card className="gap-4">
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <div className="grid min-w-0 gap-1.5">
            <Label htmlFor="pg-chat-model">Model</Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger id="pg-chat-model" className="w-full min-w-0"><SelectValue placeholder="Model" /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Let Valefront pick</SelectLabel>
                  <SelectItem value="auto">Auto ({strategyLabel(keyStrategy ?? 'balanced')}{keyStrategy ? ', this key’s default' : ''})</SelectItem>
                  {STRATEGIES.map((s) => <SelectItem key={s} value={`auto:${s}`}>Auto: {strategyLabel(s)}</SelectItem>)}
                </SelectGroup>
                {sold.length ? (
                  <SelectGroup>
                    <SelectLabel>Sold by Valefront (per 1M tokens in / out)</SelectLabel>
                    {sold.map((m) => <SelectItem key={m.id} value={m.id}>{m.name || m.id} · {formatUsd(m.input)} / {formatUsd(m.output)}</SelectItem>)}
                  </SelectGroup>
                ) : null}
                {ownModels.length ? (
                  <SelectGroup>
                    <SelectLabel>Your providers (billed by them)</SelectLabel>
                    {ownModels.map((m) => <SelectItem key={m.id} value={m.id}>{m.id} · {m.provider.replace(/^BYOK:/, '')}</SelectItem>)}
                  </SelectGroup>
                ) : null}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="pg-chat-max">Max output tokens</Label>
            <Input id="pg-chat-max" type="number" min={1} inputMode="numeric" placeholder="Model default" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            {ownIds.has(model) ? 'Runs on your own provider: no Valefront charge, billed by your provider.'
              : soldModel ? `Charged at ${formatUsd(soldModel.input)} per 1M input and ${formatUsd(soldModel.output)} per 1M output tokens, from your credit (or free tokens).`
                : 'Valefront picks a model for each message; you pay that model’s price.'}
          </p>
        </CardContent>
      </Card>

      <Card className="gap-3">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>Conversation</CardTitle>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>Session total {formatUsd(total)}</span>
            <Button variant="outline" size="sm" disabled={sending || thread.length === 0} onClick={() => { setThread([]); setError(null); setTotal(0); }}><Eraser />New chat</Button>
          </div>
        </CardHeader>
        <CardContent className="grid min-w-0 grid-cols-1 gap-3">
          {thread.length === 0 ? <p className="text-sm text-muted-foreground">Ask anything. Each message sends the whole conversation, so longer chats use more input tokens.</p> : null}
          {thread.map((turn, i) => (
            <div key={i} className={cn('grid min-w-0 grid-cols-1 gap-1', turn.role === 'user' ? 'justify-items-end' : 'justify-items-start')}>
              <div className={cn('max-w-[min(100%,42rem)] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]', turn.role === 'user' ? 'bg-primary text-primary-foreground' : 'border bg-muted/50')}>{turn.content}</div>
              {turn.reply ? (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <Badge variant="outline" className="max-w-full truncate">{turn.reply.model}</Badge>
                  {turn.reply.byok ? <Badge variant="secondary">Your provider</Badge> : null}
                  <span className="tabular-nums">{(turn.reply.ms / 1000).toFixed(1)}s</span>
                  <span className="tabular-nums">{turn.reply.input.toLocaleString()} in · {turn.reply.output.toLocaleString()} out</span>
                  <span className="tabular-nums">{turn.reply.cost === undefined ? 'cost not reported' : `charged ${formatUsd(turn.reply.cost)}`}</span>
                </div>
              ) : null}
            </div>
          ))}
          {sending ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Thinking…</div> : null}
          {error ? (
            <div className="grid gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive break-words">
              <p>{error.message}</p>
              {error.code === 'insufficient_credit' ? <div><Button size="sm" onClick={onAddCredit}>Add credit</Button></div> : null}
            </div>
          ) : null}
          <div ref={end} />
          <form onSubmit={send} className="grid gap-2">
            <Label htmlFor="pg-chat-prompt" className="sr-only">Message</Label>
            <Textarea id="pg-chat-prompt" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={onKey} placeholder="Type a message (Ctrl/⌘ + Enter to send)" />
            <div className="flex justify-end">
              <Button type="submit" disabled={sending || !prompt.trim()} className="w-full sm:w-auto">{sending ? <Loader2 className="animate-spin" /> : <Send />}{sending ? 'Sending…' : 'Send'}</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
