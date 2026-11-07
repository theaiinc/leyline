import { useEffect, useState } from 'react';
import { Image as ImageIcon, KeyRound, MessageSquare, Video } from 'lucide-react';
import { MediaPlayground, type MediaModel } from '@/pages/media-playground';
import { PageHeader } from '@/components/common';
import { api, type RoutingStrategy } from '@/api';
import { ChatPlayground, type OwnChatModel } from './customer-chat-playground';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

type Kind = 'chat' | 'image' | 'video';
type KeyOption = { id: string; name: string; prefix: string; revokedAt: number | null; routingStrategy?: RoutingStrategy | null };
const MODES = [['chat', 'Chat', MessageSquare], ['image', 'Image', ImageIcon], ['video', 'Video', Video]] as const;

/**
 * Chat, images and video without code, for customers (docs "Try it without code"). The customer picks one of their own
 * keys; the request runs on the server as that key (its caps, its spend lines) and is charged exactly like the same
 * API call, from the workspace's credit. Only the key's id is sent: its secret never reaches the browser.
 */
export function CustomerPlaygroundPage({ balanceCents, go }: { balanceCents: number | null; go: (page: string) => void }) {
  const [keys, setKeys] = useState<KeyOption[] | null>(null);
  const [error, setError] = useState('');
  const [keyId, setKeyId] = useState('');
  const [kind, setKind] = useState<Kind>('chat');
  // Models of the workspace's own providers (Your providers), billed by that provider: chat, and images and video
  // (WaveSpeed).
  const [ownModels, setOwnModels] = useState<MediaModel[]>([]);
  const [ownChat, setOwnChat] = useState<OwnChatModel[]>([]);
  useEffect(() => {
    api<{ mediaModels?: MediaModel[]; chatModels?: OwnChatModel[] }>('/dashboard/me/providers')
      .then((out) => { setOwnModels(out.mediaModels ?? []); setOwnChat(out.chatModels ?? []); })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    api<{ keys: KeyOption[] }>('/dashboard/me/keys')
      .then((out) => {
        const active = out.keys.filter((k) => !k.revokedAt);
        setKeys(active);
        setKeyId((cur) => (active.some((k) => k.id === cur) ? cur : active[0]?.id ?? ''));
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);
  const balance = balanceCents === null ? null : `$${(balanceCents / 100).toFixed(2)}`;
  return (
    <>
      <PageHeader title="Playground" description="Chat, or generate images and videos, as one of your API keys. Each run is charged exactly like the same API call, from your credit." />
      {error ? <Card className="mb-4"><CardContent className="pt-6 text-sm text-destructive">{error}</CardContent></Card>
        : keys === null ? <Skeleton className="mb-4 h-24" />
          : keys.length === 0 ? (
            <Card className="mb-4">
              <CardContent className="grid justify-items-start gap-3 pt-6">
                <p className="font-medium">Create an API key first</p>
                <p className="text-sm text-muted-foreground">The Playground runs as one of your API keys, so its usage shows under that key on Spending, with the key's limits.</p>
                <Button onClick={() => go('keys')}><KeyRound />Go to API keys</Button>
              </CardContent>
            </Card>
          ) : (
            <>
              <Card className="mb-4">
                <CardContent className="grid gap-2 pt-6">
                  <Label htmlFor="pg-key">API key</Label>
                  <Select value={keyId} onValueChange={setKeyId}>
                    <SelectTrigger id="pg-key" className="w-full sm:w-80"><SelectValue placeholder="Choose a key" /></SelectTrigger>
                    <SelectContent>{keys.map((k) => <SelectItem key={k.id} value={k.id}>{k.name} ({k.prefix}…)</SelectItem>)}</SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Charged from your credit at the provider's price{balance ? ` (balance ${balance})` : ''}, and counted under this key on Spending, with its limits. Free tokens cover chat on free-tier models; images and videos never. Models on Your providers are billed by them.
                  </p>
                </CardContent>
              </Card>
              {keyId ? (
                <>
                  <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Playground mode">
                    {MODES.map(([k, label, Icon]) => (
                      <Button key={k} role="tab" aria-selected={kind === k} variant={kind === k ? 'default' : 'outline'} size="sm" onClick={() => setKind(k)}><Icon />{label}</Button>
                    ))}
                  </div>
                  {kind === 'chat'
                    ? <ChatPlayground key={keyId} keyId={keyId} keyStrategy={keys.find((k) => k.id === keyId)?.routingStrategy ?? null} ownModels={ownChat} onAddCredit={() => go('billing')} />
                    : <MediaPlayground key={`${kind}:${keyId}`} kind={kind} keyId={keyId} extraModels={ownModels} onAddCredit={() => go('billing')} />}
                </>
              ) : null}
            </>
          )}
    </>
  );
}
