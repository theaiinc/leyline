import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BookOpen, Calculator, CreditCard, Database, KeyRound, LogOut, Moon, Sun, Wallet } from 'lucide-react';
import { SideNav, navIds, type NavEntry } from '@/components/side-nav';
import { CalculatorPage } from '@/pages/calculator';
import { toast } from 'sonner';
import { api, apiUrl } from '@/api';
import { CopyButton, PageHeader } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useHashRoute } from '@/hooks/use-hash-route';
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
  freeTier: { tokens: number; expiresAfterDays: number; models: string[]; tokensPerDay: number; granted: { tokens: number; usedTokens: number; expiresAt: number } | null };
};

type KeyView = { id: string; name: string; prefix: string; createdAt: number; revokedAt: number | null; lastUsedAt: number | null; usage: { month: string; requests: number; promptTokens: number; completionTokens: number; byModel: Record<string, { requests: number; tokens: number }> } };

type VatInvoice = { companyName: string; taxCode: string; address: string; email: string };
type Profile = { name: string; email: string; company?: string; taxId?: string; address?: string; country: string; vatInvoice?: VatInvoice };
type Order = {
  id: string; method: 'worldfirst' | 'paypal' | 'sepay'; status: 'pending' | 'paid' | 'cancelled'; amountCents: number; vatRateBp: number; vatCents: number; totalCents: number;
  reference: string; createdAt: number; paidAt: number | null; approveUrl?: string; vatInvoice?: boolean;
  bankTransfer?: { account: Record<string, string>; amount: number; reference: string; instructions: string[] };
};
type Billing = {
  balanceCents: number; availableCents: number; pendingUsageCents: number; minimumCents: number; email: string;
  ledger: Array<{ id: string; amountCents: number; kind: string; description: string; createdAt: number }>;
  orders: Order[];
  receipts: Array<{ id: string; orderId: string; number: string; issuedAt: number; amountCents: number; totalCents: number; emailStatus: string | null }>;
  einvoices: Array<{ id: string; orderId: string; status: string; invoiceNo: string | null; codeOfTax: string | null; reservationCode: string | null; issuedAt: number | null; totalCents: number; email: string }>;
  profile: Profile | null;
  free: { tokens: number; usedTokens: number; expiresAt: number; models: string[] } | null;
  methods: { worldfirst: boolean; paypal: { enabled: boolean; env: string | null } };
  vat: { defaultBp: number; byCountry: Record<string, number> };
};

const usd = (cents: number) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (t: number) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const tokens = (n: number) => n.toLocaleString('en-US');
const newKey = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');

const NAV: NavEntry[] = [
  { id: 'get-started', label: 'Get started', icon: BookOpen },
  { id: 'keys', label: 'API keys', icon: KeyRound },
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
  const [page, go] = useHashRoute('get-started');
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
    <div className="min-h-svh md:grid md:grid-cols-[15rem_1fr]">
      <aside className="border-b bg-sidebar md:sticky md:top-0 md:flex md:h-svh md:flex-col md:border-r md:border-b-0">
        <div className="flex items-center gap-2 px-4 py-3 md:py-5">
          <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" className="size-8" />
          <div className="leading-tight"><div className="font-semibold">Valefront</div><div className="max-w-[10rem] truncate text-xs text-muted-foreground">{me?.email ?? ''}</div></div>
          <div className="ml-auto flex md:hidden">
            <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="Toggle theme">{dark ? <Sun /> : <Moon />}</Button>
            <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out"><LogOut /></Button>
          </div>
        </div>
        {ready ? <SideNav entries={NAV} current={current} go={go} /> : null}
        <div className="mt-auto hidden p-3 md:flex md:gap-1">
          <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="Toggle theme">{dark ? <Sun /> : <Moon />}</Button>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={signOut}><LogOut />Sign out</Button>
        </div>
      </aside>
      <main className="min-w-0 px-4 py-6 md:px-8 md:py-8">
        <div className="mx-auto max-w-4xl">
          {error ? <Card><CardContent className="text-sm text-destructive">{error}</CardContent></Card>
            : !me ? <div className="grid gap-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-40" /></div>
              : current === 'keys' ? <KeysPage me={me} />
                : current === 'spending' ? <UsagePage me={me} />
                : current === 'calculator' ? <CalculatorPage />
                  : current === 'billing' ? <BillingPage me={me} reload={load} />
                    : current === 'data' ? <DataPage me={me} />
                      : <GetStarted me={me} reload={load} go={go} />}
        </div>
      </main>
    </div>
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
  return <div className="relative min-w-0 max-w-full"><pre className="max-w-full overflow-x-auto rounded-md bg-muted p-3 pr-20 text-xs leading-relaxed">{children}</pre><div className="absolute top-2 right-2"><CopyButton value={children} /></div></div>;
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

function FreeTierFacts({ me }: { me: Me }) {
  const f = me.freeTier;
  return <p className="text-sm text-muted-foreground">New accounts get <strong>{tokens(f.tokens)} free tokens</strong> for {f.expiresAfterDays} days on {f.models.join(', ')} (up to {tokens(f.tokensPerDay)} a day). Other models, and use after that, are pay as you go from prepaid credit at each provider&apos;s official price.</p>;
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
          <p className="text-sm text-muted-foreground">{granted ? `Your workspace is ready, with ${tokens(me.freeTier.tokens)} free tokens on ${me.freeTier.models.map(friendlyModel).join(', ')}.` : 'Your workspace is ready. This email or account already used its free tokens, so add credit to make requests.'}</p>
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
        <WelcomeHero name={me.name} freeTokens={tokens(f.tokens)} freeDays={f.expiresAfterDays} perDay={tokens(f.tokensPerDay)} models={f.models} />
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
    {me.workspace?.suspended ? <Section title="This workspace is suspended"><p className="text-sm">Requests return HTTP 403. Contact support@valefront.com.</p></Section> : null}
    <Section title="Your balance">
      <div className="flex flex-wrap items-center gap-4">
        <div className="text-3xl font-semibold tabular-nums">{usd(me.balanceCents ?? 0)}</div>
        <Button variant="outline" onClick={() => go('billing')}><CreditCard />Add credit</Button>
      </div>
      {me.freeTier.granted ? <p className="mt-3 text-sm text-muted-foreground">Free tokens: {tokens(Math.max(0, me.freeTier.granted.tokens - me.freeTier.granted.usedTokens))} of {tokens(me.freeTier.granted.tokens)} left, until {date(me.freeTier.granted.expiresAt)}.</p> : <div className="mt-3"><FreeTierFacts me={me} /></div>}
    </Section>
    {me.onboarding === 'key' ? <Section title="Create an API key" description="You have no active key."><Button onClick={() => go('keys')}>Go to API keys</Button></Section> : null}
    <Quickstart me={me} />
  </>);
}

function KeysPage({ me }: { me: Me }) {
  const [keys, setKeys] = useState<KeyView[] | null>(null);
  const [name, setName] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [reset, setReset] = useState(0);
  const [shown, setShown] = useState<string | null>(null);
  const load = useCallback(async () => setKeys((await api<{ keys: KeyView[] }>('/dashboard/me/keys')).keys), []);
  useEffect(() => { void load().catch(failToast); }, [load]);
  async function create() {
    try {
      const out = await api<{ key: string }>('/dashboard/me/keys', { method: 'POST', body: { name, turnstileToken: token } });
      setShown(out.key);
      setName('');
      await load();
    } catch (err) {
      failToast(err);
    } finally {
      setReset((n) => n + 1);
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
            </div>
          ))}
        </div>
      )}
    </Section>
  </>);
}

function UsagePage({ me }: { me: Me }) {
  const [data, setData] = useState<{ month: string; keys: KeyView[]; free: { tokens: number; usedTokens: number; expiresAt: number } | null } | null>(null);
  useEffect(() => { void api<typeof data>('/dashboard/me/usage').then(setData).catch(failToast); }, []);
  const byModel = useMemo(() => {
    const out: Record<string, { requests: number; tokens: number }> = {};
    for (const k of data?.keys ?? []) for (const [m, u] of Object.entries(k.usage.byModel)) {
      out[m] = { requests: (out[m]?.requests ?? 0) + u.requests, tokens: (out[m]?.tokens ?? 0) + u.tokens };
    }
    return Object.entries(out).sort((a, b) => b[1].tokens - a[1].tokens);
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
    <Section title="By key">
      {(data?.keys ?? []).map((k) => <div key={k.id} className="flex justify-between border-b py-2 text-sm last:border-0"><span>{k.name} <code className="text-xs text-muted-foreground">{k.prefix}…</code></span><span className="tabular-nums">{tokens(k.usage.promptTokens + k.usage.completionTokens)} tokens</span></div>)}
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

function ProfileForm({ billing, onSaved }: { billing: Billing; onSaved: () => Promise<void> }) {
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
      <div className="flex items-end"><Button variant="outline" onClick={save}>Save billing details</Button></div>
    </div>
  );
}

function vatOf(billing: Billing, cents: number) {
  const country = billing.profile?.country ?? '';
  const bp = billing.vat.byCountry[country] ?? billing.vat.defaultBp;
  const vat = Math.round((cents * bp) / 10_000);
  return { bp, vat, total: cents + vat };
}

function AddCredit({ me, billing, onOrder }: { me: Me; billing: Billing; onOrder: (o: Order) => void }) {
  const [amount, setAmount] = useState('20');
  const [method, setMethod] = useState<'paypal' | 'worldfirst'>(billing.methods.paypal.enabled ? 'paypal' : 'worldfirst');
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
  const anyMethod = billing.methods.paypal.enabled || billing.methods.worldfirst;
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
  if (!billing.profile) return <p className="text-sm text-muted-foreground">Add your billing details above first: they go on your receipt.</p>;
  if (!anyMethod) return <p className="text-sm text-muted-foreground">Payments are not available right now. Please try again later.</p>;
  return (
    <div className="grid gap-4">
      <div className="grid gap-1 sm:max-w-xs">
        <Label htmlFor="amount">Credit (USD, at least {usd(billing.minimumCents)})</Label>
        <Input id="amount" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value.trim()); setIdem(newKey()); }} />
        <div className="flex flex-wrap gap-1">{[10, 20, 50, 100].map((v) => <Button key={v} size="sm" variant="outline" onClick={() => { setAmount(String(v)); setIdem(newKey()); }}>${v}</Button>)}</div>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Pay with</legend>
        {billing.methods.paypal.enabled ? <label className="flex items-start gap-2 text-sm"><input type="radio" className="mt-1" checked={method === 'paypal'} onChange={() => { setMethod('paypal'); setIdem(newKey()); }} /><span><strong>PayPal or card</strong> — instant{billing.methods.paypal.env === 'sandbox' ? ' (test mode)' : ''}</span></label> : null}
        {billing.methods.worldfirst ? <label className="flex items-start gap-2 text-sm"><input type="radio" className="mt-1" checked={method === 'worldfirst'} onChange={() => { setMethod('worldfirst'); setIdem(newKey()); }} /><span><strong>Bank transfer (USD)</strong> — credit added when the transfer arrives, usually 1–3 business days</span></label> : null}
      </fieldset>
      {inVietnam ? (
        <div className="grid gap-2 rounded-md border p-3">
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={wantVat} onChange={(e) => { setWantVat(e.target.checked); setIdem(newKey()); }} /><span>I need a Vietnamese VAT invoice (hóa đơn GTGT)</span></label>
          {wantVat ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-1 sm:col-span-2"><Label htmlFor="vat-company">Company name (tên đơn vị)</Label><Input id="vat-company" value={vat.companyName} onChange={setV('companyName')} /></div>
              <div className="grid gap-1"><Label htmlFor="vat-mst">Tax code (MST): 10 or 13 digits</Label><Input id="vat-mst" inputMode="numeric" value={vat.taxCode} onChange={setV('taxCode')} placeholder="0123456789 or 0123456789-001" /></div>
              <div className="grid gap-1"><Label htmlFor="vat-email">Email to receive the invoice</Label><Input id="vat-email" type="email" value={vat.email} onChange={setV('email')} /></div>
              <div className="grid gap-1 sm:col-span-2"><Label htmlFor="vat-address">Company address</Label><Input id="vat-address" value={vat.address} onChange={setV('address')} /></div>
              <p className="text-xs text-muted-foreground sm:col-span-2">Issued as an e-invoice through Viettel S-Invoice after payment, and emailed to you. Saved for next time.</p>
            </div>
          ) : null}
        </div>
      ) : null}
      {valid ? <div className="rounded-md bg-muted p-3 text-sm tabular-nums">Credit {usd(cents)} + VAT {(bp / 100).toFixed(bp % 100 ? 2 : 0)}% {usd(vatCents)} = <strong>{usd(total)}</strong> to pay</div> : <p className="text-sm text-destructive">Enter at least {usd(billing.minimumCents)}.</p>}
      <Turnstile siteKey={me.turnstileSiteKey} action="add_credit" onToken={setToken} resetKey={reset} />
      <div><Button disabled={!valid || !token || busy} onClick={submit}><CreditCard />{busy ? 'Working…' : method === 'paypal' ? 'Continue to PayPal' : 'Get bank details'}</Button></div>
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

function BillingPage({ me, reload }: { me: Me; reload: () => Promise<void> }) {
  const [billing, setBilling] = useState<Billing | null>(null);
  const [open, setOpen] = useState<Order | null>(null);
  const load = useCallback(async () => setBilling(await api<Billing>('/dashboard/me/billing')), []);
  useEffect(() => { void load().catch(failToast); }, [load]);

  // Back from PayPal (#/billing?paypal=return&order=…): capture, once.
  useEffect(() => {
    const q = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    const order = q.get('order');
    const flow = q.get('paypal');
    if (!order || !flow) return;
    window.history.replaceState(null, '', '/#/billing');
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
  return (<>
    <PageHeader title="Billing" description="Prepaid credit in US dollars. Each request is charged at its model's official price; free tokens are used first on free-tier models." />
    <Section title="Balance">
      <div className="text-3xl font-semibold tabular-nums">{usd(billing.availableCents)}</div>
      {billing.pendingUsageCents > 0 ? <p className="mt-1 text-xs text-muted-foreground">Includes {usd(Math.ceil(billing.pendingUsageCents))} of usage not yet on the ledger.</p> : null}
      {billing.free ? <p className="mt-2 text-sm text-muted-foreground">Free tokens: {tokens(Math.max(0, billing.free.tokens - billing.free.usedTokens))} left until {date(billing.free.expiresAt)}.</p> : null}
      {billing.availableCents <= 0 ? <p className="mt-2 text-sm text-warning">With no credit, requests other than free tokens return HTTP 402 insufficient_credit.</p> : null}
    </Section>
    <Section title="Billing details" description="Shown on your receipts. Your country sets the VAT: 0% outside Vietnam (export of services), 10% in Vietnam."><ProfileForm billing={billing} onSaved={load} /></Section>
    <Section title="Add credit"><AddCredit me={me} billing={billing} onOrder={(o) => { setOpen(o); void load(); }} /></Section>
    {open?.bankTransfer ? <Section title={`Bank transfer ${open.reference}`} description="Pay this order from your bank."><BankTransfer order={open} /><div className="mt-3 flex gap-2"><Button variant="outline" size="sm" onClick={() => setOpen(null)}>Close</Button><Button variant="ghost" size="sm" onClick={() => cancel(open)}>Cancel order</Button></div></Section> : null}
    <Section title="Orders and receipts" description="Every payment gets a receipt by email. Customers in Vietnam can ask for a VAT invoice (hóa đơn GTGT) when adding credit.">
      {billing.orders.length === 0 ? <p className="text-sm text-muted-foreground">No orders yet.</p> : (
        <div className="grid gap-2">{billing.orders.map((o) => {
          const r = receiptFor.get(o.id);
          const i = einvoiceFor.get(o.id);
          return (
            <div key={o.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border p-3 text-sm">
              <div className="min-w-0 flex-1"><div className="font-medium">{usd(o.amountCents)} credit · {o.method === 'paypal' ? 'PayPal' : 'Bank transfer'}</div><div className="text-xs text-muted-foreground">{date(o.createdAt)} · <code>{o.reference}</code> · {o.status}{o.vatCents ? ` · paid ${usd(o.totalCents)} incl. VAT` : ''}</div></div>
              {i ? (i.status === 'issued' && i.invoiceNo
                ? <span className="flex flex-wrap gap-2"><a className="underline" href={apiUrl(`/dashboard/me/billing/einvoices/${i.id}.pdf`)}>VAT invoice {i.invoiceNo} (PDF)</a>{i.codeOfTax ? <span className="text-xs text-muted-foreground">CQT {i.codeOfTax}</span> : null}</span>
                : i.status === 'pending' ? <span className="text-xs text-muted-foreground">Your VAT invoice is being issued</span> : <span className="text-xs text-muted-foreground">VAT invoice {i.status}</span>) : null}
              {r ? <span className="flex gap-2"><a className="underline" href={apiUrl(`/dashboard/me/billing/receipts/${r.id}`)} target="_blank" rel="noreferrer">Receipt {r.number}</a><a className="text-muted-foreground underline" href={apiUrl(`/dashboard/me/billing/receipts/${r.id}.pdf`)}>PDF</a></span> : null}
              {o.status === 'pending' && o.method === 'worldfirst' ? <Button variant="outline" size="sm" onClick={() => view(o)}>Bank details</Button> : null}
              {o.status === 'pending' ? <Button variant="ghost" size="sm" onClick={() => cancel(o)}>Cancel</Button> : null}
            </div>
          );
        })}</div>
      )}
    </Section>
    <Section title="Ledger" description="Every credit and charge. Usage is moved here in whole cents.">
      {billing.ledger.length === 0 ? <p className="text-sm text-muted-foreground">Nothing yet.</p> : (
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b"><th className="p-2">Date</th><th className="p-2">Entry</th><th className="p-2 text-right">Amount</th></tr></thead>
          <tbody>{billing.ledger.map((l) => <tr key={l.id} className="border-b last:border-0"><td className="p-2 whitespace-nowrap">{date(l.createdAt)}</td><td className="p-2">{l.description}</td><td className={cn('p-2 text-right tabular-nums', l.amountCents < 0 ? 'text-muted-foreground' : 'text-success')}>{usd(l.amountCents)}</td></tr>)}</tbody></table></div>
      )}
    </Section>
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
