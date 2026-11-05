/**
 * The day's USD -> VND rate, one source for everything that shows or charges VND: /v1/pricing publishes it (prices
 * shown to customers in Vietnam are listed in VND, Vietnamese law), and SePay bank-QR orders are quoted with it.
 *
 * Vietcombank's published USD selling rate, refreshed every few hours (its feed allows one request per 5 minutes); a
 * reference rate (open.er-api.com) only if that fails. Kept per isolate: pricing and billing in the same Worker read
 * the same cached value.
 */
export type VndRate = { vnd_per_usd: number; date: string; source: 'vietcombank' | 'reference' };

const REFRESH_MS = 3 * 3600_000;
let dailyFx: { vndPerUsd: number; date: string; source: VndRate['source']; at: number } | undefined;

export async function vndRate(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<VndRate | null> {
  if (!dailyFx || Date.now() - dailyFx.at > REFRESH_MS) {
    try {
      const xml = await (await fetchImpl('https://portal.vietcombank.com.vn/Usercontrols/TVPortal.TyGia/pXML.aspx', { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'Valefront pricing' } })).text();
      const sell = Number(/<Exrate CurrencyCode="USD"[^>]*Sell="([\d,.]+)"/.exec(xml)?.[1]?.replace(/,/g, ''));
      const when = /<DateTime>(\d+)\/(\d+)\/(\d{4})/.exec(xml);
      if (sell > 1000) dailyFx = { vndPerUsd: Math.round(sell), date: when ? `${when[3]}-${when[1]!.padStart(2, '0')}-${when[2]!.padStart(2, '0')}` : new Date().toISOString().slice(0, 10), source: 'vietcombank', at: Date.now() };
    } catch { /* fall back below */ }
    if (!dailyFx || Date.now() - dailyFx.at > REFRESH_MS) {
      try {
        const d = await (await fetchImpl('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(5000) })).json() as { rates?: Record<string, number>; time_last_update_unix?: number };
        const v = Number(d.rates?.VND);
        if (v > 1000) dailyFx = { vndPerUsd: Math.round(v), date: new Date((d.time_last_update_unix ?? Date.now() / 1000) * 1000).toISOString().slice(0, 10), source: 'reference', at: Date.now() };
      } catch { /* keep the last good one */ }
    }
  }
  return dailyFx ? { vnd_per_usd: dailyFx.vndPerUsd, date: dailyFx.date, source: dailyFx.source } : null;
}

/** Tests: forget the cached rate. */
export function resetVndRateCache(): void {
  dailyFx = undefined;
}
