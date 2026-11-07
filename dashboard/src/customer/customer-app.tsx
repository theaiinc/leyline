import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BookOpen, Calculator, FlaskConical, ChevronDown, CreditCard, Gift, Database, KeyRound, Landmark, LogOut, Moon, Plug, QrCode, ShieldCheck, Sun, Wallet } from 'lucide-react';
import { SideNav, navIds, type NavEntry } from '@/components/side-nav';
import { CalculatorPage } from '@/pages/calculator';
import { YourProvidersPage } from '@/pages/your-providers';
import { CustomerPlaygroundPage } from './customer-playground';
import { toast } from 'sonner';
import { api, apiUrl, ROUTING_STRATEGY_OPTIONS, type RoutingStrategy } from '@/api';
import { CopyButton, PageHeader } from '@/components/common';
import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { usePathRoute } from '@/hooks/use-path-route';
import { cn } from '@/lib/utils';
import { Turnstile } from './turnstile';
import { KeyBadge, MintButton, Step, WelcomeHero, friendlyModel } from './welcome';

/** The customer's dashboard: sign-up, their own keys, usage, billing and data. Admins get the owner dashboard. */

type Me = {
  email: string;
  name: string | null;
  emailVerified: boolean;
  onboarding: 'email_verification' | 'terms' | 'key' | 'complete';
  termsVersion: string;
  termsUrl: string;
  privacyUrl: string;
  privacyContact: string;
  turnstileSiteKey: string | null;
  apiBaseUrl: string;
  workspace: { id: string; createdAt: number; suspended: boolean } | null;
  balanceCents: number | null;
  freeTier: { tokens: number; bonusTokens?: number; expiresAfterDays: number; models: string[]; tokensPerDay: number; granted: { tokens: number; usedTokens: number; expiresAt: number; bonusUnlocked?: boolean } | null };
};

type PiiMode = 'off' | 'regex' | 'presidio';
type KeyView = {
  id: string; name: string; prefix: string; createdAt: number; revokedAt: number | null; lastUsedAt: number | null; piiProtection?: PiiMode; routingStrategy?: RoutingStrategy | null;
  usage: { month: string; requests: number; promptTokens: number; completionTokens: number; byModel: Record<string, { requests: number; tokens: number }>; addons?: Record<string, { requests: number; tokens: number; usd: number }>; promotions?: Record<string, PromotionLine> };
};
/** The PII protection add-on as the server offers it (GET /dashboard/me/keys). */
type PiiOffer = { id: string; name: string; unit: string; price: number; currency: string; modes: Array<'regex' | 'presidio'> };
const PII_ID = 'pii-protection';
const PII_EXPLAINER = 'Emails, phone numbers, card numbers and API keys in your prompts are masked before the prompt leaves Valefront and restored in the reply.';
const piiPrice = (offer: PiiOffer | null) => (offer ? `$${offer.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${offer.unit}` : '');

type VatInvoice = { companyName: string; taxCode: string; address: string; email: string };
type Profile = { name: string; email: string; company?: string; taxId?: string; address?: string; country: string; vatInvoice?: VatInvoice };
type Order = {
  id: string; method: 'worldfirst' | 'paypal' | 'sepay'; status: 'pending' | 'paid' | 'cancelled'; amountCents: number; vatRateBp: number; vatCents: number; totalCents: number;
  reference: string; createdAt: number; paidAt: number | null; approveUrl?: string; vatInvoice?: boolean;
  /** Paid, buyer in Vietnam, within the window, and no VAT invoice yet (or a rejected one): "Request VAT invoice". */
  vatInvoiceRequestable?: boolean;
  bankTransfer?: { account: Record<string, string>; amount: number; reference: string; instructions: string[] };
  /** SePay (Vietnamese bank QR): the exact VND to transfer, with the order reference as the content. */
  sepay?: SepayInfo;
};
type SepayInfo = {
  qrUrl: string; bankName: string; bankId: string; accountNumber: string; accountName: string; amountVnd: number; receivedVnd: number; leftVnd: number;
  transferContent: string; vndPerUsd: number; rateDate: string; expiresAt: number; expired: boolean;
};
type EInvoiceView = {
  id: string; orderId: string; status: string; invoiceNo: string | null; codeOfTax: string | null; reservationCode: string | null; issuedAt: number | null; totalCents: number; email: string;
  manual?: boolean; rejectReason?: string | null; lookupUrl?: string | null; file?: boolean;
};
type SepayMethod = { enabled: boolean; vndPerUsd: number | null; rateDate: string | null; bankName: string | null; quoteMinutes: number };
type PayMethod = 'paypal' | 'worldfirst' | 'sepay';
type Billing = {
  balanceCents: number; availableCents: number; pendingUsageCents: number; minimumCents: number; email: string;
  ledger: Array<{ id: string; amountCents: number; kind: string; description: string; createdAt: number }>;
  orders: Order[];
  receipts: Array<{ id: string; orderId: string; number: string; issuedAt: number; amountCents: number; totalCents: number; emailStatus: string | null }>;
  einvoices: EInvoiceView[];
  /** automatic: issued through S-Invoice right after payment; otherwise on request, by hand. */
  vatInvoices?: { automatic: boolean; requestWindowDays: number };
  profile: Profile | null;
  free: { tokens: number; usedTokens: number; expiresAt: number; models: string[]; bonusTokens?: number; bonusUnlocked?: boolean } | null;
  methods: { worldfirst: boolean; paypal: { enabled: boolean; env: string | null }; sepay?: SepayMethod };
  vat: { defaultBp: number; byCountry: Record<string, number> };
  promotions?: Promotions;
};
/** Promotions this workspace has (BillingService.promotions): live or upcoming automatic ones, and codes it redeemed. */
type Promotion = { id: string; name: string; type: 'automatic' | 'code'; code?: string; starts_at: string; ends_at: string; models: string[]; discount: { kind: 'percent'; percent: number } | { kind: 'price' }; live: boolean };
type Promotions = { available: boolean; campaigns: Promotion[] };
type PromotionLine = { name: string; requests: number; tokens: number; officialUsd: number; discountUsd: number };

const usd = (cents: number) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (t: number) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const tokens = (n: number) => n.toLocaleString('en-US');
const vnd = (n: number) => `${n.toLocaleString('vi-VN')} ₫`;
/** What a USD total comes to in VND at the rate SePay orders are quoted with (the order shows the exact amount). */
const vndOf = (cents: number, rate: number) => Math.ceil((cents * rate) / 100);
const METHOD_NAMES: Record<PayMethod, string> = { worldfirst: 'Bank transfer', paypal: 'PayPal', sepay: 'Bank QR (VND)' };
const newKey = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');

const NAV: NavEntry[] = [
  { id: 'get-started', label: 'Get started', icon: BookOpen },
  { id: 'keys', label: 'API keys', icon: KeyRound },
  { id: 'providers', label: 'Your providers', icon: Plug },
  { id: 'playground', label: 'Playground', icon: FlaskConical },
  // Money in one place: balance, credit, receipts and VAT invoices; what was spent; what it would cost.
  { group: 'Billing', icon: Wallet, items: [
    { id: 'billing', label: 'Billing', icon: CreditCard },
    { id: 'spending', label: 'Spending', icon: Wallet },
    { id: 'calculator', label: 'Cost calculator', icon: Calculator },
  ] },
  { id: 'data', label: 'Your data', icon: Database },
];
/** Old links keep working. */
const ALIASES: Record<string, string> = { usage: 'spending' };

export function CustomerApp({ dark, toggleTheme }: { dark: boolean; toggleTheme: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, go] = usePathRoute('get-started');
  const load = useCallback(async () => {
    try {
      setMe(await api<Me>('/dashboard/me'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const ready = me?.workspace && me.onboarding !== 'email_verification' && me.onboarding !== 'terms';
  const wanted = ALIASES[page] ?? page;
  useEffect(() => { if (ALIASES[page]) go(ALIASES[page]!); }, [page, go]);
  const current = ready && navIds(NAV).includes(wanted) ? wanted : 'get-started';

  async function signOut() {
    const res = await fetch(apiUrl('/auth/logout'), { method: 'POST', credentials: 'same-origin' });
    // Aegis's sign-out page ends the Aegis session too; without it the next sign-in skipped the login.
    const next = res.ok ? ((await res.json().catch(() => null)) as { next?: string } | null)?.next : undefined;
    window.location.href = next || '/auth/login?next=/';
  }

  if (me && !ready && !error) {
    // Sign-up gets the whole screen: there is nothing to navigate to yet.
    return (
      <div className="min-h-svh bg-[radial-gradient(60rem_30rem_at_20%_-10%,rgba(169,245,207,0.14),transparent),radial-gradient(50rem_30rem_at_100%_0%,rgba(122,166,255,0.12),transparent)]">
        <header className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-4 md:px-8">
          <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" className="size-8" />
          <span className="font-semibold">Valefront</span>
          <span className="ml-auto hidden max-w-[16rem] truncate text-xs text-muted-foreground sm:inline">{me.email}</span>
          <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="Toggle theme">{dark ? <Sun /> : <Moon />}</Button>
          <Button variant="ghost" size="sm" onClick={signOut}><LogOut />Sign out</Button>
        </header>
        <main className="mx-auto max-w-6xl px-4 pt-4 pb-16 md:px-8 md:pt-8"><GetStarted me={me} reload={load} go={go} /></main>
      </div>
    );
  }

  return (
    <AppShell area="Dashboard" email={me?.email ?? ''} nav={ready ? NAV : null} current={current} go={go} dark={dark} toggleTheme={toggleTheme}
      onSignOut={signOut} wide={current === 'billing'}>
          {error ? <Card><CardContent className="text-sm text-destructive">{error}</CardContent></Card>
            : !me ? <div className="grid gap-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-40" /></div>
              : current === 'keys' ? <KeysPage me={me} />
                : current === 'providers' ? <YourProvidersPage />
                : current === 'playground' ? <CustomerPlaygroundPage balanceCents={me.balanceCents} go={go} />
                : current === 'spending' ? <UsagePage me={me} />
                : current === 'calculator' ? <CalculatorPage />
                  : current === 'billing' ? <BillingPage me={me} reload={load} />
                    : current === 'data' ? <DataPage me={me} />
                      : <GetStarted me={me} reload={load} go={go} />}
    </AppShell>
  );
}

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return <Card className="mb-4 min-w-0 gap-4"><CardHeader><CardTitle>{title}</CardTitle>{description ? <CardDescription>{description}</CardDescription> : null}</CardHeader><CardContent className="min-w-0">{children}</CardContent></Card>;
}

function failToast(err: unknown) {
  toast.error(err instanceof Error ? err.message : String(err));
}

function Code({ children }: { children: string }) {
  // min-w-0 + max-w-full: a long line scrolls inside the box instead of widening the card (it spilled out, 2026-11-05).
  // Phones: the Copy button sits above the box, so it never covers the code (2026-11-06).
  return <div className="relative min-w-0 max-w-full"><div className="mb-1 flex justify-end sm:hidden"><CopyButton value={children} /></div><pre className="max-w-full overflow-x-auto rounded-md bg-muted p-3 text-xs leading-relaxed sm:pr-20">{children}</pre><div className="absolute top-2 right-2 hidden sm:block"><CopyButton value={children} /></div></div>;
}

function Quickstart({ me, apiKey }: { me: Me; apiKey?: string | null }) {
  const key = apiKey || '$VALEFRONT_API_KEY';
  const model = me.freeTier.models[0] ?? 'auto';
  return (
    <Section title="Make your first request" description={<>Base URL <code>{me.apiBaseUrl}/v1</code>. OpenAI- and Anthropic-compatible.</>}>
      <div className="grid min-w-0 gap-3 [&>*]:min-w-0">
        <div className="text-sm font-medium">OpenAI format</div>
        <Code>{`curl ${me.apiBaseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${model}", "messages": [{"role": "user", "content": "Say hello from Valefront."}]}'`}</Code>
        <div className="text-sm font-medium">Anthropic format</div>
        <Code>{`curl ${me.apiBaseUrl}/v1/messages \\
  -H "x-api-key: ${key}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${model}", "max_tokens": 128, "messages": [{"role": "user", "content": "Say hello from Valefront."}]}'`}</Code>
      </div>
    </Section>
  );
}

/** The rest of the launch offer: shown until the first top-up unlocks it (Steve, 2026-11-05). */
function BonusBanner({ bonus, onAddCredit }: { bonus: number; onAddCredit?: () => void }) {
  if (!bonus) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-[#a9f5cf]/50 bg-gradient-to-r from-[#a9f5cf]/15 to-[#7aa6ff]/10 p-4">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#a9f5cf] to-[#7aa6ff] text-[#0b1a2e]"><Gift className="size-5" /></div>
      <div className="min-w-0 flex-1 text-sm"><div className="font-semibold">{tokens(bonus)} more free tokens are waiting for you</div><div className="text-muted-foreground">They unlock with your first top-up, of any amount.</div></div>
      {onAddCredit ? <Button onClick={onAddCredit}>Add credit</Button> : null}
    </div>
  );
}

function FreeTierFacts({ me }: { me: Me }) {
  const f = me.freeTier;
  return <p className="text-sm text-muted-foreground">New accounts get <strong>{tokens(f.tokens)} free tokens</strong>{f.bonusTokens ? <>, and <strong>{tokens(f.bonusTokens)} more</strong> after their first top-up,</> : null} for {f.expiresAfterDays} days on {f.models.join(', ')} (up to {tokens(f.tokensPerDay)} a day). Other models, and use after that, are pay as you go from prepaid credit at each provider&apos;s official price.</p>;
}

function GetStarted({ me, reload, go }: { me: Me; reload: () => Promise<void>; go: (p: string) => void }) {
  const [accept, setAccept] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [reset, setReset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [shownKey, setShownKey] = useState<string | null>(null);
  const [granted, setGranted] = useState<boolean | null>(null);

  async function create() {
    setBusy(true);
    try {
      const out = await api<{ key: string | null; freeGrant: boolean }>('/dashboard/me/workspace', { method: 'POST', body: { acceptTerms: accept, termsVersion: me.termsVersion, turnstileToken: token } });
      setShownKey(out.key);
      setGranted(out.freeGrant);
      // Reloaded when they leave the key screen: reloading now would switch to the dashboard and lose the key.
    } catch (err) {
      failToast(err);
      setReset((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  if (shownKey) {
    return (<>
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <KeyBadge />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">You&apos;re in.</h1>
          <p className="text-sm text-muted-foreground">{granted ? `Your workspace is ready, with ${tokens(me.freeTier.tokens)} free tokens on ${me.freeTier.models.map(friendlyModel).join(', ')}${me.freeTier.bonusTokens ? `, and ${tokens(me.freeTier.bonusTokens)} more when you first add credit` : ''}.` : 'Your workspace is ready. This email or account already used its free tokens, so add credit to make requests.'}</p>
        </div>
      </div>
      <div className="mb-4 rounded-2xl border border-[#a9f5cf]/50 bg-[#a9f5cf]/5 p-5">
        <div className="mb-1 text-sm font-semibold">Your API key</div>
        <p className="mb-3 text-xs text-muted-foreground">Shown once. Copy it now and keep it secret; you can create more on the API keys page.</p>
        <Code>{shownKey}</Code>
      </div>
      <Quickstart me={me} apiKey={shownKey} />
      <div className="max-w-xs"><MintButton onClick={() => { void reload().then(() => go(granted ? 'keys' : 'billing')); }}>{granted ? 'Go to my dashboard' : 'Add credit'}</MintButton></div>
    </>);
  }
  if (me.onboarding === 'email_verification') {
    return (<>
      <PageHeader title="Verify your email" description="Valefront needs a verified email before it can create your workspace and API key." />
      <Section title={`${me.email} is not verified yet`}>
        <p className="mb-3 text-sm text-muted-foreground">Open the verification email from your Valefront sign-in (Aegis) and confirm your address, then sign in again.</p>
        <Button onClick={() => { window.location.href = '/auth/login?next=/&switch=1'; }}>Sign in again</Button>
      </Section>
    </>);
  }
  if (me.onboarding === 'terms') {
    const f = me.freeTier;
    return (
      <div className="grid items-start gap-10 lg:grid-cols-[1.15fr_1fr]">
        <WelcomeHero name={me.name} freeTokens={tokens(f.tokens)} bonusTokens={f.bonusTokens ? tokens(f.bonusTokens) : undefined} freeDays={f.expiresAfterDays} perDay={tokens(f.tokensPerDay)} models={f.models} />
        <div className="rounded-2xl border bg-card p-5 shadow-[0_20px_60px_-30px_rgba(122,166,255,0.45)] lg:sticky lg:top-8 md:p-6">
          <div className="text-lg font-semibold">Create your workspace</div>
          <p className="mt-1 text-sm text-muted-foreground">Three quick steps. Your first API key appears right after.</p>
          <div className="mt-5 grid gap-3">
            <Step n={1} done={accept} active={!accept} title="Accept the terms">
              <label className="flex cursor-pointer items-start gap-2.5 text-sm text-muted-foreground">
                <input type="checkbox" className="mt-0.5 size-4 accent-[#2f9e6c]" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
                <span>I accept the <a className="font-medium text-foreground underline underline-offset-2" href={me.termsUrl} target="_blank" rel="noreferrer">Terms of Service</a> and have read the <a className="font-medium text-foreground underline underline-offset-2" href={me.privacyUrl} target="_blank" rel="noreferrer">Privacy Policy</a>.</span>
              </label>
            </Step>
            <Step n={2} done={Boolean(token)} active={accept && !token} title="Quick security check">
              <p className="mb-2 text-xs text-muted-foreground">Keeps bots from taking free tokens. It usually passes by itself.</p>
              <Turnstile siteKey={me.turnstileSiteKey} action="signup" onToken={setToken} resetKey={reset} />
            </Step>
            <Step n={3} done={false} active={accept && Boolean(token)} title="Get your API key">
              <MintButton disabled={!accept || !token || busy} onClick={create}>{busy ? 'Creating your workspace…' : 'Create workspace and API key'}</MintButton>
              <p className="mt-2 text-xs text-muted-foreground">Signed in as {me.email}.</p>
            </Step>
          </div>
        </div>
      </div>
    );
  }
  return (<>
    <PageHeader title="Get started" description={<>Signed in as {me.email}.</>} />
    {me.freeTier.granted && !me.freeTier.granted.bonusUnlocked ? <BonusBanner bonus={me.freeTier.bonusTokens ?? 0} onAddCredit={() => go('billing')} /> : null}
    {me.workspace?.suspended ? <Section title="This workspace is suspended"><p className="text-sm">Requests return HTTP 403. Contact support@valefront.com.</p></Section> : null}
    <Section title="Your balance">
      <div className="flex flex-wrap items-center gap-4">
        <div className="text-3xl font-semibold tabular-nums">{usd(me.balanceCents ?? 0)}</div>
        <Button variant="ghost" size="sm" onClick={() => go('billing')}><CreditCard />Billing and receipts</Button>
      </div>
      {me.freeTier.granted ? <p className="mt-3 text-sm text-muted-foreground">Free tokens: {tokens(Math.max(0, me.freeTier.granted.tokens - me.freeTier.granted.usedTokens))} of {tokens(me.freeTier.granted.tokens)} left, until {date(me.freeTier.granted.expiresAt)}.</p> : <div className="mt-3"><FreeTierFacts me={me} /></div>}
      {me.workspace && !me.workspace.suspended ? <div className="mt-4 border-t pt-4"><QuickCredit me={me} reload={reload} go={go} /></div> : null}
    </Section>
    {me.onboarding === 'key' ? <Section title="Create an API key" description="You have no active key."><Button onClick={() => go('keys')}>Go to API keys</Button></Section> : null}
    <Quickstart me={me} />
  </>);
}

/**
 * Add credit from Get started in one screen (Steve: "Quick click add credit at home should allow adding card or
 * charge directly"): an amount, then straight to PayPal (which takes cards) or a Vietnamese bank QR, with the saved
 * receipt details (or a short name/email/country form the first time). The full flow (VAT invoice, WorldFirst) is on
 * the Billing page.
 */
function QuickCredit({ me, reload, go }: { me: Me; reload: () => Promise<void>; go: (p: string) => void }) {
  const [billing, setBilling] = useState<Billing | null>(null);
  const [amount, setAmount] = useState(25);
  const [token, setToken] = useState<string | null>(null);
  const [reset, setReset] = useState(0);
  const [busy, setBusy] = useState<PayMethod | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [form, setForm] = useState({ name: me.name ?? '', email: me.email, country: '' });
  const countries = useMemo(() => COUNTRIES.map((c) => [c, countryName(c)] as const).sort((a, b) => a[1].localeCompare(b[1])), []);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => setBilling(await api<Billing>('/dashboard/me/billing')), []);
  useEffect(() => { void load().catch(() => setFailed(true)); }, [load]);
  if (!billing) return failed ? <Button variant="outline" onClick={() => go('billing')}><CreditCard />Add credit</Button> : <Skeleton className="h-20" />;
  const anyQuick = billing.methods.paypal.enabled || Boolean(billing.methods.sepay?.enabled);
  if (!anyQuick) return <Button variant="outline" onClick={() => go('billing')}><CreditCard />Add credit</Button>;
  if (order?.sepay && order.status === 'pending') {
    return <SepayPanel order={order} onPaid={() => { void load(); void reload(); }} onClose={() => setOrder(null)} />;
  }
  const profile = billing.profile;
  const country = profile?.country ?? form.country;
  const cents = amount * 100;
  const bp = country ? (billing.vat.byCountry[country] ?? billing.vat.defaultBp) : 0;
  const total = cents + Math.round((cents * bp) / 10_000);
  const paypal = billing.methods.paypal;
  const sepay = billing.methods.sepay;
  const formOk = Boolean(profile) || (form.name.trim() && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim()) && form.country);
  async function pay(method: PayMethod) {
    setBusy(method);
    try {
      if (!profile) await api('/dashboard/me/billing/profile', { method: 'PUT', body: form });
      const o = await api<Order>('/dashboard/me/billing/orders', { method: 'POST', body: { amountCents: cents, method, idempotencyKey: newKey(), turnstileToken: token, vatInvoice: false } });
      if (o.approveUrl) {
        window.location.href = o.approveUrl;
        return;
      }
      setOrder(o);
    } catch (err) {
      failToast(err);
    } finally {
      setBusy(null);
      setReset((n) => n + 1);
      void load().catch(() => undefined);
    }
  }
  const ready = Boolean(token) && Boolean(formOk) && !busy;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-sm font-semibold">Add credit</span>
        {[10, 25, 50, 100].map((v) => (
          <button key={v} type="button" onClick={() => setAmount(v)}
            className={cn('h-9 min-w-14 rounded-lg border px-3 text-sm font-semibold tabular-nums transition-colors', amount === v ? 'border-[#a9f5cf]/70 bg-[#a9f5cf]/15' : 'hover:bg-muted/50')}>${v}</button>
        ))}
        <span className="text-xs text-muted-foreground tabular-nums">
          {country ? <>To pay {usd(total)}{bp ? ` incl. ${(bp / 100).toFixed(bp % 100 ? 2 : 0)}% VAT` : ''}</> : null}
          {sepay?.enabled && sepay.vndPerUsd && country ? <> · about {vnd(vndOf(total, sepay.vndPerUsd))}</> : null}
        </span>
      </div>
      {profile ? (
        <p className="text-xs text-muted-foreground">Receipt to <span className="font-medium text-foreground">{profile.company || profile.name}</span> · {profile.email} · {countryName(profile.country)}. <button type="button" className="underline" onClick={() => go('billing')}>Change</button>
          {profile.country === 'VN' ? <> · Need a VAT invoice (hóa đơn GTGT)? <button type="button" className="underline" onClick={() => go('billing')}>Add credit on Billing</button>.</> : null}</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="grid gap-1"><Label htmlFor="qc-name">Name on receipt</Label><Input id="qc-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="grid gap-1"><Label htmlFor="qc-email">Billing email</Label><Input id="qc-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div className="grid gap-1"><Label htmlFor="qc-country">Country (sets VAT)</Label>
            <select id="qc-country" className="h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })}>
              <option value="">Choose…</option>{countries.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
            </select></div>
        </div>
      )}
      <Turnstile siteKey={me.turnstileSiteKey} action="add_credit" onToken={setToken} resetKey={reset} />
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button className="sm:flex-1" disabled={!ready || !paypal.enabled} onClick={() => pay('paypal')}>
          <CreditCard />{busy === 'paypal' ? 'Opening PayPal…' : paypal.enabled ? `Pay with card or PayPal${paypal.env === 'sandbox' ? ' (test mode)' : ''}` : 'Card or PayPal: coming soon'}
        </Button>
        {sepay?.enabled ? (
          <Button className="sm:flex-1" variant="outline" disabled={!ready} onClick={() => pay('sepay')}><QrCode />{busy === 'sepay' ? 'Making the QR…' : 'Bank QR (VND)'}</Button>
        ) : null}
      </div>
    </div>
  );
}

function KeysPage({ me }: { me: Me }) {
  const [keys, setKeys] = useState<KeyView[] | null>(null);
  const [name, setName] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [reset, setReset] = useState(0);
  const [shown, setShown] = useState<string | null>(null);
  const [offer, setOffer] = useState<PiiOffer | null>(null);
  const [newPii, setNewPii] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    const out = await api<{ keys: KeyView[]; addons?: { piiProtection?: PiiOffer } }>('/dashboard/me/keys');
    setKeys(out.keys);
    setOffer(out.addons?.piiProtection ?? null);
  }, []);
  useEffect(() => { void load().catch(failToast); }, [load]);
  async function create() {
    try {
      const out = await api<{ key: string }>('/dashboard/me/keys', { method: 'POST', body: { name, turnstileToken: token, piiProtection: newPii } });
      setShown(out.key);
      setName('');
      setNewPii(false);
      await load();
    } catch (err) {
      failToast(err);
    } finally {
      setReset((n) => n + 1);
    }
  }
  async function setPii(k: KeyView, enabled: boolean, mode?: 'regex' | 'presidio') {
    setBusy(k.id);
    try {
      await api(`/dashboard/me/keys/${k.id}/pii`, { method: 'PUT', body: { enabled, ...(mode ? { mode } : {}) } });
      toast.success(enabled ? `PII protection is on for "${k.name}".` : `PII protection is off for "${k.name}".`);
      await load();
    } catch (err) {
      failToast(err);
    } finally {
      setBusy(null);
    }
  }
  async function setRouting(k: KeyView, strategy: RoutingStrategy | null) {
    setBusy(k.id);
    try {
      await api(`/dashboard/me/keys/${k.id}/routing`, { method: 'PUT', body: { strategy } });
      toast.success(strategy ? `"${k.name}" routes auto by ${strategy}.` : `"${k.name}" routes auto as before.`);
      await load();
    } catch (err) {
      failToast(err);
    } finally {
      setBusy(null);
    }
  }
  async function revoke(k: KeyView) {
    if (!window.confirm(`Revoke "${k.name}" (${k.prefix}…)? Anything using it stops working.`)) return;
    try {
      await api(`/dashboard/me/keys/${k.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      failToast(err);
    }
  }
  return (<>
    <PageHeader title="API keys" description="Keys for your apps and agents. Each is shown once, when you make it." />
    {shown ? <Section title="Your new key" description="Copy it now: it won't be shown again."><Code>{shown}</Code></Section> : null}
    <Section title="New key">
      <div className="grid gap-3 sm:max-w-md">
        <div className="grid gap-1"><Label htmlFor="key-name">Name</Label><Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claude Code on my laptop" /></div>
        <div className="flex items-start gap-3">
          <Switch id="new-key-pii" checked={newPii} onCheckedChange={setNewPii} className="mt-0.5" />
          <div className="grid gap-0.5">
            <Label htmlFor="new-key-pii">PII protection{offer ? <span className="font-normal text-muted-foreground"> · {piiPrice(offer)}</span> : null}</Label>
            <p className="text-xs text-muted-foreground">{PII_EXPLAINER} Charged from credit, on top of the model's price.</p>
          </div>
        </div>
        <Turnstile siteKey={me.turnstileSiteKey} action="create_key" onToken={setToken} resetKey={reset} />
        <div><Button disabled={!token} onClick={create}><KeyRound />Create key</Button></div>
      </div>
    </Section>
    <Section title="Your keys">
      {!keys ? <Skeleton className="h-16" /> : keys.length === 0 ? <p className="text-sm text-muted-foreground">No keys yet.</p> : (
        <div className="grid gap-2">
          {keys.map((k) => (
            <div key={k.id} className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm">
              <div className="min-w-0 flex-1"><div className="font-medium">{k.name}</div><div className="text-xs text-muted-foreground"><code>{k.prefix}…</code> · made {date(k.createdAt)}{k.lastUsedAt ? ` · last used ${date(k.lastUsedAt)}` : ''}</div></div>
              <div className="text-xs text-muted-foreground tabular-nums">{tokens(k.usage.requests)} requests this month</div>
              {k.revokedAt ? <span className="text-xs text-destructive">revoked</span> : <Button variant="outline" size="sm" onClick={() => revoke(k)}>Revoke</Button>}
              {k.revokedAt ? null : (
                <div className="flex w-full items-start gap-3 border-t pt-3">
                  <Switch id={`pii-${k.id}`} checked={(k.piiProtection ?? 'off') !== 'off'} disabled={busy === k.id}
                    onCheckedChange={(on) => setPii(k, on, on && k.piiProtection === 'presidio' ? 'presidio' : undefined)} className="mt-0.5" />
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <Label htmlFor={`pii-${k.id}`} className="flex items-center gap-1.5"><ShieldCheck className="size-3.5" />PII protection{offer ? <span className="font-normal text-muted-foreground"> · {piiPrice(offer)}</span> : null}</Label>
                    <p className="text-xs text-muted-foreground">{PII_EXPLAINER}</p>
                  </div>
                  {(k.piiProtection ?? 'off') !== 'off' && offer && offer.modes.includes('presidio') ? (
                    <select aria-label={`PII protection mode for ${k.name}`} className="h-8 rounded-md border bg-background px-2 text-xs" value={k.piiProtection} disabled={busy === k.id}
                      onChange={(e) => setPii(k, true, e.target.value as 'regex' | 'presidio')}>
                      <option value="regex">Fast (patterns)</option>
                      <option value="presidio">Thorough (also names, addresses, IDs)</option>
                    </select>
                  ) : null}
                </div>
              )}
              {k.revokedAt ? null : (
                <div className="flex w-full flex-wrap items-center gap-3 border-t pt-3">
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <Label htmlFor={`routing-${k.id}`}>Routing for <code>auto</code></Label>
                    <p className="text-xs text-muted-foreground">Which model answers <code>model: "auto"</code> chat requests. A request naming <code>auto:cheapest</code>, <code>auto:best</code>, <code>auto:fastest</code> or <code>auto:balanced</code> wins. You pay the price of the model that answers.</p>
                  </div>
                  <select id={`routing-${k.id}`} className="h-8 rounded-md border bg-background px-2 text-xs" value={k.routingStrategy ?? ''} disabled={busy === k.id}
                    onChange={(e) => setRouting(k, (e.target.value || null) as RoutingStrategy | null)}>
                    <option value="">Default (Balanced)</option>
                    {ROUTING_STRATEGY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}: {o.hint}</option>)}
                  </select>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  </>);
}

function UsagePage({ me }: { me: Me }) {
  const [data, setData] = useState<{ month: string; keys: KeyView[]; free: { tokens: number; usedTokens: number; expiresAt: number } | null; addons?: { piiProtection?: PiiOffer } } | null>(null);
  useEffect(() => { void api<typeof data>('/dashboard/me/usage').then(setData).catch(failToast); }, []);
  const byModel = useMemo(() => {
    const out: Record<string, { requests: number; tokens: number }> = {};
    for (const k of data?.keys ?? []) for (const [m, u] of Object.entries(k.usage.byModel)) {
      out[m] = { requests: (out[m]?.requests ?? 0) + u.requests, tokens: (out[m]?.tokens ?? 0) + u.tokens };
    }
    return Object.entries(out).sort((a, b) => b[1].tokens - a[1].tokens);
  }, [data]);
  const pii = useMemo(() => {
    const out = { requests: 0, tokens: 0, usd: 0 };
    for (const k of data?.keys ?? []) {
      const a = k.usage.addons?.[PII_ID];
      if (a) { out.requests += a.requests; out.tokens += a.tokens; out.usd += a.usd; }
    }
    return out;
  }, [data]);
  const promotions = useMemo(() => {
    const out: Record<string, PromotionLine> = {};
    for (const k of data?.keys ?? []) for (const [id, p] of Object.entries(k.usage.promotions ?? {})) {
      const o = out[id] ?? { name: p.name, requests: 0, tokens: 0, officialUsd: 0, discountUsd: 0 };
      out[id] = { name: p.name || o.name, requests: o.requests + p.requests, tokens: o.tokens + p.tokens, officialUsd: o.officialUsd + p.officialUsd, discountUsd: o.discountUsd + p.discountUsd };
    }
    return Object.entries(out);
  }, [data]);
  return (<>
    <PageHeader title="Spending" description={data ? `Usage this month (${data.month}, UTC). Charges are on the ledger on the Billing page.` : undefined} />
    {data?.free ? <Section title="Free tokens">
      <div className="mb-2 h-2 overflow-hidden rounded bg-muted"><div className="h-full bg-primary" style={{ width: `${Math.min(100, (data.free.usedTokens / data.free.tokens) * 100)}%` }} /></div>
      <p className="text-sm text-muted-foreground">{tokens(data.free.usedTokens)} of {tokens(data.free.tokens)} used · until {date(data.free.expiresAt)} · on {me.freeTier.models.join(', ')}</p>
    </Section> : null}
    <Section title="By model">
      {!data ? <Skeleton className="h-16" /> : byModel.length === 0 ? <p className="text-sm text-muted-foreground">No requests this month.</p> : (
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-2">Model</th><th className="p-2 text-right">Requests</th><th className="p-2 text-right">Tokens</th></tr></thead>
          <tbody>{byModel.map(([m, u]) => <tr key={m} className="border-b last:border-0"><td className="p-2 font-medium break-all">{m}</td><td className="p-2 text-right tabular-nums">{tokens(u.requests)}</td><td className="p-2 text-right tabular-nums">{tokens(u.tokens)}</td></tr>)}</tbody></table></div>
      )}
    </Section>
    {pii.requests > 0 || (data?.keys ?? []).some((k) => (k.piiProtection ?? 'off') !== 'off') ? <Section title="Add-ons" description="Charged from credit on top of model usage; on the Billing page's ledger as their own line.">
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-2">Add-on</th><th className="p-2 text-right">Requests</th><th className="p-2 text-right">Input tokens</th><th className="p-2 text-right">Charged</th></tr></thead>
        <tbody><tr><td className="p-2 font-medium">PII protection{data?.addons?.piiProtection ? <span className="block text-xs font-normal text-muted-foreground">{piiPrice(data.addons.piiProtection)}</span> : null}</td><td className="p-2 text-right tabular-nums">{tokens(pii.requests)}</td><td className="p-2 text-right tabular-nums">{tokens(pii.tokens)}</td><td className="p-2 text-right tabular-nums">${pii.usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}</td></tr></tbody></table></div>
    </Section> : null}
    {promotions.length ? <Section title="Promotions" description="Requests charged at a promotion price: their cost at the official price, the discount, and what was charged.">
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-2">Promotion</th><th className="p-2 text-right">Requests</th><th className="p-2 text-right">Official price</th><th className="p-2 text-right">Discount</th><th className="p-2 text-right">Charged</th></tr></thead>
        <tbody>{promotions.map(([id, p]) => <tr key={id} className="border-b last:border-0"><td className="p-2 font-medium">{p.name}</td><td className="p-2 text-right tabular-nums">{tokens(p.requests)}</td><td className="p-2 text-right tabular-nums">{usd6(p.officialUsd)}</td><td className="p-2 text-right tabular-nums text-emerald-600 dark:text-emerald-300">−{usd6(p.discountUsd)}</td><td className="p-2 text-right tabular-nums">{usd6(Math.max(0, p.officialUsd - p.discountUsd))}</td></tr>)}</tbody></table></div>
    </Section> : null}
    <Section title="By key">
      {(data?.keys ?? []).map((k) => <div key={k.id} className="flex justify-between gap-3 border-b py-2 text-sm last:border-0"><span className="min-w-0">{k.name} <code className="text-xs text-muted-foreground">{k.prefix}…</code></span><span className="shrink-0 whitespace-nowrap tabular-nums">{tokens(k.usage.promptTokens + k.usage.completionTokens)} tokens</span></div>)}
    </Section>
  </>);
}

const COUNTRIES = 'AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'.split(' ');

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

function ProfileForm({ billing, onSaved, onCancel }: { billing: Billing; onSaved: () => Promise<void>; onCancel?: () => void }) {
  const [p, setP] = useState<Profile>(billing.profile ?? { name: '', email: billing.email, country: '' });
  const countries = useMemo(() => COUNTRIES.map((c) => [c, countryName(c)] as const).sort((a, b) => a[1].localeCompare(b[1])), []);
  const set = (k: keyof Profile) => (e: { target: { value: string } }) => setP({ ...p, [k]: e.target.value });
  async function save() {
    try {
      await api('/dashboard/me/billing/profile', { method: 'PUT', body: p });
      toast.success('Billing details saved');
      await onSaved();
    } catch (err) {
      failToast(err);
    }
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="grid gap-1"><Label htmlFor="bp-name">Name *</Label><Input id="bp-name" value={p.name} onChange={set('name')} /></div>
      <div className="grid gap-1"><Label htmlFor="bp-email">Billing email *</Label><Input id="bp-email" type="email" value={p.email} onChange={set('email')} /></div>
      <div className="grid gap-1"><Label htmlFor="bp-company">Company (optional)</Label><Input id="bp-company" value={p.company ?? ''} onChange={set('company')} /></div>
      <div className="grid gap-1"><Label htmlFor="bp-tax">Tax ID (optional)</Label><Input id="bp-tax" value={p.taxId ?? ''} onChange={set('taxId')} /></div>
      <div className="grid gap-1 sm:col-span-2"><Label htmlFor="bp-address">Address (optional)</Label><Input id="bp-address" value={p.address ?? ''} onChange={set('address')} /></div>
      <div className="grid gap-1"><Label htmlFor="bp-country">Country *</Label>
        <select id="bp-country" className="h-9 rounded-md border bg-background px-2 text-sm" value={p.country} onChange={set('country')}>
          <option value="">Choose…</option>{countries.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
        </select></div>
      <div className="flex items-end gap-2"><Button onClick={save}>Save details</Button>{onCancel ? <Button variant="ghost" onClick={onCancel}>Cancel</Button> : null}</div>
    </div>
  );
}

function vatOf(billing: Billing, cents: number) {
  const country = billing.profile?.country ?? '';
  const bp = billing.vat.byCountry[country] ?? billing.vat.defaultBp;
  const vat = Math.round((cents * bp) / 10_000);
  return { bp, vat, total: cents + vat };
}

function AddCredit({ me, billing, onOrder, onSaved }: { me: Me; billing: Billing; onOrder: (o: Order) => void; onSaved: () => Promise<void> }) {
  const [amount, setAmount] = useState('25');
  const sepay = billing.methods.sepay;
  const [method, setMethod] = useState<PayMethod>(billing.methods.worldfirst ? 'worldfirst' : billing.methods.paypal.enabled || !sepay?.enabled ? 'paypal' : 'sepay');
  const [token, setToken] = useState<string | null>(null);
  const [reset, setReset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [idem, setIdem] = useState(newKey);
  const inVietnam = billing.profile?.country === 'VN';
  const [wantVat, setWantVat] = useState(Boolean(billing.profile?.vatInvoice));
  const [vat, setVat] = useState<VatInvoice>(billing.profile?.vatInvoice ?? { companyName: billing.profile?.company ?? '', taxCode: billing.profile?.taxId ?? '', address: billing.profile?.address ?? '', email: billing.profile?.email ?? billing.email });
  const setV = (k: keyof VatInvoice) => (e: { target: { value: string } }) => { setVat({ ...vat, [k]: e.target.value }); setIdem(newKey()); };
  const cents = Math.round(Number(amount) * 100);
  const valid = Number.isFinite(cents) && cents >= billing.minimumCents && /^\d+(\.\d{1,2})?$/.test(amount);
  const { bp, vat: vatCents, total } = vatOf(billing, valid ? cents : 0);
  const anyMethod = billing.methods.paypal.enabled || billing.methods.worldfirst || Boolean(sepay?.enabled);
  async function submit() {
    setBusy(true);
    try {
      const vatInvoice = inVietnam && wantVat;
      if (vatInvoice) await api('/dashboard/me/billing/vat-invoice', { method: 'PUT', body: vat });
      const order = await api<Order>('/dashboard/me/billing/orders', { method: 'POST', body: { amountCents: cents, method, idempotencyKey: idem, turnstileToken: token, vatInvoice } });
      if (order.approveUrl) {
        window.location.href = order.approveUrl;
        return;
      }
      onOrder(order);
      setIdem(newKey());
    } catch (err) {
      failToast(err);
    } finally {
      setBusy(false);
      setReset((n) => n + 1);
    }
  }
  const [editing, setEditing] = useState(false);
  if (!anyMethod) return <p className="text-sm text-muted-foreground">Payments are not available right now. Please try again later.</p>;
  const profile = billing.profile;
  const AMOUNTS = [10, 25, 50, 100];
  const methodCard = (id: PayMethod, title: string, detail: string, enabled: boolean) => (
    <button key={id} type="button" disabled={!enabled} onClick={() => { setMethod(id); setIdem(newKey()); }}
      className={cn('flex min-w-0 flex-1 flex-col items-start gap-1 rounded-xl border p-3 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        method === id && enabled ? 'border-[#a9f5cf]/70 bg-[#a9f5cf]/10' : 'hover:bg-muted/50')}>
      <span className="flex items-center gap-2 font-semibold">{id === 'paypal' ? <CreditCard className="size-4" /> : id === 'sepay' ? <QrCode className="size-4" /> : <Landmark className="size-4" />}{title}</span>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </button>
  );
  return (
    <div className="grid gap-3">
      <Step n={1} done={valid} active={!valid} title="Choose an amount">
        <div className="flex flex-wrap gap-2">
          {AMOUNTS.map((v) => (
            <button key={v} type="button" onClick={() => { setAmount(String(v)); setIdem(newKey()); }}
              className={cn('h-10 min-w-16 rounded-lg border px-4 text-sm font-semibold tabular-nums transition-colors', amount === String(v) ? 'border-[#a9f5cf]/70 bg-[#a9f5cf]/15' : 'hover:bg-muted/50')}>${v}</button>
          ))}
          <div className="flex h-10 items-center rounded-lg border px-3 focus-within:ring-2 focus-within:ring-ring/40">
            <span className="text-sm text-muted-foreground">$</span>
            <input aria-label="Other amount in US dollars" inputMode="decimal" className="w-20 bg-transparent px-1 text-sm font-semibold tabular-nums outline-none" placeholder="Other"
              value={AMOUNTS.map(String).includes(amount) ? '' : amount} onChange={(e) => { setAmount(e.target.value.trim()); setIdem(newKey()); }} />
          </div>
        </div>
        {!valid && amount ? <p className="mt-2 text-xs text-destructive">Enter at least {usd(billing.minimumCents)}.</p> : <p className="mt-2 text-xs text-muted-foreground">Minimum {usd(billing.minimumCents)}. Credit doesn&apos;t expire.</p>}
      </Step>
      <Step n={2} done={valid && Boolean(method)} active={valid} title="Pay with">
        <div className="grid gap-2 sm:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
          {methodCard('worldfirst', 'Bank transfer (USD)', 'Credit is added when the transfer arrives, usually 1–3 business days.', billing.methods.worldfirst)}
          {methodCard('paypal', billing.methods.paypal.enabled ? `PayPal or card${billing.methods.paypal.env === 'sandbox' ? ' (test mode)' : ''}` : 'PayPal or card', billing.methods.paypal.enabled ? 'Instant.' : 'Coming soon.', billing.methods.paypal.enabled)}
          {sepay?.enabled ? methodCard('sepay', 'Vietnamese bank transfer (QR, VND)', 'Scan with any Vietnamese banking app. Credit is added within a minute or two.', true) : null}
        </div>
      </Step>
      <Step n={3} done={Boolean(profile) && !editing} active={valid && (!profile || editing)} title="Receipt details">
        {profile && !editing ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="min-w-0 text-muted-foreground"><span className="font-medium text-foreground">{profile.company || profile.name}</span> · {profile.email} · {countryName(profile.country)}{profile.taxId ? ` · Tax ID ${profile.taxId}` : ''}</span>
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>Edit</Button>
          </div>
        ) : (
          <><p className="mb-3 text-xs text-muted-foreground">Shown on your receipt. Your country sets the VAT: 0% outside Vietnam (export of services), 10% in Vietnam.</p>
          <ProfileForm billing={billing} onSaved={async () => { setEditing(false); await onSaved(); }} onCancel={profile ? () => setEditing(false) : undefined} /></>
        )}
        {inVietnam && !editing ? (
          <div className="mt-3 grid gap-2 rounded-lg border p-3">
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={wantVat} onChange={(e) => { setWantVat(e.target.checked); setIdem(newKey()); }} /><span>I need a Vietnamese VAT invoice (hóa đơn GTGT)</span></label>
            {wantVat ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="grid gap-1 sm:col-span-2"><Label htmlFor="vat-company">Company name (tên đơn vị)</Label><Input id="vat-company" value={vat.companyName} onChange={setV('companyName')} /></div>
                <div className="grid gap-1"><Label htmlFor="vat-mst">Tax code (MST): 10 or 13 digits</Label><Input id="vat-mst" inputMode="numeric" value={vat.taxCode} onChange={setV('taxCode')} placeholder="0123456789 or 0123456789-001" /></div>
                <div className="grid gap-1"><Label htmlFor="vat-email">Email to receive the invoice</Label><Input id="vat-email" type="email" value={vat.email} onChange={setV('email')} /></div>
                <div className="grid gap-1 sm:col-span-2"><Label htmlFor="vat-address">Company address</Label><Input id="vat-address" value={vat.address} onChange={setV('address')} /></div>
                <p className="text-xs text-muted-foreground sm:col-span-2">{billing.vatInvoices?.automatic === false
                  ? 'We issue it by hand after payment and email it to you, usually within 2 business days. Saved for next time.'
                  : 'Issued as an e-invoice through Viettel S-Invoice after payment, and emailed to you. Saved for next time.'}</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </Step>
      <Step n={4} done={false} active={valid && Boolean(profile) && !editing} title="Review and pay">
        {valid && profile ? (
          <div className="mb-3 grid gap-1 rounded-lg bg-muted/60 p-3 text-sm tabular-nums">
            <div className="flex justify-between"><span className="text-muted-foreground">Credit</span><span>{usd(cents)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">VAT {(bp / 100).toFixed(bp % 100 ? 2 : 0)}%</span><span>{usd(vatCents)}</span></div>
            <div className="mt-1 flex justify-between border-t pt-2 font-semibold"><span>To pay</span><span>{usd(total)}</span></div>
            {method === 'sepay' && sepay?.vndPerUsd ? <div className="flex justify-between text-xs text-muted-foreground"><span>In VND at {sepay.vndPerUsd.toLocaleString('en-US')} VND/USD ({sepay.rateDate})</span><span>about {vnd(vndOf(total, sepay.vndPerUsd))}</span></div> : null}
          </div>
        ) : <p className="mb-3 text-xs text-muted-foreground">{!valid ? 'Choose an amount first.' : 'Save your receipt details first.'}</p>}
        <Turnstile siteKey={me.turnstileSiteKey} action="add_credit" onToken={setToken} resetKey={reset} />
        <div className="mt-3 max-w-sm"><MintButton disabled={!valid || !profile || editing || !token || busy} onClick={submit}>{busy ? 'Working…' : method === 'paypal' ? `Pay ${valid ? usd(total) : ''} with PayPal` : method === 'sepay' ? `Show the QR for ${valid ? usd(total) : ''}` : `Get bank details for ${valid ? usd(total) : ''}`}</MintButton></div>
      </Step>
    </div>
  );
}

function BankTransfer({ order }: { order: Order }) {
  const t = order.bankTransfer!;
  const rows = [
    ['Amount', `${(t.amount / 100).toFixed(2)} USD`], ['Reference', t.reference], ['Account name', t.account.accountName], ['Account number', t.account.accountNumber],
    ['Bank', t.account.bankName], ['SWIFT/BIC', t.account.swiftCode], ...(t.account.routingNumber ? [['Routing number', t.account.routingNumber]] : []), ...(t.account.bankAddress ? [['Bank address', t.account.bankAddress]] : []),
  ];
  return (
    <div className="grid gap-3">
      <div className="grid gap-1 text-sm">{rows.map(([k, v]) => <div key={k} className="flex flex-wrap items-center justify-between gap-2 border-b py-1.5 last:border-0"><span className="text-muted-foreground">{k}</span><span className="flex items-center gap-2 font-medium break-all">{v}<CopyButton value={v} size="icon" label={`Copy ${k}`} /></span></div>)}</div>
      <ul className="list-disc pl-5 text-sm text-muted-foreground">{t.instructions.map((i) => <li key={i}>{i}</li>)}{t.account.instructions ? <li>{t.account.instructions}</li> : null}</ul>
    </div>
  );
}

/** Ticks every second while mounted (countdowns). */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t); }, []);
  return now;
}

/**
 * A SePay order waiting for its transfer: the VietQR, the details to type by hand, a countdown on the quote, and a
 * check every 10 s (SePay's webhook usually credits it within a minute) until it's paid.
 */
function SepayPanel({ order: initial, onPaid, onClose, onCancel }: { order: Order; onPaid: (o: Order) => void; onClose: () => void; onCancel?: (o: Order) => void }) {
  const [order, setOrder] = useState(initial);
  const [checking, setChecking] = useState(false);
  const now = useNow();
  const ticks = useRef(0);
  const paidOnce = useRef(false);
  const s = order.sepay!;
  const left = Math.max(0, s.expiresAt - now);
  const expired = s.expired || left === 0;
  const settle = useCallback((o: Order) => {
    setOrder(o);
    if (o.status === 'paid' && !paidOnce.current) {
      paidOnce.current = true;
      toast.success(`Paid: ${usd(o.amountCents)} credit added. Your receipt is on its way by email.`);
      onPaid(o);
    }
  }, [onPaid]);
  useEffect(() => { setOrder(initial); }, [initial]);
  useEffect(() => {
    if (order.status !== 'pending') return;
    const t = window.setInterval(() => {
      ticks.current++;
      // Every 10 s: our record (the webhook credits it); every 30 s also ask SePay directly.
      const path = ticks.current % 3 === 0 ? `/dashboard/me/billing/orders/${order.id}/sepay-check` : `/dashboard/me/billing/orders/${order.id}`;
      void api<Order>(path, ticks.current % 3 === 0 ? { method: 'POST', body: {} } : {}).then(settle).catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(t);
  }, [order.id, order.status, settle]);
  async function checkNow() {
    setChecking(true);
    try {
      const o = await api<Order & { checked?: boolean }>(`/dashboard/me/billing/orders/${order.id}/sepay-check`, { method: 'POST', body: {} });
      settle(o);
      if (o.status !== 'paid') toast.message(o.checked ? 'Not arrived yet. Transfers usually show up within a minute or two; we keep checking.' : 'Checked a moment ago; we keep checking every few seconds.');
    } catch (err) {
      failToast(err);
    } finally {
      setChecking(false);
    }
  }
  async function requote() {
    try {
      setOrder(await api<Order>(`/dashboard/me/billing/orders/${order.id}/sepay-quote`, { method: 'POST', body: {} }));
    } catch (err) {
      failToast(err);
    }
  }
  if (order.status === 'paid') {
    return (
      <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/5 p-5 text-sm">
        <div className="font-semibold">Paid: {usd(order.amountCents)} credit added</div>
        <p className="mt-1 text-muted-foreground">Order <code>{order.reference}</code>. Your receipt is on its way by email.</p>
        <Button className="mt-3" variant="outline" size="sm" onClick={onClose}>Done</Button>
      </div>
    );
  }
  const due = s.leftVnd || s.amountVnd;
  const rows: Array<[string, string]> = [
    ['Bank', s.bankName], ['Account number', s.accountNumber], ...(s.accountName ? [['Account name', s.accountName] as [string, string]] : []),
    ['Amount (VND)', String(due)], ['Transfer content', s.transferContent],
  ];
  const mm = String(Math.floor(left / 60_000)).padStart(2, '0');
  const ss = String(Math.floor((left % 60_000) / 1000)).padStart(2, '0');
  return (
    <div className="rounded-2xl border border-[#a9f5cf]/50 bg-[#a9f5cf]/5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-semibold">Transfer {vnd(due)} to add {usd(order.amountCents)}</div>
        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums', expired ? 'bg-destructive/15 text-destructive' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300')}>{expired ? 'Quote expired' : `Valid for ${mm}:${ss}`}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Scan with your banking app: the amount and content fill in by themselves. Keep the transfer content exactly as shown so we can match it. Rate {s.vndPerUsd.toLocaleString('en-US')} VND/USD ({s.rateDate}).</p>
      {s.receivedVnd > 0 ? <p className="mt-2 rounded-lg bg-amber-500/10 p-2 text-xs">We received {vnd(s.receivedVnd)} of {vnd(s.amountVnd)}. Transfer the remaining {vnd(s.leftVnd)} with the same content.</p> : null}
      {expired ? (
        <div className="mt-3 grid gap-2 text-sm">
          <p className="text-muted-foreground">This quote ran out (the rate changes daily). If you already paid, it is still credited at the quoted amount; check below. Otherwise get a new quote.</p>
          <div className="flex flex-wrap gap-2"><Button size="sm" onClick={requote}>Get a new quote</Button><Button size="sm" variant="outline" disabled={checking} onClick={checkNow}>{checking ? 'Checking…' : "I've paid — check now"}</Button></div>
        </div>
      ) : (
        <div className="mt-3 grid gap-4 sm:grid-cols-[auto_1fr] sm:items-start">
          <img src={s.qrUrl} alt={`VietQR: ${vnd(due)} to ${s.bankName} ${s.accountNumber}, content ${s.transferContent}`} className="mx-auto size-56 rounded-xl border bg-white p-2" />
          <div className="grid gap-1 text-sm">
            {rows.map(([k, v]) => <div key={k} className="flex flex-wrap items-center justify-between gap-2 border-b py-1.5 last:border-0"><span className="text-muted-foreground">{k}</span><span className="flex items-center gap-2 text-right font-medium tabular-nums [overflow-wrap:anywhere]">{k === 'Amount (VND)' ? vnd(Number(v)) : v}<CopyButton value={v} size="icon" label={`Copy ${k}`} /></span></div>)}
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" disabled={checking} onClick={checkNow}>{checking ? 'Checking…' : "I've paid — check now"}</Button>
              <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
              {onCancel ? <Button size="sm" variant="ghost" onClick={() => onCancel(order)}>Cancel order</Button> : null}
            </div>
            <p className="text-xs text-muted-foreground">This page checks by itself every 10 seconds.</p>
          </div>
        </div>
      )}
    </div>
  );
}

const usd6 = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
const promoEnd = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';

/** dash Billing: enter a promo code; the promotions this workspace has. */
function PromoCode({ promotions, onChange }: { promotions: Promotions; onChange: (p: Promotions) => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  async function redeem() {
    if (!code.trim()) return;
    setBusy(true);
    try {
      const out = await api<{ campaign: Promotion; already: boolean; promotions: Promotions }>('/dashboard/me/billing/promo-code', { method: 'POST', body: { code: code.trim() } });
      toast.success(out.already ? `${out.campaign.name} is already on this workspace.` : `${out.campaign.name}: promotion prices apply until ${promoEnd(out.campaign.ends_at)}.`);
      onChange(out.promotions);
      setCode('');
    } catch (err) {
      failToast(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rounded-2xl border bg-card p-5">
      <div className="mb-1 font-semibold">Promo code</div>
      <p className="mb-3 text-xs text-muted-foreground">A promotion lowers the price of some models until it ends. Spending shows the official cost and the discount.</p>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void redeem(); }}>
        <Label htmlFor="promo-code" className="sr-only">Promo code</Label>
        <Input id="promo-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Enter a code" autoComplete="off" className="uppercase" />
        <Button type="submit" variant="outline" disabled={busy || !code.trim()}>Apply</Button>
      </form>
      {promotions.campaigns.length ? (
        <div className="mt-3 grid gap-2">{promotions.campaigns.map((c) => (
          <div key={c.id} className="rounded-xl border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{c.name}</span><span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', c.live ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300' : 'bg-muted text-muted-foreground')}>{c.live ? 'On now' : 'Starts soon'}</span></div>
            <div className="mt-1 text-xs text-muted-foreground">{c.discount.kind === 'percent' ? `${c.discount.percent}% off` : 'Promotion prices'} on {c.models.map(friendlyModel).join(', ')} · until {promoEnd(c.ends_at)}{c.code ? <> · code <code>{c.code}</code></> : null}</div>
          </div>
        ))}</div>
      ) : null}
    </div>
  );
}

/** A VAT invoice's state on an order: the file or its number and lookup code, "requested", or why it was turned down. */
function EInvoiceStatus({ i }: { i: EInvoiceView }) {
  if (i.status === 'issued' && i.invoiceNo) {
    return <>
      {i.file ? <a className="underline" href={apiUrl(`/dashboard/me/billing/einvoices/${i.id}.pdf`)}>VAT invoice {i.invoiceNo}</a> : <span>VAT invoice {i.invoiceNo}</span>}
      {i.reservationCode ? <span className="text-muted-foreground">Lookup code <code>{i.reservationCode}</code>{i.lookupUrl ? <> at <a className="underline" href={i.lookupUrl} target="_blank" rel="noreferrer">{i.lookupUrl.replace(/^https:\/\//, '')}</a></> : null}</span> : null}
    </>;
  }
  if (i.status === 'requested') return <span className="text-muted-foreground">VAT invoice requested — we&apos;ll email it to {i.email}</span>;
  if (i.status === 'rejected') return <span className="text-destructive">VAT invoice request declined{i.rejectReason ? `: ${i.rejectReason}` : ''}</span>;
  return <span className="text-muted-foreground">{i.status === 'pending' ? 'VAT invoice being issued' : `VAT invoice ${i.status}`}</span>;
}

/**
 * "Request VAT invoice" for a paid order without one: with the saved VAT invoice details, or a short form for them
 * first (saved for next time, as at checkout).
 */
function RequestVatInvoice({ billing, order, again, onDone }: { billing: Billing; order: Order; again?: boolean; onDone: () => Promise<void> }) {
  const saved = billing.profile?.vatInvoice;
  const [form, setForm] = useState<VatInvoice | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof VatInvoice) => (e: { target: { value: string } }) => setForm((f) => (f ? { ...f, [k]: e.target.value } : f));
  async function send(details?: VatInvoice) {
    setBusy(true);
    try {
      if (details) await api('/dashboard/me/billing/vat-invoice', { method: 'PUT', body: details });
      const r = await api<{ einvoice: { status: string } }>(`/dashboard/me/billing/orders/${order.id}/vat-invoice`, { method: 'POST', body: {} });
      toast.success(r.einvoice.status === 'requested' ? "VAT invoice requested. We'll email it to you." : r.einvoice.status === 'issued' ? 'VAT invoice issued and emailed to you.' : 'VAT invoice on its way.');
      setForm(null);
      await onDone();
    } catch (err) {
      failToast(err);
    } finally {
      setBusy(false);
    }
  }
  const label = again ? 'Request again' : 'Request VAT invoice';
  if (!form) {
    return <Button variant="outline" size="sm" className="h-7" disabled={busy} onClick={() => (saved && !again ? void send() : setForm(saved ?? { companyName: billing.profile?.company ?? '', taxCode: billing.profile?.taxId ?? '', address: billing.profile?.address ?? '', email: billing.profile?.email ?? billing.email }))}>{busy ? 'Working…' : label}</Button>;
  }
  return (
    <div className="mt-1 grid w-full gap-2 rounded-lg border p-3 sm:grid-cols-2">
      <div className="grid gap-1 sm:col-span-2"><Label htmlFor={`rv-company-${order.id}`}>Company name (tên đơn vị)</Label><Input id={`rv-company-${order.id}`} value={form.companyName} onChange={set('companyName')} /></div>
      <div className="grid gap-1"><Label htmlFor={`rv-mst-${order.id}`}>Tax code (MST): 10 or 13 digits</Label><Input id={`rv-mst-${order.id}`} inputMode="numeric" value={form.taxCode} onChange={set('taxCode')} placeholder="0123456789 or 0123456789-001" /></div>
      <div className="grid gap-1"><Label htmlFor={`rv-email-${order.id}`}>Email to receive the invoice</Label><Input id={`rv-email-${order.id}`} type="email" value={form.email} onChange={set('email')} /></div>
      <div className="grid gap-1 sm:col-span-2"><Label htmlFor={`rv-address-${order.id}`}>Company address</Label><Input id={`rv-address-${order.id}`} value={form.address} onChange={set('address')} /></div>
      <div className="flex gap-2 sm:col-span-2"><Button size="sm" disabled={busy} onClick={() => void send(form)}>{busy ? 'Working…' : 'Request VAT invoice'}</Button><Button variant="ghost" size="sm" onClick={() => setForm(null)}>Cancel</Button></div>
    </div>
  );
}

function BillingPage({ me, reload }: { me: Me; reload: () => Promise<void> }) {
  const [billing, setBilling] = useState<Billing | null>(null);
  const [open, setOpen] = useState<Order | null>(null);
  const load = useCallback(async () => setBilling(await api<Billing>('/dashboard/me/billing')), []);
  useEffect(() => { void load().catch(failToast); }, [load]);

  // Back from PayPal (/billing?paypal=return&order=…; older links #/billing?…): capture, once.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search || (window.location.hash.split('?')[1] ?? ''));
    const order = q.get('order');
    const flow = q.get('paypal');
    if (!order || !flow) return;
    window.history.replaceState(null, '', '/billing');
    if (flow === 'cancel') { toast.message('Payment cancelled; nothing was charged.'); return; }
    void api<Order>(`/dashboard/me/billing/orders/${order}/paypal-capture`, { method: 'POST', body: {} })
      .then((o) => { toast.success(o.status === 'paid' ? `Paid: ${usd(o.amountCents)} credit added. Your receipt is on its way by email.` : 'Payment received; credit is added as soon as PayPal confirms it.'); })
      .catch(failToast)
      .finally(() => { void load(); void reload(); });
  }, [load, reload]);

  async function cancel(o: Order) {
    try {
      await api(`/dashboard/me/billing/orders/${o.id}/cancel`, { method: 'POST', body: {} });
      setOpen(null);
      await load();
    } catch (err) {
      failToast(err);
    }
  }
  async function view(o: Order) {
    try {
      setOpen(await api<Order>(`/dashboard/me/billing/orders/${o.id}`));
    } catch (err) {
      failToast(err);
    }
  }
  if (!billing) return <div className="grid gap-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-40" /></div>;
  const receiptFor = new Map(billing.receipts.map((r) => [r.orderId, r]));
  const einvoiceFor = new Map(billing.einvoices.map((i) => [i.orderId, i]));
  const free = billing.free;
  const freeLeft = free ? Math.max(0, free.tokens - free.usedTokens) : 0;
  const statusBadge = (st: Order['status']) => (
    <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', st === 'paid' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300' : st === 'pending' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'bg-muted text-muted-foreground')}>
      {st === 'paid' ? 'Paid' : st === 'pending' ? 'Waiting for payment' : 'Cancelled'}
    </span>
  );
  return (<>
    <PageHeader title="Billing" description="Prepaid credit in US dollars, charged per request at each model's official price (or a promotion price while one applies). Free tokens are used first." />
    {free && !free.bonusUnlocked ? <BonusBanner bonus={free.bonusTokens ?? 0} /> : null}
    <div className="mb-6 grid gap-4 rounded-2xl border bg-card p-5 md:grid-cols-[1fr_1.2fr] md:items-center md:p-6">
      <div>
        <div className="text-xs font-medium text-muted-foreground uppercase">Available credit</div>
        <div className="mt-1 text-4xl font-semibold tracking-tight tabular-nums">{usd(billing.availableCents)}</div>
        {billing.pendingUsageCents > 0 ? <p className="mt-1 text-xs text-muted-foreground">After {usd(Math.ceil(billing.pendingUsageCents))} of recent usage.</p> : null}
        {billing.availableCents <= 0 ? <p className="mt-2 text-xs text-muted-foreground">{free && freeLeft > 0 ? 'You are on free tokens. Add credit to use other models, or to keep going after them.' : 'Add credit to make requests (without it they return HTTP 402).'}</p> : null}
      </div>
      {free ? (
        <div className="rounded-xl bg-muted/50 p-4">
          <div className="flex items-baseline justify-between text-sm"><span className="font-medium">Free tokens</span><span className="tabular-nums text-muted-foreground">{tokens(freeLeft)} of {tokens(free.tokens)} left</span></div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-gradient-to-r from-[#a9f5cf] to-[#7aa6ff]" style={{ width: `${free.tokens ? Math.max(2, (freeLeft / free.tokens) * 100) : 0}%` }} /></div>
          <div className="mt-2 text-xs text-muted-foreground">Until {date(free.expiresAt)}{free.models.length ? <> · on {free.models.map(friendlyModel).join(', ')}</> : null}</div>
        </div>
      ) : null}
    </div>
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        {open?.sepay && open.status === 'pending' ? (
          <div className="mb-4"><SepayPanel order={open} onPaid={() => { void load(); void reload(); }} onClose={() => setOpen(null)} onCancel={cancel} /></div>
        ) : null}
        {open?.bankTransfer ? (
          <div className="mb-4 rounded-2xl border border-[#a9f5cf]/50 bg-[#a9f5cf]/5 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2"><div className="font-semibold">Transfer {usd(open.bankTransfer.amount)} to finish order <code>{open.reference}</code></div>{statusBadge(open.status)}</div>
            <p className="mt-1 mb-3 text-xs text-muted-foreground">Include the reference so we can match your payment. Credit is added when it arrives, and your receipt is emailed.</p>
            <BankTransfer order={open} />
            <div className="mt-3 flex gap-2"><Button variant="outline" size="sm" onClick={() => setOpen(null)}>Done</Button><Button variant="ghost" size="sm" onClick={() => cancel(open)}>Cancel order</Button></div>
          </div>
        ) : null}
        <div className="rounded-2xl border bg-card p-5 md:p-6">
          <div className="mb-4 text-lg font-semibold">Add credit</div>
          <AddCredit me={me} billing={billing} onOrder={(o) => { setOpen(o); void load(); }} onSaved={load} />
        </div>
      </div>
      <div className="grid min-w-0 gap-4">
        {billing.promotions?.available ? <PromoCode promotions={billing.promotions} onChange={(p) => setBilling((b) => (b ? { ...b, promotions: p } : b))} /> : null}
        <div className="rounded-2xl border bg-card p-5">
          <div className="mb-1 font-semibold">Orders and receipts</div>
          <p className="mb-3 text-xs text-muted-foreground">Every payment gets a receipt by email. Customers in Vietnam can ask for a VAT invoice when adding credit, or here up to {billing.vatInvoices?.requestWindowDays ?? 30} days after paying.</p>
          {billing.orders.length === 0 ? <p className="text-sm text-muted-foreground">No orders yet.</p> : (
            <div className="grid gap-2">{billing.orders.map((o) => {
              const r = receiptFor.get(o.id);
              const i = einvoiceFor.get(o.id);
              return (
                <div key={o.id} className="grid gap-1.5 rounded-xl border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold tabular-nums">{usd(o.amountCents)}</span>{statusBadge(o.status)}</div>
                  <div className="text-xs text-muted-foreground">{date(o.createdAt)} · {METHOD_NAMES[o.method]} · <code>{o.reference}</code>{o.vatCents ? ` · ${usd(o.totalCents)} incl. VAT` : ''}</div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    {r ? <><a className="underline" href={apiUrl(`/dashboard/me/billing/receipts/${r.id}`)} target="_blank" rel="noreferrer">Receipt {r.number}</a><a className="text-muted-foreground underline" href={apiUrl(`/dashboard/me/billing/receipts/${r.id}.pdf`)}>PDF</a></> : null}
                    {i ? <EInvoiceStatus i={i} /> : null}
                    {o.vatInvoiceRequestable && billing.profile?.country === 'VN' ? <RequestVatInvoice billing={billing} order={o} again={i?.status === 'rejected'} onDone={load} /> : null}
                    {o.status === 'pending' && o.method === 'worldfirst' ? <Button variant="outline" size="sm" className="h-7" onClick={() => view(o)}>Bank details</Button> : null}
                    {o.status === 'pending' && o.method === 'sepay' ? <Button variant="outline" size="sm" className="h-7" onClick={() => view(o)}>Show QR</Button> : null}
                    {o.status === 'pending' ? <Button variant="ghost" size="sm" className="h-7" onClick={() => cancel(o)}>Cancel</Button> : null}
                  </div>
                </div>
              );
            })}</div>
          )}
        </div>
        <details className="group rounded-2xl border bg-card p-5">
          <summary className="flex cursor-pointer list-none items-center justify-between font-semibold">Ledger<ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" /></summary>
          <p className="mt-1 mb-3 text-xs text-muted-foreground">Every credit and charge. Usage is moved here in whole cents.</p>
          {billing.ledger.length === 0 ? <p className="text-sm text-muted-foreground">Nothing yet.</p> : (
            <div className="grid gap-1 text-sm">{billing.ledger.map((l) => <div key={l.id} className="flex items-baseline justify-between gap-3 border-b py-1.5 last:border-0"><span className="min-w-0"><span className="block truncate">{l.description}</span><span className="text-xs text-muted-foreground">{date(l.createdAt)}</span></span><span className={cn('shrink-0 tabular-nums', l.amountCents < 0 ? 'text-muted-foreground' : 'text-emerald-600 dark:text-emerald-300')}>{usd(l.amountCents)}</span></div>)}</div>
          )}
        </details>
      </div>
    </div>
  </>);
}

function DataPage({ me }: { me: Me }) {
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  async function remove() {
    if (!window.confirm('Delete your Valefront account? Your keys stop working at once. This cannot be undone.')) return;
    setBusy(true);
    try {
      await api('/dashboard/me', { method: 'DELETE', body: { confirm } });
      window.location.href = 'https://valefront.com/';
    } catch (err) {
      failToast(err);
      setBusy(false);
    }
  }
  return (<>
    <PageHeader title="Your data" description={<>Questions or requests about your data: <a className="underline" href={`mailto:${me.privacyContact}`}>{me.privacyContact}</a>. See the <a className="underline" href={me.privacyUrl} target="_blank" rel="noreferrer">Privacy Policy</a>.</>} />
    <Section title="Export" description="Everything Valefront keeps about your account, as JSON: profile, API keys (names and prefixes, never the secrets), usage, ledger, orders, receipts and VAT invoices.">
      <Button asChild variant="outline"><a href={apiUrl('/dashboard/me/export')} download>Download my data</a></Button>
    </Section>
    <Section title="Delete account" description="Revokes and deletes your API keys and deletes your workspace, usage and billing details. Receipts, VAT invoices, payments and the credit ledger are kept for 10 years, as accounting law requires, then deleted. A hash of your email is kept so free tokens can't be claimed twice. Unused credit is not refunded automatically: ask support@valefront.com first (within 30 days of purchase).">
      <div className="grid gap-3 sm:max-w-md">
        <div className="grid gap-1"><Label htmlFor="confirm-email">Type {me.email} to confirm</Label><Input id="confirm-email" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" /></div>
        <div><Button variant="destructive" disabled={busy || confirm.trim().toLowerCase() !== me.email.toLowerCase()} onClick={remove}>Delete my account</Button></div>
      </div>
    </Section>
  </>);
}
