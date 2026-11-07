import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { MediaPlayground, type MediaModel } from '@/pages/media-playground';
import { PageHeader } from '@/components/common';
import { api } from '@/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

type Kind = 'image' | 'video';
type KeyOption = { id: string; name: string; prefix: string; revokedAt: number | null };

/**
 * Images and video without code, for customers (docs "Try it without code"). The customer picks one of their own
 * keys; the request runs on the server as that key (its caps, its spend lines) and is charged exactly like the same
 * API call, from the workspace's credit. Only the key's id is sent: its secret never reaches the browser.
 */
export function CustomerPlaygroundPage({ balanceCents, go }: { balanceCents: number | null; go: (page: string) => void }) {
  const [keys, setKeys] = useState<KeyOption[] | null>(null);
  const [error, setError] = useState('');
  const [keyId, setKeyId] = useState('');
  const [kind, setKind] = useState<Kind>('image');
  // Image and video models of the workspace's own providers (WaveSpeed), billed by that provider.
  const [ownModels, setOwnModels] = useState<MediaModel[]>([]);
  useEffect(() => {
    api<{ mediaModels?: MediaModel[] }>('/dashboard/me/providers').then((out) => setOwnModels(out.mediaModels ?? [])).catch(() => undefined);
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
      <PageHeader title="Playground" description="Generate images and videos with the models Valefront sells. Each one is charged at the provider's price, from your credit, like an API call." />
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
                    Charged from your credit at the provider's price{balance ? ` (balance ${balance})` : ''}, and counted under this key on Spending. Images and videos are never covered by free tokens.
                  </p>
                </CardContent>
              </Card>
              {keyId ? (
                <>
                  <div className="mb-4 flex gap-2" role="tablist" aria-label="Playground mode">
                    {(['image', 'video'] as const).map((k) => (
                      <Button key={k} role="tab" aria-selected={kind === k} variant={kind === k ? 'default' : 'outline'} size="sm" onClick={() => setKind(k)}>{k === 'image' ? 'Image' : 'Video'}</Button>
                    ))}
                  </div>
                  <MediaPlayground key={`${kind}:${keyId}`} kind={kind} keyId={keyId} extraModels={ownModels} onAddCredit={() => go('billing')} />
                </>
              ) : null}
            </>
          )}
    </>
  );
}
