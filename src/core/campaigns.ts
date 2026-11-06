import { randomUUID } from 'crypto';
import { BillingError } from './billing';
import type { D1Database } from './d1-stores';
import { costUsd, type Price } from './issued-keys';
import { pixelsOf, type MediaModel } from './media-catalog';

/**
 * Promotions ("we also sometimes offer promotion price, that will be created in admin campaign"; "both, automatic and
 * promo code": Steve, 2026-11-06). A campaign, made on the admin host (adm), sells some models below their official
 * price for a time:
 *
 * - type "automatic": every workspace pays the promo price inside the window; "code": only workspaces that redeemed
 *   its code on dash Billing (optionally at most maxRedemptions workspaces).
 * - discount: a percentage off the official price (basis points, 2500 = 25%), or a fixed promo price per model (per
 *   1M input/output tokens for chat, per image, per 1M video tokens). A promo price is never above the official one.
 * - Money: the official cost of a request is worked out as today (integer micro-dollars), the promo cost from it, and
 *   the balance is charged the promo cost; the difference is recorded as its own "Promotion" spend line, exactly
 *   official minus promo, so neither is ever hidden. Free tokens are used first, as without a campaign.
 *
 * Storage: worker/migrations/0006_campaigns.sql.
 */

export type CampaignType = 'automatic' | 'code';
export type CampaignStatus = 'active' | 'paused';

/** A fixed promo price for one model, in US dollars: chat per 1M tokens, image per image, video per 1M video tokens. */
export type PromoPrice = { input?: number; output?: number; perImage?: number; perMVideoTokens?: number };

export type Discount =
  | { kind: 'percent'; percentBp: number }
  | { kind: 'price'; prices: Record<string, PromoPrice> };

export type Campaign = {
  id: string;
  name: string;
  type: CampaignType;
  /** The promo code (upper case), for type "code"; null for "automatic". */
  code: string | null;
  status: CampaignStatus;
  /** UTC, milliseconds; the campaign applies while startsAt <= now < endsAt. */
  startsAt: number;
  endsAt: number;
  models: string[];
  discount: Discount;
  /** Type "code": at most this many workspaces may redeem it (null: no limit). */
  maxRedemptions: number | null;
  /** Type "code": a workspace entering the code again is told it already has it (on), or quietly OK (off). Never counted twice. */
  oncePerWorkspace: boolean;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  updatedBy: string;
  /** Workspaces that redeemed it (list views). */
  redemptions?: number;
};

/** What a model officially costs, in the units a campaign prices it in. */
export type OfficialPrice =
  | { kind: 'chat'; input: number; output: number; cachedInput?: number }
  | { kind: 'image'; perImage: number; perImageAbove?: { pixels: number; perImage: number } }
  | { kind: 'video'; perMTokens: number; perMTokens1080p?: number };

/**
 * One model a campaign may cover, for the admin page and the checks: `price` is what customers are charged without
 * a campaign (the official price, or one set by hand on Offered models); `cost` is the provider's official price,
 * what Valefront pays. A promo price below `cost` sells at a loss: the admin page warns before saving.
 */
export type CatalogEntry = { id: string; name: string; provider: string; price: OfficialPrice; cost: OfficialPrice };

/** What a finished request was, for working out its promo cost. */
export type ChargeBasis =
  | { kind: 'chat'; price: Price; usage: { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number; cache_creation_input_tokens?: number } }
  | { kind: 'image'; model: MediaModel; count: number; size?: string }
  | { kind: 'video'; model: MediaModel; tokens: number; resolution?: string };

/** US dollars -> micro-dollars, rounded up (float noise below a thousandth of a micro-dollar is dropped first). */
export function toMicros(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.ceil(Math.round(usd * 1e9) / 1000);
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function covers(c: Pick<Campaign, 'models'>, model: string): boolean {
  return c.models.some((m) => same(m, model));
}

function promoPriceFor(c: Pick<Campaign, 'discount'>, model: string): PromoPrice | undefined {
  if (c.discount.kind !== 'price') return undefined;
  const prices = c.discount.prices;
  return prices[model] ?? Object.entries(prices).find(([m]) => same(m, model))?.[1];
}

/** True while a campaign applies (active, and startsAt <= now < endsAt). */
export function isLive(c: Pick<Campaign, 'status' | 'startsAt' | 'endsAt'>, now: number): boolean {
  return c.status === 'active' && c.startsAt <= now && now < c.endsAt;
}

/**
 * A campaign's price for one model in the catalog's units; null when it doesn't cover the model. Never above the
 * official price (a percentage is rounded to the micro-dollar).
 */
export function promoPriceOf(c: Pick<Campaign, 'models' | 'discount'>, model: string, official: OfficialPrice): OfficialPrice | null {
  if (!covers(c, model)) return null;
  if (c.discount.kind === 'percent') {
    const bp = c.discount.percentBp;
    const f = (n: number) => round6(n - (n * bp) / 10_000);
    if (official.kind === 'chat') return { kind: 'chat', input: f(official.input), output: f(official.output), ...(official.cachedInput !== undefined ? { cachedInput: f(official.cachedInput) } : {}) };
    if (official.kind === 'image') return { kind: 'image', perImage: f(official.perImage), ...(official.perImageAbove ? { perImageAbove: { pixels: official.perImageAbove.pixels, perImage: f(official.perImageAbove.perImage) } } : {}) };
    return { kind: 'video', perMTokens: f(official.perMTokens), ...(official.perMTokens1080p !== undefined ? { perMTokens1080p: f(official.perMTokens1080p) } : {}) };
  }
  const p = promoPriceFor(c, model);
  if (!p) return null;
  if (official.kind === 'chat') {
    if (p.input === undefined && p.output === undefined) return null;
    const input = Math.min(p.input ?? official.input, official.input);
    const ratio = official.input > 0 ? input / official.input : 1;
    return { kind: 'chat', input, output: Math.min(p.output ?? official.output, official.output), ...(official.cachedInput !== undefined ? { cachedInput: round6(official.cachedInput * ratio) } : {}) };
  }
  if (official.kind === 'image') {
    if (p.perImage === undefined) return null;
    return { kind: 'image', perImage: Math.min(p.perImage, official.perImage), ...(official.perImageAbove ? { perImageAbove: { pixels: official.perImageAbove.pixels, perImage: Math.min(p.perImage, official.perImageAbove.perImage) } } : {}) };
  }
  if (p.perMVideoTokens === undefined) return null;
  return { kind: 'video', perMTokens: Math.min(p.perMVideoTokens, official.perMTokens), ...(official.perMTokens1080p !== undefined ? { perMTokens1080p: Math.min(p.perMVideoTokens, official.perMTokens1080p) } : {}) };
}

/**
 * What a request costs under a campaign, in micro-dollars: never more than officialMicros (the request's official
 * cost, already only its payable part when free tokens covered the rest; `payable` is that part, 0..1). Null: the
 * campaign doesn't cover this model or this kind of request.
 */
export function promoMicros(c: Pick<Campaign, 'models' | 'discount'>, model: string, basis: ChargeBasis, officialMicros: number, payable = 1): number | null {
  if (!covers(c, model) || officialMicros <= 0) return null;
  if (c.discount.kind === 'percent') {
    return officialMicros - Math.floor((officialMicros * c.discount.percentBp) / 10_000);
  }
  const p = promoPriceFor(c, model);
  if (!p) return null;
  let usd: number;
  if (basis.kind === 'chat') {
    if (p.input === undefined && p.output === undefined) return null;
    const off = basis.price;
    const input = Math.min(p.input ?? off.input, off.input);
    // Cached and cache-write input follow the input price down in proportion.
    const ratio = off.input > 0 ? input / off.input : 1;
    const promo: Price = {
      input,
      output: Math.min(p.output ?? off.output, off.output),
      cachedInput: (off.cachedInput ?? off.input * 0.1) * ratio,
      cacheCreationInput: (off.cacheCreationInput ?? off.input * 1.25) * ratio,
    };
    usd = costUsd(promo, basis.usage);
  } else if (basis.kind === 'image') {
    if (p.perImage === undefined || !basis.model.image) return null;
    const img = basis.model.image;
    const px = pixelsOf(basis.size);
    const each = img.above && px !== undefined && px > img.above.pixels ? img.above.perImageUsd : img.perImageUsd;
    usd = Math.min(p.perImage, each) * Math.max(0, Math.floor(basis.count));
  } else {
    if (p.perMVideoTokens === undefined || !basis.model.video) return null;
    const v = basis.model.video;
    const rate = basis.resolution === '1080p' && v.perMTokensUsd1080p !== undefined ? v.perMTokensUsd1080p : v.perMTokensUsd;
    usd = (Math.max(0, basis.tokens) * Math.min(p.perMVideoTokens, rate)) / 1_000_000;
  }
  return Math.min(officialMicros, toMicros(usd * payable));
}

/** The campaign giving the lowest price for this request, and that price; null when none covers it. */
export function bestCampaign(campaigns: Campaign[], model: string, basis: ChargeBasis, officialMicros: number, payable = 1): { campaign: Campaign; micros: number } | null {
  let best: { campaign: Campaign; micros: number } | null = null;
  const ordered = [...campaigns].sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id));
  for (const c of ordered) {
    const micros = promoMicros(c, model, basis, officialMicros, payable);
    if (micros !== null && micros < officialMicros && (!best || micros < best.micros)) best = { campaign: c, micros };
  }
  return best;
}

// ── checks ────────────────────────────────────────────────────────────────────────────────────────────────

export type BelowCost = { model: string; field: string; promo: number; cost: number };

function fields(p: OfficialPrice): Array<[string, number]> {
  if (p.kind === 'chat') return [['input per 1M tokens', p.input], ['output per 1M tokens', p.output]];
  if (p.kind === 'image') return [['per image', p.perImage], ...(p.perImageAbove ? [[`per image above ${p.perImageAbove.pixels.toLocaleString('en-US')} pixels`, p.perImageAbove.perImage] as [string, number]] : [])];
  return [['per 1M video tokens', p.perMTokens], ...(p.perMTokens1080p !== undefined ? [['per 1M video tokens at 1080p', p.perMTokens1080p] as [string, number]] : [])];
}

/**
 * Where a campaign would sell below what Valefront pays (the provider's official price): every model and price it
 * covers whose promo price, worked out from what customers are charged now, is below that cost.
 */
export function belowCost(c: Pick<Campaign, 'models' | 'discount'>, catalog: CatalogEntry[]): BelowCost[] {
  const out: BelowCost[] = [];
  for (const model of c.models) {
    const entry = catalog.find((e) => same(e.id, model));
    if (!entry) continue;
    const promo = promoPriceOf(c, entry.id, entry.price);
    if (!promo || promo.kind !== entry.cost.kind) continue;
    const costs = fields(entry.cost);
    fields(promo).forEach(([field, value], i) => {
      const cost = costs[i]?.[1];
      if (cost !== undefined && value < cost - 1e-9) out.push({ model: entry.id, field, promo: value, cost });
    });
  }
  return out;
}

export type CampaignInput = Pick<Campaign, 'name' | 'type' | 'code' | 'status' | 'startsAt' | 'endsAt' | 'models' | 'discount' | 'maxRedemptions' | 'oncePerWorkspace'>;

const CODE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

function time(v: unknown, what: string): number {
  const t = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v.trim()) ? v.trim() : `${v.trim()}Z`) : NaN;
  if (!Number.isFinite(t)) throw new BillingError('invalid_campaign', `${what} must be a date and time (UTC).`);
  return t;
}

function money(v: unknown, what: string): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new BillingError('invalid_campaign', `${what} must be a price of 0 or more (US dollars).`);
  return round6(n);
}

/** A campaign as sent by the admin page, checked against the models that can be on promotion. */
export function cleanCampaign(input: unknown, catalog: CatalogEntry[]): CampaignInput {
  const b = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const name = String(b.name ?? '').trim().slice(0, 120);
  if (!name) throw new BillingError('invalid_campaign', 'Give the campaign a name.');
  const type: CampaignType = b.type === 'code' ? 'code' : b.type === 'automatic' ? 'automatic' : (() => { throw new BillingError('invalid_campaign', 'Type must be "automatic" or "code".'); })();
  const status: CampaignStatus = b.status === 'paused' ? 'paused' : 'active';
  const startsAt = time(b.startsAt, 'Start');
  const endsAt = time(b.endsAt, 'End');
  if (endsAt <= startsAt) throw new BillingError('invalid_campaign', 'The end must be after the start.');
  let code: string | null = null;
  let maxRedemptions: number | null = null;
  if (type === 'code') {
    code = String(b.code ?? '').trim().toUpperCase();
    if (!CODE.test(code)) throw new BillingError('invalid_campaign', 'A promo code is 3 to 32 letters, digits, "-" or "_".');
    if (b.maxRedemptions !== undefined && b.maxRedemptions !== null && b.maxRedemptions !== '') {
      const n = Number(b.maxRedemptions);
      if (!Number.isInteger(n) || n < 1) throw new BillingError('invalid_campaign', 'Max redemptions must be a whole number of 1 or more (or empty: no limit).');
      maxRedemptions = n;
    }
  }
  const oncePerWorkspace = type === 'code' ? b.oncePerWorkspace !== false : true;
  const entry = (id: string) => {
    const e = catalog.find((x) => same(x.id, id));
    if (!e) throw new BillingError('invalid_campaign', `"${id}" is not a model that can be on promotion (it has no official price here).`);
    return e;
  };
  const d = (b.discount && typeof b.discount === 'object' ? b.discount : {}) as Record<string, unknown>;
  let discount: Discount;
  let models: string[];
  if (d.kind === 'percent') {
    const percent = Number(d.percent ?? (d.percentBp !== undefined ? Number(d.percentBp) / 100 : NaN));
    const bp = Math.round(percent * 100);
    if (!Number.isFinite(percent) || bp < 1 || bp > 10_000 || Math.abs(percent * 100 - bp) > 1e-6) throw new BillingError('invalid_campaign', 'The discount must be 0.01% to 100% (at most two decimals).');
    discount = { kind: 'percent', percentBp: bp };
    models = [...new Set((Array.isArray(b.models) ? b.models : []).map((m) => entry(String(m).trim()).id))];
  } else if (d.kind === 'price') {
    const raw = (d.prices && typeof d.prices === 'object' ? d.prices : {}) as Record<string, unknown>;
    const prices: Record<string, PromoPrice> = {};
    for (const [id, value] of Object.entries(raw)) {
      const e = entry(id.trim());
      const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
      let p: PromoPrice;
      if (e.price.kind === 'chat') {
        p = { input: money(v.input, `${e.id} input`), output: money(v.output, `${e.id} output`) };
        if (p.input === undefined && p.output === undefined) throw new BillingError('invalid_campaign', `Give ${e.id} a promo input or output price (per 1M tokens).`);
        if ((p.input ?? 0) > e.price.input || (p.output ?? 0) > e.price.output) throw new BillingError('invalid_campaign', `${e.id}: a promo price can't be above the official price ($${e.price.input} input, $${e.price.output} output per 1M tokens).`);
        if (p.input === undefined) delete p.input;
        if (p.output === undefined) delete p.output;
      } else if (e.price.kind === 'image') {
        const perImage = money(v.perImage, `${e.id} per image`);
        if (perImage === undefined) throw new BillingError('invalid_campaign', `Give ${e.id} a promo price per image.`);
        if (perImage > e.price.perImage) throw new BillingError('invalid_campaign', `${e.id}: a promo price can't be above the official $${e.price.perImage} per image.`);
        p = { perImage };
      } else {
        const perMVideoTokens = money(v.perMVideoTokens, `${e.id} per 1M video tokens`);
        if (perMVideoTokens === undefined) throw new BillingError('invalid_campaign', `Give ${e.id} a promo price per 1M video tokens.`);
        if (perMVideoTokens > e.price.perMTokens) throw new BillingError('invalid_campaign', `${e.id}: a promo price can't be above the official $${e.price.perMTokens} per 1M video tokens.`);
        p = { perMVideoTokens };
      }
      prices[e.id] = p;
    }
    discount = { kind: 'price', prices };
    models = Object.keys(prices);
  } else {
    throw new BillingError('invalid_campaign', 'The discount is a percentage off ({"kind":"percent","percent":20}) or promo prices ({"kind":"price","prices":{...}}).');
  }
  if (!models.length) throw new BillingError('invalid_campaign', 'Pick at least one model.');
  return { name, type, code, status, startsAt, endsAt, models, discount, maxRedemptions, oncePerWorkspace };
}

// ── storage ───────────────────────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function campaignFrom(r: Row): Campaign {
  return {
    id: String(r.id), name: String(r.name), type: r.type === 'code' ? 'code' : 'automatic', code: r.code === null || r.code === undefined ? null : String(r.code),
    status: r.status === 'paused' ? 'paused' : 'active', startsAt: Number(r.starts_at), endsAt: Number(r.ends_at),
    models: JSON.parse(String(r.models)) as string[], discount: JSON.parse(String(r.discount)) as Discount,
    maxRedemptions: r.max_redemptions === null || r.max_redemptions === undefined ? null : Number(r.max_redemptions),
    oncePerWorkspace: Number(r.once_per_workspace) === 1,
    createdAt: Number(r.created_at), createdBy: String(r.created_by), updatedAt: Number(r.updated_at), updatedBy: String(r.updated_by),
    ...(r.redemptions !== undefined ? { redemptions: Number(r.redemptions) } : {}),
  };
}

export type RedeemOutcome = 'redeemed' | 'already' | 'not_found' | 'ended' | 'full';

/** Campaigns and redemptions in D1 (worker/migrations/0006_campaigns.sql). */
export class D1CampaignStore {
  constructor(private readonly db: D1Database, private readonly now: () => number = Date.now) {}

  private async all(sql: string, ...args: unknown[]): Promise<Campaign[]> {
    return ((await this.db.prepare(sql).bind(...args).all<Row>()).results ?? []).map(campaignFrom);
  }

  /** Every campaign, newest start first, with its redemption count. */
  async list(): Promise<Campaign[]> {
    return this.all('SELECT c.*, (SELECT COUNT(*) FROM campaign_redemptions r WHERE r.campaign_id = c.id) AS redemptions FROM campaigns c ORDER BY c.starts_at DESC, c.id');
  }

  async get(id: string): Promise<Campaign | null> {
    return (await this.all('SELECT c.*, (SELECT COUNT(*) FROM campaign_redemptions r WHERE r.campaign_id = c.id) AS redemptions FROM campaigns c WHERE c.id = ?', id))[0] ?? null;
  }

  async byCode(code: string): Promise<Campaign | null> {
    return (await this.all('SELECT * FROM campaigns WHERE code = ?', code.trim().toUpperCase()))[0] ?? null;
  }

  async create(input: CampaignInput, by: string): Promise<Campaign> {
    const at = this.now();
    const id = `cmp_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    try {
      await this.db.prepare(`INSERT INTO campaigns (id, name, type, code, status, starts_at, ends_at, models, discount, max_redemptions, once_per_workspace, created_at, created_by, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, input.name, input.type, input.code, input.status, input.startsAt, input.endsAt, JSON.stringify(input.models), JSON.stringify(input.discount), input.maxRedemptions, input.oncePerWorkspace ? 1 : 0, at, by, at, by).run();
    } catch (err) {
      if (/UNIQUE/i.test(String(err))) throw new BillingError('code_taken', `Another campaign already uses the code ${input.code}.`, 409);
      throw err;
    }
    return (await this.get(id))!;
  }

  async update(id: string, input: CampaignInput, by: string): Promise<Campaign> {
    try {
      const r = await this.db.prepare(`UPDATE campaigns SET name = ?, type = ?, code = ?, status = ?, starts_at = ?, ends_at = ?, models = ?, discount = ?, max_redemptions = ?, once_per_workspace = ?, updated_at = ?, updated_by = ? WHERE id = ?`)
        .bind(input.name, input.type, input.code, input.status, input.startsAt, input.endsAt, JSON.stringify(input.models), JSON.stringify(input.discount), input.maxRedemptions, input.oncePerWorkspace ? 1 : 0, this.now(), by, id).run();
      if (!r.meta.changes) throw new BillingError('not_found', 'Campaign not found.', 404);
    } catch (err) {
      if (/UNIQUE/i.test(String(err))) throw new BillingError('code_taken', `Another campaign already uses the code ${input.code}.`, 409);
      throw err;
    }
    return (await this.get(id))!;
  }

  async setStatus(id: string, status: CampaignStatus, by: string): Promise<Campaign | null> {
    await this.db.prepare('UPDATE campaigns SET status = ?, updated_at = ?, updated_by = ? WHERE id = ?').bind(status, this.now(), by, id).run();
    return this.get(id);
  }

  /** Campaigns a workspace pays promo prices under right now: live automatic ones, and live ones it redeemed. */
  async applicable(workspaceId: string, now = this.now()): Promise<Campaign[]> {
    return this.all(`SELECT c.* FROM campaigns c WHERE c.status = 'active' AND c.starts_at <= ? AND c.ends_at > ?
      AND (c.type = 'automatic' OR EXISTS (SELECT 1 FROM campaign_redemptions r WHERE r.campaign_id = c.id AND r.workspace_id = ?))`, now, now, workspaceId);
  }

  /** Live automatic campaigns (what /v1/pricing publishes). */
  async liveAutomatic(now = this.now()): Promise<Campaign[]> {
    return this.all("SELECT * FROM campaigns WHERE status = 'active' AND type = 'automatic' AND starts_at <= ? AND ends_at > ? ORDER BY ends_at, id", now, now);
  }

  /** Promo-code campaigns a workspace redeemed that haven't ended (dash Billing). */
  async redeemedBy(workspaceId: string, now = this.now()): Promise<Campaign[]> {
    return this.all(`SELECT c.* FROM campaigns c JOIN campaign_redemptions r ON r.campaign_id = c.id WHERE r.workspace_id = ? AND c.ends_at > ? ORDER BY c.ends_at, c.id`, workspaceId, now);
  }

  /**
   * Redeem a code for a workspace: one row per campaign and workspace, and no more rows than maxRedemptions; both
   * checked by the one INSERT, so two workspaces racing for the last redemption can't both get it.
   */
  async redeem(code: string, workspaceId: string, now = this.now()): Promise<{ outcome: RedeemOutcome; campaign: Campaign | null }> {
    const campaign = await this.byCode(code);
    if (!campaign || campaign.type !== 'code' || campaign.status !== 'active') return { outcome: 'not_found', campaign: null };
    if (now >= campaign.endsAt) return { outcome: 'ended', campaign };
    const r = await this.db.prepare(`INSERT OR IGNORE INTO campaign_redemptions (id, campaign_id, workspace_id, redeemed_at)
      SELECT ?, c.id, ?, ? FROM campaigns c WHERE c.id = ?
        AND (c.max_redemptions IS NULL OR (SELECT COUNT(*) FROM campaign_redemptions r WHERE r.campaign_id = c.id) < c.max_redemptions)`)
      .bind(`red_${randomUUID()}`, workspaceId, now, campaign.id).run();
    if (r.meta.changes) return { outcome: 'redeemed', campaign };
    const had = await this.db.prepare('SELECT 1 AS x FROM campaign_redemptions WHERE campaign_id = ? AND workspace_id = ?').bind(campaign.id, workspaceId).first();
    return { outcome: had ? 'already' : 'full', campaign };
  }

  /** Codes this workspace got wrong since `since` (to slow down guessing). */
  async rejectedSince(workspaceId: string, since: number): Promise<number> {
    const r = await this.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id = ? AND type = 'promo_code.rejected' AND at >= ?").bind(workspaceId, since).first<{ n: number }>();
    return Number(r?.n ?? 0);
  }
}

/** A campaign as customers see it (no internal fields). */
export function publicCampaign(c: Campaign) {
  return { id: c.id, name: c.name, type: c.type, ...(c.code ? { code: c.code } : {}), starts_at: new Date(c.startsAt).toISOString(), ends_at: new Date(c.endsAt).toISOString(), models: c.models, discount: c.discount.kind === 'percent' ? { kind: 'percent', percent: c.discount.percentBp / 100 } : c.discount };
}
