/**
 * Sandbox | Live per payment and invoice provider, switched by an admin (not by redeploying), with both credential
 * sets side by side as Worker secrets named per mode. Kept free of Valefront specifics so Bookkeeper's admin can use
 * the same module: give it a settings store and an audit function.
 *
 * - The mode lives in admin settings (`provider_mode:<provider>`); a provider never set is in sandbox.
 * - Switching to live needs the admin to type LIVE, and is audit-logged with who did it.
 * - The admin page shows each provider's mode and whether each mode's secrets are present (yes/no, never values).
 */
export type ProviderMode = 'sandbox' | 'live';

export type ProviderSpec = {
  label: string;
  /** Secret names per mode, in the order the provider's config takes them. */
  secrets: Record<ProviderMode, string[]>;
  /** Names that may be missing (optional overrides). */
  optional?: string[];
};

const perMode = (prefix: string, names: string[]): Record<ProviderMode, string[]> => ({
  sandbox: names.map((n) => `${prefix}_SANDBOX_${n}`),
  live: names.map((n) => `${prefix}_LIVE_${n}`),
});

/** WorldFirst bank transfer has no sandbox: it isn't here. */
export const PROVIDERS = {
  paypal: { label: 'PayPal', secrets: perMode('PAYPAL', ['CLIENT_ID', 'CLIENT_SECRET', 'WEBHOOK_ID']) },
  sinvoice: {
    label: 'Viettel S-Invoice',
    secrets: perMode('VIETTEL_SINVOICE', ['USERNAME', 'PASSWORD', 'TAX_CODE', 'TEMPLATE_CODE', 'SERIES', 'BASE_URL']),
    optional: ['BASE_URL'],
  },
} satisfies Record<string, ProviderSpec>;

export type ProviderId = keyof typeof PROVIDERS;

/** The admin-settings store the mode is kept in (Valefront: D1BillingStore; Bookkeeper: its own). */
export interface ModeSettingsStore {
  setting<T>(key: string): Promise<{ value: T; updatedAt: number; updatedBy: string } | null>;
  saveSetting(key: string, value: unknown, by: string): Promise<void>;
}

export type ModeAudit = (event: { type: string; meta: Record<string, unknown> }) => Promise<void>;

const key = (provider: string) => `provider_mode:${provider}`;

export async function getMode(store: ModeSettingsStore, provider: ProviderId): Promise<ProviderMode> {
  const saved = (await store.setting<{ mode: ProviderMode }>(key(provider)))?.value?.mode;
  return saved === 'live' ? 'live' : 'sandbox';
}

export class ModeChangeError extends Error {}

/** Sets a provider's mode. Live only with confirm === 'LIVE'. Audit-logged either way. */
export async function setMode(
  store: ModeSettingsStore,
  provider: ProviderId,
  mode: ProviderMode,
  input: { by: string; confirm?: string; audit?: ModeAudit },
): Promise<void> {
  if (!(provider in PROVIDERS)) throw new ModeChangeError(`Unknown provider ${provider}`);
  if (mode !== 'sandbox' && mode !== 'live') throw new ModeChangeError('Mode is sandbox or live');
  if (mode === 'live' && input.confirm?.trim() !== 'LIVE') throw new ModeChangeError('Type LIVE to switch to live mode.');
  if (!input.by) throw new ModeChangeError('Who is switching must be known');
  const before = await getMode(store, provider);
  await store.saveSetting(key(provider), { mode }, input.by);
  await input.audit?.({ type: 'provider.mode_changed', meta: { provider, from: before, to: mode, by: input.by } });
  console.log(JSON.stringify({ event: 'provider_mode_changed', provider, from: before, to: mode, by: input.by }));
}

/** The secrets for a provider in a mode, keyed by their short name (CLIENT_ID…), or null when any required one is missing. */
export function secretsFor(env: Record<string, string | undefined>, provider: ProviderId, mode: ProviderMode): Record<string, string> | null {
  const spec: ProviderSpec = PROVIDERS[provider];
  const prefix = mode === 'live' ? '_LIVE_' : '_SANDBOX_';
  const out: Record<string, string> = {};
  for (const name of spec.secrets[mode]) {
    const short = name.slice(name.indexOf(prefix) + prefix.length);
    const value = env[name]?.trim();
    if (value) out[short] = value;
    else if (!spec.optional?.includes(short)) return null;
  }
  return out;
}

/** For the admin page: per provider, its mode and whether each mode's required secrets are all set (no values). */
export async function providerStatus(store: ModeSettingsStore, env: Record<string, string | undefined>) {
  return Promise.all((Object.keys(PROVIDERS) as ProviderId[]).map(async (id) => {
    const spec: ProviderSpec = PROVIDERS[id];
    const present = (mode: ProviderMode) => spec.secrets[mode].map((name) => ({ name, set: Boolean(env[name]?.trim()), optional: Boolean(spec.optional?.some((o) => name.endsWith(`_${o}`))) }));
    return {
      id,
      label: spec.label,
      mode: await getMode(store, id),
      sandbox: { ready: secretsFor(env, id, 'sandbox') !== null, secrets: present('sandbox') },
      live: { ready: secretsFor(env, id, 'live') !== null, secrets: present('live') },
    };
  }));
}
