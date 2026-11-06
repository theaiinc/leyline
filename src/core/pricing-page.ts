/**
 * /v1/pricing opened in a browser: the same data as the JSON, as a readable page in Valefront's colours (Steve,
 * 2026-11-06). API clients keep getting JSON (they don't ask for text/html first); `?format=json` forces JSON.
 */

type Row = Record<string, unknown>;
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const usd = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? `$${n < 0.01 ? n.toFixed(4) : n < 1 ? n.toFixed(3) : n.toFixed(2)}` : '—');
const num = (n: unknown) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');

/** A browser asked for a page (text/html before JSON), and nobody forced JSON. */
export function wantsPricingPage(accept: string | undefined, format: unknown): boolean {
  if (format === 'json') return false;
  if (format === 'html') return true;
  const a = (accept ?? '').toLowerCase();
  const html = a.indexOf('text/html');
  if (html < 0) return false;
  const json = a.indexOf('application/json');
  return json < 0 || html < json;
}

export function renderPricingPage(p: Row): string {
  const models = (Array.isArray(p.models) ? p.models : []) as Row[];
  const media = (Array.isArray(p.media) ? p.media : []) as Row[];
  const addons = (Array.isArray(p.addons) ? p.addons : []) as Row[];
  const promos = (Array.isArray(p.promotions) ? p.promotions : []) as Row[];
  const free = (p.free_tier ?? {}) as Row;
  const fx = (p.exchange_rate ?? null) as Row | null;
  const promoOf = (m: Row) => (m.promotion && typeof m.promotion === 'object' ? (m.promotion as Row) : null);
  const priceCell = (official: unknown, promo: unknown) =>
    promo !== undefined && promo !== null && promo !== official ? `<s>${usd(official)}</s> <b class="promo">${usd(promo)}</b>` : usd(official);

  // Prompt-length tiers and peak-hour prices (BytePlus), under the model: the row's prices are the base (or off-peak) ones.
  const priceNote = (m: Row) => {
    const tiers = (Array.isArray(m.prompt_tiers) ? m.prompt_tiers : []) as Row[];
    const notes = tiers.map((t) => `Prompts over ${num(t.above_tokens)} tokens: ${usd(t.input)} in, ${usd(t.output)} out${t.cached_input !== undefined ? `, ${usd(t.cached_input)} cached` : ''}`);
    const peak = m.peak && typeof m.peak === 'object' ? (m.peak as Row) : null;
    if (peak) notes.unshift(`Off-peak prices shown. Peak (${esc(peak.hours)}): ${usd(peak.input)} in, ${usd(peak.output)} out${peak.cached_input !== undefined ? `, ${usd(peak.cached_input)} cached` : ''}`);
    return notes.map((n) => `<br><small>${n}</small>`).join('');
  };
  const chatRows = models.map((m) => {
    const pr = promoOf(m);
    return `<tr><td><b>${esc(m.name)}</b><br><code>${esc(m.id)}</code>${m.free_tier ? ' <span class="pill">free tier</span>' : ''}${priceNote(m)}</td>
<td class="n">${priceCell(m.input, pr?.input)}</td><td class="n">${priceCell(m.output, pr?.output)}</td>
<td class="n">${m.cached_input !== undefined ? usd(m.cached_input) : '—'}</td><td>${esc(m.provider)}</td></tr>`;
  }).join('');
  const mediaRows = media.map((m) => {
    const pr = promoOf(m);
    const price = m.per_image !== undefined
      ? `${priceCell(m.per_image, pr?.per_image)} per image${m.per_image_above_pixels ? ` <small>(${usd((m.per_image_above_pixels as Row).per_image)} above ${num((m.per_image_above_pixels as Row).pixels)} px)</small>` : ''}`
      : m.per_1m_video_tokens !== undefined
        ? `${priceCell(m.per_1m_video_tokens, pr?.per_1m_video_tokens)} per 1M video tokens${m.per_1m_video_tokens_1080p !== undefined && m.per_1m_video_tokens_1080p !== m.per_1m_video_tokens ? ` <small>(${usd(m.per_1m_video_tokens_1080p)} at 1080p)</small>` : ''}`
        : esc(m.price ?? '—');
    const extra = m.durations ? `${esc((m.durations as Row).min)}–${esc((m.durations as Row).max)} s, up to ${esc(m.max_resolution)}` : '';
    return `<tr><td><b>${esc(m.name)}</b><br><code>${esc(m.id)}</code></td><td>${esc(m.kind)}</td><td>${price}</td><td>${extra}</td><td>${esc(m.provider)}</td></tr>`;
  }).join('');
  const addonRows = addons.map((a) => `<tr><td><b>${esc(a.name ?? a.id)}</b></td><td>${esc(a.description ?? '')}</td><td class="n">${typeof a.price === 'number' ? `${usd(a.price)} ${esc(a.unit ?? '')}` : esc(a.price ?? '')}</td></tr>`).join('');
  const promoRows = promos.map((c) => `<li><b>${esc(c.name)}</b>: ${c.discount && (c.discount as Row).kind === 'percent' ? `${esc((c.discount as Row).percent)}% off` : 'promo prices'} on ${esc(Array.isArray(c.models) ? (c.models as string[]).join(', ') : '')}, until ${esc(String(c.ends_at ?? '').slice(0, 10))}</li>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Valefront pricing</title><link rel="icon" href="https://valefront.com/favicon.ico">
<style>
:root{--bg:#f7f9fb;--fg:#14161b;--muted:#5c6470;--card:#fff;--border:#e3e7ee;--primary:#1f9d6b;--ring:#3f72e0;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#10151d;--fg:#f2f4f7;--muted:#9aa4b2;--card:#171e29;--border:#263142;--primary:#a9f5cf;--ring:#7aa6ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:center;gap:10px;padding:14px 24px;border-bottom:1px solid var(--border)}header a{color:var(--fg);text-decoration:none;font-weight:600}
header nav{margin-left:auto;display:flex;gap:14px}header nav a{color:var(--muted);font-weight:400}
main{max-width:1100px;margin:0 auto;padding:28px 24px 64px}h1{font-size:26px;margin:0 0 6px;letter-spacing:-.01em}h2{font-size:17px;margin:32px 0 10px}
p,small{color:var(--muted)}a{color:var(--ring)}code{font-size:12px;color:var(--muted)}
.wrap{overflow-x:auto}table{width:100%;border-collapse:separate;border-spacing:0;background:var(--card);border:1px solid var(--border);border-radius:12px}
th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600;text-align:left}td,th{padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:top}
tbody tr:last-child td{border-bottom:0}.n{text-align:right;white-space:nowrap}.pill{font-size:10px;font-weight:700;text-transform:uppercase;color:var(--primary);background:color-mix(in srgb,var(--primary) 16%,transparent);border-radius:999px;padding:1px 6px}
.promo{color:var(--primary)}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px}
.card b{display:block;font-size:20px}
</style></head><body>
<header><a href="https://valefront.com/">Valefront</a><nav><a href="https://valefront.com/pricing">Pricing page</a><a href="https://valefront.com/docs/models.html">Docs</a><a href="?format=json">Raw JSON</a></nav></header>
<main><h1>API pricing</h1>
<p>Each provider's official price, in ${esc(p.currency ?? 'USD')}, charged from prepaid credit. Chat prices are per 1M tokens. This is <code>GET /v1/pricing</code> shown for people; apps get the same data as JSON.</p>
<div class="cards">
<div class="card"><small>Free tokens at sign-up</small><b>${num(free.tokens)}</b><small>${free.bonus_tokens_on_first_top_up ? `+${num(free.bonus_tokens_on_first_top_up)} after your first top-up · ` : ''}${free.tokens_per_day ? `up to ${num(free.tokens_per_day)} a day · ` : ''}${free.expires_after_days ? `${esc(free.expires_after_days)} days` : ''}</small></div>
${fx ? `<div class="card"><small>VND rate (${esc(fx.source)}, ${esc(fx.date)})</small><b>${num(fx.vnd_per_usd)} ₫</b><small>per US dollar, for prices shown in Vietnam</small></div>` : ''}
</div>
${promoRows ? `<h2>Promotions</h2><ul>${promoRows}</ul>` : ''}
<h2>Chat models</h2><div class="wrap"><table><thead><tr><th>Model</th><th class="n">Input / 1M</th><th class="n">Output / 1M</th><th class="n">Cached input / 1M</th><th>Provider</th></tr></thead><tbody>${chatRows || '<tr><td colspan="5">None.</td></tr>'}</tbody></table></div>
${mediaRows ? `<h2>Images &amp; video</h2><div class="wrap"><table><thead><tr><th>Model</th><th>Kind</th><th>Price</th><th>Limits</th><th>Provider</th></tr></thead><tbody>${mediaRows}</tbody></table></div>` : ''}
${addonRows ? `<h2>Add-ons</h2><div class="wrap"><table><thead><tr><th>Add-on</th><th>What it does</th><th class="n">Price</th></tr></thead><tbody>${addonRows}</tbody></table></div>` : ''}
<p><small>Free tokens cover the free-tier model only; images, video and add-ons are paid from credit. <a href="https://valefront.com/docs/models.html">How pricing works</a>.</small></p>
</main></body></html>`;
}
