import { useState, type ReactNode } from 'react';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { BadgeTone } from '@/normalization';

const TONES: Record<BadgeTone, string> = {
  neutral: 'border-border bg-muted text-muted-foreground',
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  danger: 'border-destructive/30 bg-destructive/10 text-destructive',
};

export function ToneBadge({ tone = 'neutral', className, children }: { tone?: BadgeTone; className?: string; children: ReactNode }) {
  return <Badge variant="outline" className={cn(TONES[tone], className)}>{children}</Badge>;
}

const PROVIDER_COLORS: Record<string, string> = {
  gemini: 'bg-sky-500',
  huggingface: 'bg-amber-400',
  openai: 'bg-emerald-500',
  openrouter: 'bg-violet-500',
  azureopenai: 'bg-blue-600',
  ollama: 'bg-zinc-500',
  llmapi: 'bg-rose-500',
  default: 'bg-zinc-400',
};

export function ProviderDot({ tone, className }: { tone: string; className?: string }) {
  return <span className={cn('inline-block size-2.5 shrink-0 rounded-full', PROVIDER_COLORS[tone] ?? PROVIDER_COLORS.default, className)} />;
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CopyButton({ value, label = 'Copy', size = 'sm' }: { value?: string; label?: string; size?: 'sm' | 'icon' }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }
  return (
    <Button type="button" variant="outline" size={size === 'icon' ? 'icon' : 'sm'} onClick={copy} disabled={!value} aria-label={label}>
      {copied ? <Check /> : <Copy />}
      {size === 'icon' ? null : copied ? 'Copied' : label}
    </Button>
  );
}

function mask(value: string, visible = 8): string {
  if (value.length <= visible) return '•'.repeat(Math.max(value.length, 8));
  return `${value.slice(0, visible)}${'•'.repeat(14)}${value.slice(-4)}`;
}

export function SecretValue({ label, value, secret = false }: { label: string; value?: string; secret?: boolean }) {
  const [visible, setVisible] = useState(false);
  const shown = value ? (secret && !visible ? mask(value) : value) : 'Not available';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-32 shrink-0 text-sm text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 font-mono text-xs">{shown}</code>
      {secret && value ? (
        <Button type="button" variant="ghost" size="icon" onClick={() => setVisible(v => !v)} aria-label={visible ? 'Hide' : 'Show'}>
          {visible ? <EyeOff /> : <Eye />}
        </Button>
      ) : null}
      <CopyButton value={value} size="icon" />
    </div>
  );
}

export function CodeBlock({ children }: { children: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border bg-muted/50 p-3 pr-12 font-mono text-xs leading-relaxed">{children}</pre>
      <div className="absolute top-2 right-2"><CopyButton value={children} size="icon" /></div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center">
      <p className="font-medium">{title}</p>
      {children ? <div className="text-sm text-muted-foreground">{children}</div> : null}
    </div>
  );
}

export const fmt = (n?: number | null) => (n == null ? '—' : Number(n).toLocaleString());
export const when = (t?: number | null) => (t ? new Date(t).toLocaleString() : 'never');
