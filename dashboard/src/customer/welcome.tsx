import { useId, type ReactNode } from 'react';
import { ArrowRight, Check, Coins, KeyRound, Plug, ShieldCheck, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The sign-up screens' look (Steve, 2026-11-05: "new user sign up looks not intuitive at all. Do art works and make
 * it more attractive"): Valefront's mint/blue routing art, what you get, and a three-step card that shows what is
 * left to do. The behaviour (terms, Turnstile, POST /dashboard/me/workspace) stays in customer-app.tsx.
 */

const MINT = '#a9f5cf';
const BLUE = '#7aa6ff';

/** "deepseek-v4-1-flash-261017" → "DeepSeek V4.1 Flash": names people know, the exact id in the tooltip. */
export function friendlyModel(id: string): string {
  const brands: Record<string, string> = { deepseek: 'DeepSeek', seed: 'Seed', glm: 'GLM', gpt: 'GPT', gemini: 'Gemini', claude: 'Claude', doubao: 'Doubao', kimi: 'Kimi', qwen: 'Qwen', dola: 'Dola' };
  const parts = id.replace(/-(\d{6}|ga-\d{6})$/, '').replace(/-ga$/, '').split('-');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    // Version digits split by dashes: "v4-1" → "V4.1", "2-0" → "2.0".
    if (/^v?\d+$/.test(p) && /^\d+$/.test(parts[i + 1] ?? '') && (parts[i + 1] ?? '').length <= 2) {
      out.push(`${p.toUpperCase()}.${parts[i + 1]}`);
      i++;
    } else if (brands[p]) out.push(brands[p]!);
    else if (/^v\d/.test(p)) out.push(p.toUpperCase());
    else out.push(p.charAt(0).toUpperCase() + p.slice(1));
  }
  return out.join(' ');
}

/** The routing picture: your app → Valefront → providers, with light travelling along the lines. */
export function RoutingArt({ className }: { className?: string }) {
  const id = useId().replace(/:/g, '');
  const providers = [
    { y: 46, label: 'BytePlus' },
    { y: 110, label: 'Azure OpenAI' },
    { y: 174, label: 'DeepSeek' },
    { y: 238, label: '+ more' },
  ];
  return (
    <svg viewBox="0 0 520 284" className={className} role="img" aria-label="Your app sends one request to Valefront, which routes it to the right provider.">
      <defs>
        <radialGradient id={`glow${id}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={MINT} stopOpacity="0.35" />
          <stop offset="100%" stopColor={MINT} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`line${id}`} x1="0" x2="1">
          <stop offset="0%" stopColor={MINT} stopOpacity="0.15" />
          <stop offset="100%" stopColor={BLUE} stopOpacity="0.55" />
        </linearGradient>
        <linearGradient id={`node${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={MINT} />
          <stop offset="100%" stopColor={BLUE} />
        </linearGradient>
      </defs>
      <circle cx="250" cy="142" r="120" fill={`url(#glow${id})`} />
      {/* your app */}
      <g>
        <rect x="8" y="112" width="118" height="60" rx="14" className="fill-card stroke-border" strokeWidth="1.5" />
        <text x="67" y="137" textAnchor="middle" className="fill-muted-foreground" fontSize="11" fontFamily="ui-monospace, monospace">your app</text>
        <text x="67" y="156" textAnchor="middle" className="fill-foreground" fontSize="12" fontWeight="600">model: "auto"</text>
      </g>
      <path id={`in${id}`} d="M126 142 H206" stroke={`url(#line${id})`} strokeWidth="2" fill="none" />
      <circle r="3.5" fill={MINT}><animateMotion dur="1.8s" repeatCount="indefinite"><mpath href={`#in${id}`} /></animateMotion></circle>
      {/* Valefront */}
      <circle cx="250" cy="142" r="44" className="fill-card" stroke={`url(#node${id})`} strokeWidth="2" />
      <circle cx="250" cy="142" r="52" fill="none" stroke={MINT} strokeOpacity="0.25" strokeWidth="1">
        <animate attributeName="r" values="46;60;46" dur="3.2s" repeatCount="indefinite" />
        <animate attributeName="stroke-opacity" values="0.35;0;0.35" dur="3.2s" repeatCount="indefinite" />
      </circle>
      <g transform="translate(232 124)" stroke={`url(#node${id})`} strokeWidth="2.4" fill="none" strokeLinecap="round">
        <rect x="2" y="2" width="32" height="32" rx="9" />
        <path d="M18 8 V28 M8 18 H28" />
      </g>
      {providers.map((p, i) => {
        const d = `M294 142 C 340 142, 350 ${p.y}, 396 ${p.y}`;
        return (
          <g key={p.label}>
            <path id={`out${id}${i}`} d={d} stroke={`url(#line${id})`} strokeWidth="1.6" fill="none" />
            <circle r="3" fill={i === 0 ? MINT : BLUE} opacity={i === 0 ? 1 : 0.7}>
              <animateMotion dur={`${2.2 + i * 0.35}s`} begin={`${0.4 * i}s`} repeatCount="indefinite"><mpath href={`#out${id}${i}`} /></animateMotion>
            </circle>
            <rect x="396" y={p.y - 17} width="116" height="34" rx="10" className="fill-card stroke-border" strokeWidth="1.5" />
            <circle cx="412" cy={p.y} r="4" fill={i === 0 ? MINT : BLUE} opacity={i === 3 ? 0.4 : 0.9} />
            <text x="424" y={p.y + 4} className={i === 3 ? 'fill-muted-foreground' : 'fill-foreground'} fontSize="12" fontWeight="500">{p.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

function Benefit({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border bg-card/60 p-4 backdrop-blur">
      <div className="mb-2 flex size-8 items-center justify-center rounded-lg bg-[#a9f5cf]/15 text-[#2f9e6c] dark:text-[#a9f5cf]">{icon}</div>
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{children}</div>
    </div>
  );
}

/** The welcome screen's left side: who it's for, the art, what you get, the free models. */
export function WelcomeHero({ name, freeTokens, freeDays, perDay, models }: { name: string | null; freeTokens: string; freeDays: number; perDay: string; models: string[] }) {
  return (
    <div className="relative">
      <div className="inline-flex items-center gap-2 rounded-full border border-[#a9f5cf]/40 bg-[#a9f5cf]/10 px-3 py-1 text-xs font-medium text-[#2f9e6c] dark:text-[#a9f5cf]">
        <Sparkles className="size-3.5" />{name ? `Welcome, ${name.split(' ')[0]}` : 'Welcome to Valefront'}
      </div>
      <h1 className="mt-4 text-3xl leading-tight font-semibold tracking-tight md:text-4xl">
        Every model you need,{' '}
        <span className="bg-gradient-to-r from-[#2f9e6c] to-[#3b6fd8] bg-clip-text text-transparent dark:from-[#a9f5cf] dark:to-[#7aa6ff]">one API key away.</span>
      </h1>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
        Valefront routes each request to the right model across providers, with automatic fallback. Point the OpenAI or Anthropic SDK you already use at it.
      </p>
      <RoutingArt className="mt-6 w-full max-w-xl" />
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <Benefit icon={<Sparkles className="size-4" />} title={`${freeTokens} free tokens`}>For {freeDays} days, up to {perDay} a day. No card needed.</Benefit>
        <Benefit icon={<Plug className="size-4" />} title="Works with your SDK">OpenAI- and Anthropic-compatible: change the base URL and key.</Benefit>
        <Benefit icon={<Coins className="size-4" />} title="No markup">Pay each provider&apos;s official price from prepaid credit.</Benefit>
      </div>
      {models.length ? (
        <div className="mt-5">
          <div className="mb-2 text-xs font-medium text-muted-foreground">Free to try</div>
          <div className="flex flex-wrap gap-2">
            {models.map((m) => (
              <span key={m} title={m} className="rounded-full border bg-card px-3 py-1 text-xs font-medium">{friendlyModel(m)}</span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** One step of the sign-up card: number (or a check when done), title, and what to do. */
export function Step({ n, done, active, title, children }: { n: number; done: boolean; active: boolean; title: string; children?: ReactNode }) {
  return (
    <div className={cn('relative flex gap-3 rounded-xl border p-4 transition-colors', active ? 'border-[#a9f5cf]/60 bg-[#a9f5cf]/5' : 'bg-card/40', done && 'border-transparent bg-muted/40')}>
      <div className={cn('flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
        done ? 'bg-[#a9f5cf] text-[#0b3b26]' : active ? 'bg-gradient-to-br from-[#a9f5cf] to-[#7aa6ff] text-[#0b1a2e]' : 'bg-muted text-muted-foreground')}>
        {done ? <Check className="size-4" /> : n}
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn('text-sm font-semibold', !active && !done && 'text-muted-foreground')}>{title}</div>
        {children ? <div className="mt-2">{children}</div> : null}
      </div>
    </div>
  );
}

/** The big mint call to action. */
export function MintButton({ disabled, onClick, children }: { disabled?: boolean; onClick?: () => void; children: ReactNode }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick}
      className="group inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#a9f5cf] px-5 text-sm font-semibold text-[#0b2a1d] shadow-[0_8px_30px_-8px_rgba(169,245,207,0.7)] transition hover:brightness-105 focus-visible:ring-2 focus-visible:ring-[#7aa6ff] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none">
      {children}<ArrowRight className="size-4 transition-transform group-enabled:group-hover:translate-x-0.5" />
    </button>
  );
}

/** The key-ready screen's header art: the key, glowing. */
export function KeyBadge() {
  return (
    <div className="relative flex size-14 items-center justify-center">
      <div className="absolute inset-0 animate-pulse rounded-2xl bg-[#a9f5cf]/30 blur-md" />
      <div className="relative flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[#a9f5cf] to-[#7aa6ff] text-[#0b1a2e] shadow-lg"><KeyRound className="size-6" /></div>
    </div>
  );
}

export { ShieldCheck };
