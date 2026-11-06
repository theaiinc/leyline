import type { Express, Request, RequestHandler, Response } from 'express';
import { BillingError } from './billing';
import { belowCost, cleanCampaign, promoPriceOf, type Campaign, type CatalogEntry, type D1CampaignStore, type OfficialPrice } from './campaigns';
import { realPrice, type HostedOptions } from './hosted';
import { MEDIA_MODELS, isCampaignMediaModel, isMediaModel, isSoldMediaModel, type MediaModel } from './media-catalog';
import { PUBLIC_SALE_MODEL_IDS, builtinPrice } from './pricing';
import type { Price } from './issued-keys';

/**
 * The admin host's Campaigns page API (adm only: `guard` is the owner dashboard's admin check, which on the hosted
 * Worker passes only Cloudflare Access on adm, or the admin token):
 *
 *   GET  /admin/api/campaigns              campaigns, and the models that can be on promotion with price and cost
 *   POST /admin/api/campaigns/check        { warnings } for a campaign as it would be saved (below-cost check)
 *   POST /admin/api/campaigns              create; refused with 409 below_cost (and the warnings) unless
 *                                          acknowledgeBelowCost: true, when the promo price is below Valefront's cost
 *   PUT  /admin/api/campaigns/:id          edit (same check)
 *   POST /admin/api/campaigns/:id/status   { status: "active" | "paused" }
 */

const chat = (p: Price): OfficialPrice => ({ kind: 'chat', input: p.input, output: p.output, ...(p.cachedInput !== undefined ? { cachedInput: p.cachedInput } : {}) });

export function mediaOfficial(m: MediaModel): OfficialPrice {
  if (m.image) return { kind: 'image', perImage: m.image.perImageUsd, ...(m.image.above ? { perImageAbove: { pixels: m.image.above.pixels, perImage: m.image.above.perImageUsd } } : {}) };
  return { kind: 'video', perMTokens: m.video!.perMTokensUsd, ...(m.video!.perMTokensUsd1080p !== undefined ? { perMTokens1080p: m.video!.perMTokensUsd1080p } : {}) };
}

/**
 * Models a campaign can cover: offered chat models with a real price (what customers are charged; the cost is the
 * provider's published price, what Valefront pays, or the charged price when the provider publishes none), and the
 * media models Valefront sells (BytePlus; their official price is both).
 */
export function campaignCatalog(opts: HostedOptions): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  const ids = [...new Set([...opts.models.filter((m) => !m.includes('*')), ...PUBLIC_SALE_MODEL_IDS])].filter((id) => !isMediaModel(id));
  for (const id of ids) {
    const price = realPrice(opts, id, 'BytePlus');
    if (!price) continue;
    const byteplus = opts.publishedPrice?.('BytePlus', id);
    const cost = byteplus ?? opts.anyPublishedPrice?.(id) ?? builtinPrice(id) ?? price;
    out.push({ id, name: id, provider: byteplus ? 'BytePlus' : '', price: chat(price), cost: chat(cost) });
  }
  for (const m of MEDIA_MODELS.filter((x) => isSoldMediaModel(x.id) && isCampaignMediaModel(x))) {
    out.push({ id: m.id, name: m.name, provider: m.provider, price: mediaOfficial(m), cost: mediaOfficial(m) });
  }
  return out;
}

export function mountAdminCampaigns(app: Express, opts: HostedOptions, guard: RequestHandler): void {
  const store = (): D1CampaignStore => {
    const s = opts.billing?.opts.campaigns;
    if (!s) throw new BillingError('campaigns_unavailable', 'Campaigns need billing (D1) on this server.', 503);
    return s;
  };
  const who = (req: Request) => (req as Request & { admin?: string }).admin ?? 'admin';
  const fail = (res: Response, err: unknown) => {
    if (err instanceof BillingError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error('[admin-campaigns]', err);
    return res.status(500).json({ error: 'Failed; see the Worker logs.' });
  };
  const withPrices = (c: Campaign, catalog: CatalogEntry[]) => ({
    ...c,
    prices: c.models.map((id) => {
      const e = catalog.find((x) => x.id.toLowerCase() === id.toLowerCase());
      return e ? { id: e.id, name: e.name, official: e.price, promo: promoPriceOf(c, e.id, e.price) } : { id, name: id, official: null, promo: null };
    }),
  });

  app.get('/admin/api/campaigns', guard, async (_req, res) => {
    try {
      const catalog = campaignCatalog(opts);
      res.json({ campaigns: (await store().list()).map((c) => withPrices(c, catalog)), catalog, now: opts.billing?.opts.now?.() ?? Date.now() });
    } catch (err) {
      fail(res, err);
    }
  });
  app.post('/admin/api/campaigns/check', guard, async (req, res) => {
    try {
      const catalog = campaignCatalog(opts);
      const input = cleanCampaign(req.body, catalog);
      res.json({ warnings: belowCost(input, catalog) });
    } catch (err) {
      fail(res, err);
    }
  });
  const save = (id: string | null) => async (req: Request, res: Response) => {
    try {
      const catalog = campaignCatalog(opts);
      const input = cleanCampaign(req.body, catalog);
      const warnings = belowCost(input, catalog);
      if (warnings.length && req.body?.acknowledgeBelowCost !== true) {
        return res.status(409).json({ error: 'This campaign sells below what Valefront pays the provider. Confirm to save it anyway.', code: 'below_cost', warnings });
      }
      const saved = id ? await store().update(id, input, who(req)) : await store().create(input, who(req));
      console.log(JSON.stringify({ event: id ? 'campaign_updated' : 'campaign_created', id: saved.id, by: who(req), type: saved.type, status: saved.status, models: saved.models, belowCost: warnings.length }));
      res.status(id ? 200 : 201).json({ campaign: withPrices(saved, catalog), warnings });
    } catch (err) {
      fail(res, err);
    }
  };
  app.post('/admin/api/campaigns', guard, save(null));
  app.put('/admin/api/campaigns/:id', guard, (req, res) => save(String(req.params.id))(req, res));
  app.post('/admin/api/campaigns/:id/status', guard, async (req, res) => {
    try {
      const status = req.body?.status;
      if (status !== 'active' && status !== 'paused') throw new BillingError('invalid_status', 'Status must be "active" or "paused".');
      const saved = await store().setStatus(String(req.params.id), status, who(req));
      if (!saved) throw new BillingError('not_found', 'Campaign not found.', 404);
      console.log(JSON.stringify({ event: 'campaign_status', id: saved.id, status, by: who(req) }));
      res.json({ campaign: withPrices(saved, campaignCatalog(opts)) });
    } catch (err) {
      fail(res, err);
    }
  });
}

/**
 * /v1/pricing's promotions: each live automatic campaign, and on every model it covers the official price, the
 * promo price and when it ends (the lowest promo price when several cover one model).
 */
export async function pricingPromotions(
  campaigns: D1CampaignStore | null | undefined,
  now: number,
  models: Array<{ id: string; input: number; output: number; cached_input?: number }>,
  media: MediaModel[],
): Promise<{ list: unknown[]; byModel: Map<string, Record<string, unknown>> }> {
  const byModel = new Map<string, Record<string, unknown>>();
  if (!campaigns) return { list: [], byModel };
  const live = await campaigns.liveAutomatic(now);
  const official = new Map<string, OfficialPrice>([
    ...models.map((m) => [m.id, { kind: 'chat', input: m.input, output: m.output, ...(m.cached_input !== undefined ? { cachedInput: m.cached_input } : {}) }] as [string, OfficialPrice]),
    ...media.filter(isCampaignMediaModel).map((m) => [m.id, mediaOfficial(m)] as [string, OfficialPrice]),
  ]);
  const rank = new Map<string, number>();
  const headline = (p: OfficialPrice) => (p.kind === 'chat' ? p.input + p.output : p.kind === 'image' ? p.perImage : p.perMTokens);
  const list = live.map((c) => {
    const covered: Array<Record<string, unknown>> = [];
    for (const [id, off] of official) {
      const promo = promoPriceOf(c, id, off);
      if (!promo) continue;
      const entry = { campaign_id: c.id, name: c.name, ends_at: new Date(c.endsAt).toISOString(), ...priceFields(promo) };
      covered.push({ id, official: priceFields(off), promo: priceFields(promo) });
      if (headline(promo) < (rank.get(id) ?? Infinity)) { byModel.set(id, entry); rank.set(id, headline(promo)); }
    }
    return {
      id: c.id, name: c.name, starts_at: new Date(c.startsAt).toISOString(), ends_at: new Date(c.endsAt).toISOString(),
      discount: c.discount.kind === 'percent' ? { kind: 'percent', percent: c.discount.percentBp / 100 } : { kind: 'price' },
      models: covered,
    };
  });
  return { list, byModel };
}

/** A price in /v1/pricing's field names. */
function priceFields(p: OfficialPrice): Record<string, unknown> {
  if (p.kind === 'chat') return { input: p.input, output: p.output, ...(p.cachedInput !== undefined ? { cached_input: p.cachedInput } : {}) };
  if (p.kind === 'image') return { per_image: p.perImage, ...(p.perImageAbove ? { per_image_above_pixels: { pixels: p.perImageAbove.pixels, per_image: p.perImageAbove.perImage } } : {}) };
  return { per_1m_video_tokens: p.perMTokens, ...(p.perMTokens1080p !== undefined ? { per_1m_video_tokens_1080p: p.perMTokens1080p } : {}) };
}
