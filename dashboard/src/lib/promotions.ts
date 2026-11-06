/** Promotions as /v1/pricing publishes them (src/core/admin-campaigns.ts pricingPromotions): shared display helpers. */

/** On a model or media entry of /v1/pricing: the live automatic campaign giving it its lowest price. */
export type PricingPromotion = {
  campaign_id: string;
  name: string;
  ends_at: string;
  input?: number;
  output?: number;
  cached_input?: number;
  per_image?: number;
  per_1m_video_tokens?: number;
};

/** "until 14 Nov 2026, 00:00 UTC" */
export function promoUntil(endsAt: string | number): string {
  const d = new Date(endsAt);
  if (Number.isNaN(d.getTime())) return '';
  return `until ${d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;
}

/** US dollars with as many decimals as the price needs (at most 6). */
export function priceUsd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}
