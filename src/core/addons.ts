/**
 * Paid add-ons customers turn on per API key, charged from prepaid credit on top of model usage.
 *
 * PII protection (src/core/pii-redaction.ts): personal data in the prompt is masked before it leaves Valefront and
 * restored in the reply. Regex mode (always offered) masks emails, phone numbers, card numbers (Luhn-checked) and API
 * keys/secrets; Presidio mode (offered only where PRESIDIO_ANALYZER_URL is set) also finds names, addresses and IDs.
 * It costs PII_PRICE_PER_M_TOKENS US dollars per million input (prompt) tokens of each request it protects; free
 * tokens never cover it.
 */

/** The id used everywhere: /v1/pricing's addons, the spend line's model, the key usage's addons. */
export const PII_ADDON_ID = 'pii-protection';
export const PII_ADDON_NAME = 'PII protection';
/** The spend line's provider (admin Spending): Valefront itself, not an upstream provider. */
export const ADDON_PROVIDER = 'Valefront';
/** US dollars per million input tokens, unless PII_PRICE_PER_M_TOKENS sets another price. */
export const DEFAULT_PII_PRICE_PER_M_TOKENS = 0.2;

let warned = '';

/**
 * The price, US dollars per 1M input tokens: PII_PRICE_PER_M_TOKENS when it is a positive number, else the default
 * (an unset, empty, zero, negative or malformed value never makes the add-on free by accident; it is logged).
 */
export function piiPricePerMTokens(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PII_PRICE_PER_M_TOKENS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PII_PRICE_PER_M_TOKENS;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  if (warned !== raw) {
    warned = raw;
    console.warn(JSON.stringify({ event: 'pii_price_invalid', value: raw, using: DEFAULT_PII_PRICE_PER_M_TOKENS }));
  }
  return DEFAULT_PII_PRICE_PER_M_TOKENS;
}

/**
 * The fee for `inputTokens`, in millionths of a dollar (what the billing store accrues), rounded up: integer
 * arithmetic on the price in micro-dollars per 1M tokens, so 1,000 tokens at $0.20/1M is exactly 200 micros.
 */
export function piiFeeMicros(inputTokens: number, pricePerM = piiPricePerMTokens()): number {
  const tokens = Math.max(0, Math.round(inputTokens));
  const microsPerM = Math.round(pricePerM * 1_000_000);
  if (!tokens || microsPerM <= 0) return 0;
  return Math.ceil((tokens * microsPerM) / 1_000_000);
}

/** PII modes a customer may choose: regex always; Presidio only where an analyzer is configured. */
export function customerPiiModes(env: Record<string, string | undefined> = process.env): Array<'regex' | 'presidio'> {
  return env.PRESIDIO_ANALYZER_URL?.trim() ? ['regex', 'presidio'] : ['regex'];
}

/** What /v1/pricing publishes. */
export function publicAddons(env: Record<string, string | undefined> = process.env) {
  return [{
    id: PII_ADDON_ID,
    name: PII_ADDON_NAME,
    unit: 'per 1M input tokens',
    price: piiPricePerMTokens(env),
    description: 'Emails, phone numbers, card numbers and API keys in your prompts are masked before the prompt leaves Valefront and restored in the reply. Turn it on per API key on the dashboard; charged from credit (free tokens do not cover it).',
  }];
}
