import { useState } from 'react';
import { MediaPlayground } from '@/pages/media-playground';
import { PageHeader } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Kind = 'image' | 'video';

/**
 * Images and video without code, for customers (docs "Try it without code"). Requests go to the public API with one
 * of the customer's own keys, so they are charged exactly like API calls, from their credit. The key stays in this
 * page's memory: never stored, gone on reload.
 */
export function CustomerPlaygroundPage() {
  const [key, setKey] = useState('');
  const [kind, setKind] = useState<Kind>('image');
  const ready = key.trim().startsWith('ll_') && key.trim().length > 10;
  return (
    <>
      <PageHeader title="Playground" description="Generate images and videos with the models Valefront sells. Each one is charged at the provider's price, from your credit, like an API call." />
      <Card className="mb-4">
        <CardContent className="grid gap-2 pt-6">
          <Label htmlFor="pg-key">API key</Label>
          <Input id="pg-key" type="password" autoComplete="off" spellCheck={false} placeholder="ll_…" value={key} onChange={(e) => setKey(e.target.value)} />
          <p className="text-xs text-muted-foreground">Paste one of your keys (API keys page). It stays on this page only and is forgotten when you leave or reload.</p>
        </CardContent>
      </Card>
      {ready ? (
        <>
          <div className="mb-4 flex gap-2" role="tablist" aria-label="Playground mode">
            {(['image', 'video'] as const).map((k) => (
              <Button key={k} role="tab" aria-selected={kind === k} variant={kind === k ? 'default' : 'outline'} size="sm" onClick={() => setKind(k)}>{k === 'image' ? 'Image' : 'Video'}</Button>
            ))}
          </div>
          <MediaPlayground key={kind} kind={kind} authHeaders={{ Authorization: `Bearer ${key.trim()}` }} />
        </>
      ) : null}
    </>
  );
}
