import request from 'supertest';
import { billingFixture, workspace } from './helpers/billing-fixture';
import { ORIGIN, cookieFor, hostedBilling } from './helpers/hosted-billing';
import { belowCost, bestCampaign, cleanCampaign, promoMicros, promoPriceOf, toMicros, type CampaignInput, type CatalogEntry, type ChargeBasis } from '../src/core/campaigns';
import { recordUsage } from '../src/core/hosted';
import { imageCostUsd, mediaModel, videoCostUsd } from '../src/core/media-catalog';
import { TERMS_VERSION } from '../src/core/self-serve-workspaces';
import type { Request } from 'express';

const NOW = Date.UTC(2026, 10, 7, 3); // the fixtures' clock
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ADM = 'adm.valefront.com';

const chatBasis = (input: number, output: number, prompt = 1000, completion = 1000): ChargeBasis => ({ kind: 'chat', price: { input, output }, usage: { prompt_tokens: prompt, completion_tokens: completion } });

function input(over: Partial<CampaignInput> = {}): CampaignInput {
  return {
    name: 'Launch week', type: 'automatic', code: null, status: 'active', startsAt: NOW - HOUR, endsAt: NOW + DAY,
    models: ['gpt-5.5'], discount: { kind: 'percent', percentBp: 2500 }, maxRedemptions: null, oncePerWorkspace: true, ...over,
  };
}

describe('promo arithmetic (micro-dollars)', () => {
  it('toMicros rounds up, ignoring float noise', () => {
    expect(toMicros(0.045)).toBe(45_000);
    expect(toMicros(0.1 + 0.2)).toBe(300_000);
    expect(toMicros(0.0000001)).toBe(1);
    expect(toMicros(0)).toBe(0);
    expect(toMicros(-1)).toBe(0);
  });

  it('a percentage takes floor(official x bp / 10000) off; a fixed price is the promo cost, never above official', () => {
    const pct = { models: ['m'], discount: { kind: 'percent' as const, percentBp: 2500 } };
    expect(promoMicros(pct, 'm', chatBasis(5, 15), 20_000)).toBe(15_000);
    expect(promoMicros(pct, 'M', chatBasis(5, 15), 3)).toBe(3); // floor(0.75) off = 0: never below what it costs by rounding
    expect(promoMicros(pct, 'other', chatBasis(5, 15), 20_000)).toBeNull();
    const fixed = { models: ['m'], discount: { kind: 'price' as const, prices: { m: { input: 1, output: 3 } } } };
    // 1000 x $1/M + 1000 x $3/M = $0.004.
    expect(promoMicros(fixed, 'm', chatBasis(5, 15), 20_000)).toBe(4_000);
    // Only output on promotion: input stays official.
    const outOnly = { models: ['m'], discount: { kind: 'price' as const, prices: { m: { output: 3 } } } };
    expect(promoMicros(outOnly, 'm', chatBasis(5, 15), 20_000)).toBe(8_000);
    // A promo price above the official one changes nothing.
    const dearer = { models: ['m'], discount: { kind: 'price' as const, prices: { m: { input: 50, output: 50 } } } };
    expect(promoMicros(dearer, 'm', chatBasis(5, 15), 20_000)).toBe(20_000);
  });

  it('free tokens: the promo applies to the payable part only', () => {
    const fixed = { models: ['m'], discount: { kind: 'price' as const, prices: { m: { input: 1, output: 3 } } } };
    // Half the request was free: official payable $0.01, promo payable $0.002.
    expect(promoMicros(fixed, 'm', chatBasis(5, 15), 10_000, 0.5)).toBe(2_000);
  });

  it('several campaigns: the lowest price wins', () => {
    const a = { ...input({ discount: { kind: 'percent', percentBp: 1000 } }), id: 'a', createdAt: 0, createdBy: '', updatedAt: 0, updatedBy: '' };
    const b = { ...input({ discount: { kind: 'percent', percentBp: 3000 } }), id: 'b', createdAt: 0, createdBy: '', updatedAt: 0, updatedBy: '' };
    expect(bestCampaign([a, b], 'gpt-5.5', chatBasis(5, 15), 20_000)).toMatchObject({ campaign: { id: 'b' }, micros: 14_000 });
    expect(bestCampaign([a, b], 'seed', chatBasis(5, 15), 20_000)).toBeNull();
  });

  it('media: per image (every size, capped at each size\'s official price) and per 1M video tokens (by resolution)', () => {
    const pro = mediaModel('dola-seedream-5-0-pro-260628')!;
    const c = { models: [pro.id], discount: { kind: 'price' as const, prices: { [pro.id]: { perImage: 0.05 } } } };
    // Below 2.61M pixels the official $0.045 is already under the promo $0.05: unchanged. Above, $0.09 -> $0.05.
    expect(promoMicros(c, pro.id, { kind: 'image', model: pro, count: 2, size: '1024x1024' }, toMicros(imageCostUsd(pro, 2, '1024x1024')))).toBe(90_000);
    expect(promoMicros(c, pro.id, { kind: 'image', model: pro, count: 2, size: '2048x2048' }, toMicros(imageCostUsd(pro, 2, '2048x2048')))).toBe(100_000);
    const v = mediaModel('dreamina-seedance-2-0-260128')!;
    const vc = { models: [v.id], discount: { kind: 'price' as const, prices: { [v.id]: { perMVideoTokens: 5 } } } };
    expect(promoMicros(vc, v.id, { kind: 'video', model: v, tokens: 100_000, resolution: '1080p' }, toMicros(videoCostUsd(v, 100_000, '1080p')))).toBe(500_000);
    // An image price on a video request (wrong kind) is no promotion.
    expect(promoMicros({ models: [v.id], discount: { kind: 'price', prices: { [v.id]: { perImage: 0.01 } } } }, v.id, { kind: 'video', model: v, tokens: 100_000 }, 700_000)).toBeNull();
  });
});

describe('below-cost check and validation', () => {
  const catalog: CatalogEntry[] = [
    { id: 'gpt-5.5', name: 'gpt-5.5', provider: 'BytePlus', price: { kind: 'chat', input: 5, output: 15 }, cost: { kind: 'chat', input: 4, output: 12 } },
    { id: 'seedream-4-0-250828', name: 'Seedream 4.0', provider: 'BytePlus', price: { kind: 'image', perImage: 0.03 }, cost: { kind: 'image', perImage: 0.03 } },
  ];

  it('warns where the promo price is below what Valefront pays', () => {
    expect(belowCost(input({ discount: { kind: 'percent', percentBp: 2000 } }), catalog)).toEqual([]); // 4/12: exactly cost
    expect(belowCost(input({ discount: { kind: 'percent', percentBp: 2500 } }), catalog)).toEqual([
      { model: 'gpt-5.5', field: 'input per 1M tokens', promo: 3.75, cost: 4 },
      { model: 'gpt-5.5', field: 'output per 1M tokens', promo: 11.25, cost: 12 },
    ]);
    expect(belowCost(input({ models: ['seedream-4-0-250828'], discount: { kind: 'price', prices: { 'seedream-4-0-250828': { perImage: 0.02 } } } }), catalog))
      .toEqual([{ model: 'seedream-4-0-250828', field: 'per image', promo: 0.02, cost: 0.03 }]);
    expect(promoPriceOf(input(), 'gpt-5.5', catalog[0]!.price)).toEqual({ kind: 'chat', input: 3.75, output: 11.25 });
  });

  it('refuses what is not a campaign', () => {
    const ok = { name: 'X', type: 'automatic', startsAt: '2026-11-07T00:00', endsAt: '2026-11-14T00:00', models: ['gpt-5.5'], discount: { kind: 'percent', percent: 20 } };
    expect(cleanCampaign(ok, catalog)).toMatchObject({ startsAt: Date.UTC(2026, 10, 7), endsAt: Date.UTC(2026, 10, 14), discount: { kind: 'percent', percentBp: 2000 }, code: null });
    const bad = (over: Record<string, unknown>) => () => cleanCampaign({ ...ok, ...over }, catalog);
    expect(bad({ name: '' })).toThrow('name');
    expect(bad({ endsAt: '2026-11-06T00:00' })).toThrow('after the start');
    expect(bad({ models: ['nope'] })).toThrow('not a model');
    expect(bad({ discount: { kind: 'percent', percent: 0 } })).toThrow('0.01% to 100%');
    expect(bad({ discount: { kind: 'percent', percent: 12.345 } })).toThrow('two decimals');
    expect(bad({ type: 'code', code: 'x' })).toThrow('3 to 32');
    expect(bad({ type: 'code', code: 'SAVE20', maxRedemptions: 0 })).toThrow('Max redemptions');
    expect(bad({ discount: { kind: 'price', prices: { 'gpt-5.5': { input: 6 } } } })).toThrow("can't be above");
    expect(bad({ discount: { kind: 'price', prices: { 'seedream-4-0-250828': {} } } })).toThrow('per image');
    expect(cleanCampaign({ ...ok, type: 'code', code: ' save20 ' }, catalog).code).toBe('SAVE20');
  });
});

describe('charging under a campaign (BillingService, D1)', () => {
  async function setup() {
    const f = billingFixture();
    const ws = await workspace(f.store);
    await f.store.addAdjustment(ws.id, 10_000, 'test credit', `test:${ws.id}`);
    return { ...f, ws };
  }
  const paid = async (f: Awaited<ReturnType<typeof setup>>, ws = f.ws) => 100_000_000 - (await f.store.balance(ws.id)).availableMicros;

  it('inside the window: the promo price, and discount = official - promo exactly; outside (before, at the end, paused): official', async () => {
    const f = await setup();
    const c = await f.campaigns.create(input({ startsAt: NOW, endsAt: NOW + DAY }), 'owner@valefront.com');
    const at = async (t: number) => { f.clock.now = t; return f.service.charge(f.ws, { model: 'gpt-5.5', tokens: 2000, usd: 0.02, basis: chatBasis(5, 15) }); };
    expect(await at(NOW - 1)).toEqual({ officialMicros: 20_000, chargedMicros: 20_000, discountMicros: 0, campaign: null, freeTokens: 0 });
    expect(await at(NOW)).toEqual({ officialMicros: 20_000, chargedMicros: 15_000, discountMicros: 5_000, campaign: { id: c.id, name: 'Launch week' }, freeTokens: 0 });
    expect(await at(NOW + DAY - 1)).toMatchObject({ chargedMicros: 15_000, discountMicros: 5_000 });
    expect(await at(NOW + DAY)).toMatchObject({ chargedMicros: 20_000, discountMicros: 0, campaign: null });
    expect(await paid(f)).toBe(20_000 + 15_000 + 15_000 + 20_000);
    f.clock.now = NOW + HOUR;
    await f.campaigns.setStatus(c.id, 'paused', 'owner@valefront.com');
    expect(await f.service.charge(f.ws, { model: 'gpt-5.5', tokens: 2000, usd: 0.02, basis: chatBasis(5, 15) })).toMatchObject({ chargedMicros: 20_000, campaign: null });
  });

  it('only the models it names; without a basis (audio priced its own way) no promotion', async () => {
    const f = await setup();
    await f.campaigns.create(input(), 'owner');
    expect(await f.service.charge(f.ws, { model: 'other-model', tokens: 2000, usd: 0.02, basis: chatBasis(5, 15) })).toMatchObject({ chargedMicros: 20_000, campaign: null });
    expect(await f.service.charge(f.ws, { model: 'gpt-5.5', tokens: 2000, usd: 0.02 })).toMatchObject({ chargedMicros: 20_000, campaign: null });
  });

  it('a fixed promo price, and many small requests: the balance moves by exactly the promo micros', async () => {
    const f = await setup();
    await f.campaigns.create(input({ discount: { kind: 'price', prices: { 'gpt-5.5': { input: 1.2345, output: 3.3333 } } } }), 'owner');
    let official = 0; let charged = 0; let discount = 0;
    for (let i = 1; i <= 50; i++) {
      const usage = { prompt_tokens: 137 * i, completion_tokens: 71 * i };
      const usd = (usage.prompt_tokens * 5 + usage.completion_tokens * 15) / 1_000_000;
      const r = await f.service.charge(f.ws, { model: 'gpt-5.5', tokens: usage.prompt_tokens + usage.completion_tokens, usd, basis: { kind: 'chat', price: { input: 5, output: 15 }, usage } });
      expect(r.discountMicros).toBe(r.officialMicros - r.chargedMicros);
      expect(r.chargedMicros).toBe(toMicros((usage.prompt_tokens * 1.2345 + usage.completion_tokens * 3.3333) / 1_000_000));
      official += r.officialMicros; charged += r.chargedMicros; discount += r.discountMicros;
    }
    expect(await paid(f)).toBe(charged);
    expect(discount).toBe(official - charged);
  });

  it('free tokens behave as today: used first, the promo prices only the rest', async () => {
    const f = await setup();
    await f.campaigns.create(input({ models: ['seed-2-0-lite-260428'], discount: { kind: 'percent', percentBp: 5000 } }), 'owner');
    const grant = (await f.store.grant(f.ws.id))!;
    await f.store.addFreeUsage(f.ws.id, '2026-11-07', grant.tokens - 1000);
    // 4000 tokens costing $0.04: 1000 free, 3000 payable ($0.03) at 50% off -> $0.015.
    const r = await f.service.charge(f.ws, { model: 'seed-2-0-lite-260428', tokens: 4000, usd: 0.04, basis: chatBasis(5, 5, 2000, 2000) });
    expect(r).toMatchObject({ freeTokens: 1000, officialMicros: 30_000, chargedMicros: 15_000, discountMicros: 15_000 });
    expect((await f.store.grant(f.ws.id))!.usedTokens).toBe(grant.tokens);
    expect(await paid(f)).toBe(15_000);
    // All free: nothing charged, no discount.
    const g = await setup();
    await g.campaigns.create(input({ models: ['seed-2-0-lite-260428'] }), 'owner');
    expect(await g.service.charge(g.ws, { model: 'seed-2-0-lite-260428', tokens: 4000, usd: 0.04, basis: chatBasis(5, 5, 2000, 2000) })).toMatchObject({ chargedMicros: 0, discountMicros: 0, campaign: null, freeTokens: 4000 });
  });

  it('campaigns that cannot be read: the official price, logged', async () => {
    const f = await setup();
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(f.campaigns, 'applicable').mockRejectedValueOnce(new Error('no such table: campaigns'));
    expect(await f.service.charge(f.ws, { model: 'gpt-5.5', tokens: 2000, usd: 0.02, basis: chatBasis(5, 15) })).toMatchObject({ chargedMicros: 20_000, campaign: null });
    expect(err.mock.calls.some((c) => String(c[0]).includes('campaign_lookup_failed'))).toBe(true);
    err.mockRestore();
  });

  it('media: images and videos at the promo price, discount exact', async () => {
    const f = await setup();
    const img = mediaModel('seedream-4-0-250828')!;
    const vid = mediaModel('seedance-1-0-pro-fast-251015')!;
    await f.campaigns.create(input({ models: [img.id, vid.id], discount: { kind: 'price', prices: { [img.id]: { perImage: 0.02 }, [vid.id]: { perMVideoTokens: 0.6 } } } }), 'owner');
    const i = await f.service.charge(f.ws, { model: img.id, tokens: 0, usd: imageCostUsd(img, 3), basis: { kind: 'image', model: img, count: 3 } });
    expect(i).toMatchObject({ officialMicros: 90_000, chargedMicros: 60_000, discountMicros: 30_000 });
    const v = await f.service.charge(f.ws, { model: vid.id, tokens: 246_000, usd: videoCostUsd(vid, 246_000), basis: { kind: 'video', model: vid, tokens: 246_000, resolution: '720p' } });
    expect(v).toMatchObject({ officialMicros: 246_000, chargedMicros: 147_600, discountMicros: 98_400 });
    expect(await paid(f)).toBe(60_000 + 147_600);
  });
});

describe('promo codes', () => {
  async function setup(over: Partial<CampaignInput> = {}) {
    const f = billingFixture();
    const c = await f.campaigns.create(input({ type: 'code', code: 'SAVE25', ...over }), 'owner');
    const ws = async () => { const w = await workspace(f.store); await f.store.addAdjustment(w.id, 10_000, 'credit', `t:${w.id}`); return w; };
    const charge = (w: Awaited<ReturnType<typeof ws>>) => f.service.charge(w, { model: 'gpt-5.5', tokens: 2000, usd: 0.02, basis: chatBasis(5, 15) });
    return { ...f, c, ws, charge };
  }

  it('applies only to workspaces that redeemed it (any case)', async () => {
    const f = await setup();
    const a = await f.ws();
    const b = await f.ws();
    expect(await f.service.redeemPromoCode(a, ' save25 ')).toMatchObject({ already: false, campaign: { id: f.c.id, code: 'SAVE25' } });
    expect(await f.charge(a)).toMatchObject({ chargedMicros: 15_000, discountMicros: 5_000, campaign: { id: f.c.id } });
    expect(await f.charge(b)).toMatchObject({ chargedMicros: 20_000, campaign: null });
    expect((await f.service.promotions(a)).campaigns).toHaveLength(1);
    expect((await f.service.promotions(b)).campaigns).toHaveLength(0);
  });

  it('max redemptions is enforced; once per workspace: again is refused and never counted twice', async () => {
    const f = await setup({ maxRedemptions: 2 });
    const [a, b, c] = [await f.ws(), await f.ws(), await f.ws()];
    await f.service.redeemPromoCode(a, 'SAVE25');
    await expect(f.service.redeemPromoCode(a, 'SAVE25')).rejects.toMatchObject({ code: 'promo_code_already', status: 409 });
    await f.service.redeemPromoCode(b, 'SAVE25');
    await expect(f.service.redeemPromoCode(c, 'SAVE25')).rejects.toMatchObject({ code: 'promo_code_full', status: 409 });
    expect((await f.campaigns.get(f.c.id))!.redemptions).toBe(2);
    expect(await f.charge(c)).toMatchObject({ chargedMicros: 20_000 });
  });

  it('two workspaces racing for the last redemption: only one gets it', async () => {
    const f = await setup({ maxRedemptions: 1 });
    const [a, b] = [await f.ws(), await f.ws()];
    const results = await Promise.allSettled([f.service.redeemPromoCode(a, 'SAVE25'), f.service.redeemPromoCode(b, 'SAVE25')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await f.campaigns.get(f.c.id))!.redemptions).toBe(1);
  });

  it('once per workspace off: entering it again is fine, still one redemption', async () => {
    const f = await setup({ oncePerWorkspace: false, maxRedemptions: 1 });
    const a = await f.ws();
    await f.service.redeemPromoCode(a, 'SAVE25');
    expect(await f.service.redeemPromoCode(a, 'SAVE25')).toMatchObject({ already: true });
    expect((await f.campaigns.get(f.c.id))!.redemptions).toBe(1);
  });

  it('unknown, paused or ended codes are refused; guessing is slowed down', async () => {
    const f = await setup();
    const a = await f.ws();
    await expect(f.service.redeemPromoCode(a, 'NOPE')).rejects.toMatchObject({ status: 404 });
    await f.campaigns.setStatus(f.c.id, 'paused', 'owner');
    await expect(f.service.redeemPromoCode(a, 'SAVE25')).rejects.toMatchObject({ status: 404 });
    await f.campaigns.setStatus(f.c.id, 'active', 'owner');
    f.clock.now = NOW + DAY;
    await expect(f.service.redeemPromoCode(a, 'SAVE25')).rejects.toMatchObject({ status: 410 });
    // The two misses an hour+ ago don't count: the ended code and nine wrong ones make ten this hour.
    for (let i = 0; i < 9; i++) await expect(f.service.redeemPromoCode(a, `WRONG${i}`)).rejects.toMatchObject({ status: 404 });
    await expect(f.service.redeemPromoCode(a, 'ANY')).rejects.toMatchObject({ status: 429, code: 'too_many_attempts' });
    f.clock.now += HOUR + 1;
    await expect(f.service.redeemPromoCode(a, 'NOPE')).rejects.toMatchObject({ status: 404 });
  });

  it('a code can be redeemed before the campaign starts and applies from its start', async () => {
    const f = await setup({ startsAt: NOW + HOUR });
    const a = await f.ws();
    await f.service.redeemPromoCode(a, 'SAVE25');
    expect(await f.charge(a)).toMatchObject({ chargedMicros: 20_000 });
    f.clock.now = NOW + HOUR;
    expect(await f.charge(a)).toMatchObject({ chargedMicros: 15_000 });
  });
});

// ── through the API ─────────────────────────────────────────────────────────────────────────────────────

type H = ReturnType<typeof hostedBilling>;
const adm = (h: H) => ({ Host: ADM, 'Cf-Access-Jwt-Assertion': h.access.token({ email: 'owner@valefront.com' }), Origin: `https://${ADM}` });

async function customer(h: H, sub = 'sub-promo', email = 'promo@example.com') {
  const cookie = cookieFor(sub, email);
  const key = (await request(h.app).post('/dashboard/me/workspace').set('Cookie', cookie).set('Origin', ORIGIN).set('CF-Connecting-IP', '203.0.113.9')
    .send({ acceptTerms: true, termsVersion: TERMS_VERSION, turnstileToken: 'ok-token' })).body.key as string;
  const ws = (await h.store.workspaceBySub(sub))!;
  await h.store.addAdjustment(ws.id, 10_000, 'test credit', `test:${ws.id}`);
  return { cookie, key, ws };
}

describe('Campaigns API on adm', () => {
  const body = { name: 'Launch week', type: 'automatic', startsAt: '2026-11-07T00:00:00Z', endsAt: '2026-11-14T00:00:00Z', models: ['gpt-5.5'], discount: { kind: 'percent', percent: 25 } };

  it('lists the catalog; a below-cost campaign needs confirming before it is saved', async () => {
    const h = hostedBilling();
    h.hosted.publishedPrice = (_p, m) => (m === 'gpt-5.5' ? { input: 4, output: 12 } : undefined);
    const list = await request(h.app).get('/admin/api/campaigns').set(adm(h));
    expect(list.status).toBe(200);
    expect(list.body.catalog.find((e: CatalogEntry) => e.id === 'gpt-5.5')).toMatchObject({ price: { kind: 'chat', input: 5, output: 15 }, cost: { kind: 'chat', input: 4, output: 12 } });
    expect(list.body.catalog.some((e: CatalogEntry) => e.id === 'seedance-1-0-pro-fast-251015')).toBe(true);
    expect(list.body.catalog.some((e: CatalogEntry) => e.id === 'wavespeed-ai/flux-dev')).toBe(false);

    const check = await request(h.app).post('/admin/api/campaigns/check').set(adm(h)).send(body);
    expect(check.body.warnings).toHaveLength(2);
    const refused = await request(h.app).post('/admin/api/campaigns').set(adm(h)).send(body);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'below_cost', warnings: [{ model: 'gpt-5.5', promo: 3.75, cost: 4 }, { model: 'gpt-5.5', promo: 11.25, cost: 12 }] });
    expect((await request(h.app).get('/admin/api/campaigns').set(adm(h))).body.campaigns).toHaveLength(0);
    const saved = await request(h.app).post('/admin/api/campaigns').set(adm(h)).send({ ...body, acknowledgeBelowCost: true });
    expect(saved.status).toBe(201);
    expect(saved.body.campaign).toMatchObject({ name: 'Launch week', createdBy: 'owner@valefront.com', prices: [{ id: 'gpt-5.5', promo: { input: 3.75, output: 11.25 } }] });
    // At cost or above: saved without a warning.
    const fine = await request(h.app).post('/admin/api/campaigns').set(adm(h)).send({ ...body, discount: { kind: 'percent', percent: 20 } });
    expect(fine.status).toBe(201);
    const paused = await request(h.app).post(`/admin/api/campaigns/${fine.body.campaign.id}/status`).set(adm(h)).send({ status: 'paused' });
    expect(paused.body.campaign.status).toBe('paused');
    const edited = await request(h.app).put(`/admin/api/campaigns/${fine.body.campaign.id}`).set(adm(h)).send({ ...body, name: 'Renamed', discount: { kind: 'percent', percent: 10 } });
    expect(edited.body.campaign).toMatchObject({ name: 'Renamed', discount: { percentBp: 1000 } });
    expect((await request(h.app).post('/admin/api/campaigns').set(adm(h)).send({ ...body, name: '' })).status).toBe(400);
  });

  it('is adm only: refused without Access, and to a customer on dash', async () => {
    const h = hostedBilling();
    expect((await request(h.app).get('/admin/api/campaigns').set('Host', ADM)).status).toBe(403);
    const c = await customer(h);
    expect((await request(h.app).get('/admin/api/campaigns').set('Cookie', c.cookie)).status).toBe(401);
    expect((await request(h.app).post('/admin/api/campaigns').set('Cookie', c.cookie).set('Origin', ORIGIN).send(body)).status).toBe(401);
  });

  it('a duplicate code is refused', async () => {
    const h = hostedBilling();
    const code = { ...body, type: 'code', code: 'SAVE', discount: { kind: 'percent', percent: 10 }, acknowledgeBelowCost: true };
    expect((await request(h.app).post('/admin/api/campaigns').set(adm(h)).send(code)).status).toBe(201);
    expect((await request(h.app).post('/admin/api/campaigns').set(adm(h)).send(code)).status).toBe(409);
  });
});

describe('end to end: chat, media, spending, dash promo code, /v1/pricing', () => {
  it('a chat request in an automatic campaign is charged the promo price; Spending shows official and discount', async () => {
    const h = hostedBilling();
    const c = await customer(h);
    const camp = await h.campaigns.create(input({ discount: { kind: 'percent', percentBp: 2500 } }), 'owner');
    const res = await request(h.app).post('/v1/chat/completions').set('Authorization', `Bearer ${c.key}`).send({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    await h.settle();
    // 1000 x $5/M + 1000 x $15/M = $0.02 official; 25% off -> $0.015.
    expect(100_000_000 - (await h.store.balance(c.ws.id)).availableMicros).toBe(15_000);
    const usage = (await request(h.app).get('/dashboard/me/usage').set('Cookie', c.cookie)).body;
    expect(usage.keys[0].usage.promotions[camp.id]).toEqual({ name: 'Launch week', requests: 1, tokens: 2000, officialUsd: 0.02, discountUsd: 0.005 });
    const spend = await h.keys.spend();
    expect(spend.promotions?.[camp.id]).toMatchObject({ officialUsd: 0.02, discountUsd: 0.005 });
    // The model line stays at the official price (what the provider is paid).
    expect(spend.byModel?.['Fake/gpt-5.5']?.usd).toBeCloseTo(0.02, 10);
  });

  it('a promo code entered on dash Billing applies to that workspace only', async () => {
    const h = hostedBilling();
    const a = await customer(h, 'sub-a', 'a@example.com');
    const b = await customer(h, 'sub-b', 'b@example.com');
    await h.campaigns.create(input({ type: 'code', code: 'HALF', discount: { kind: 'percent', percentBp: 5000 } }), 'owner');
    const redeem = await request(h.app).post('/dashboard/me/billing/promo-code').set('Cookie', a.cookie).set('Origin', ORIGIN).send({ code: 'half' });
    expect(redeem.status).toBe(201);
    expect(redeem.body.promotions.campaigns[0]).toMatchObject({ name: 'Launch week', code: 'HALF', live: true });
    expect((await request(h.app).post('/dashboard/me/billing/promo-code').set('Cookie', a.cookie).set('Origin', ORIGIN).send({ code: 'HALF' })).status).toBe(409);
    expect((await request(h.app).get('/dashboard/me/billing').set('Cookie', a.cookie)).body.promotions.campaigns).toHaveLength(1);
    for (const c of [a, b]) await request(h.app).post('/v1/chat/completions').set('Authorization', `Bearer ${c.key}`).send({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] });
    await h.settle();
    expect(100_000_000 - (await h.store.balance(a.ws.id)).availableMicros).toBe(10_000);
    expect(100_000_000 - (await h.store.balance(b.ws.id)).availableMicros).toBe(20_000);
  });

  it('media through recordUsage: the promo price and its own spend line', async () => {
    const h = hostedBilling();
    const ws = await workspace(h.store);
    await h.store.addAdjustment(ws.id, 10_000, 'credit', 'test:media-promo');
    const { record } = await h.keys.create({ name: 'k', by: ws.email, workspaceId: ws.id });
    const img = mediaModel('seedream-4-0-250828')!;
    const camp = await h.campaigns.create(input({ models: [img.id], discount: { kind: 'price', prices: { [img.id]: { perImage: 0.025 } } } }), 'owner');
    const req = { issuedKey: record, workspace: ws, requestedModel: img.id, served: { provider: 'BytePlus', model: img.id }, body: {} } as unknown as Request;
    recordUsage(h.hosted, req, { prompt_tokens: 0, completion_tokens: 0 }, 0, imageCostUsd(img, 2), { kind: 'image', model: img, count: 2 });
    await h.settle();
    expect(100_000_000 - (await h.store.balance(ws.id)).availableMicros).toBe(50_000);
    expect((await h.keys.usage(record.id)).promotions?.[camp.id]).toMatchObject({ requests: 1, officialUsd: 0.06, discountUsd: 0.01 });
  });

  it('/v1/pricing publishes live automatic campaigns: official, promo, end date', async () => {
    const h = hostedBilling();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      const img = mediaModel('seedream-4-0-250828')!;
      await h.campaigns.create(input({ models: [img.id], discount: { kind: 'percent', percentBp: 2000 } }), 'owner');
      await h.campaigns.create(input({ name: 'Secret', type: 'code', code: 'SECRET', models: [img.id] }), 'owner');
      const res = await request(h.app).get('/v1/pricing');
      expect(res.status).toBe(200);
      expect(res.body.promotions).toHaveLength(1);
      expect(res.body.promotions[0]).toMatchObject({ name: 'Launch week', ends_at: new Date(NOW + DAY).toISOString(), discount: { kind: 'percent', percent: 20 }, models: [{ id: img.id, official: { per_image: 0.03 }, promo: { per_image: 0.024 } }] });
      expect(res.body.media.find((m: { id: string }) => m.id === img.id).promotion).toMatchObject({ name: 'Launch week', per_image: 0.024, ends_at: new Date(NOW + DAY).toISOString() });
      expect(res.headers['cache-control']).toBe('public, max-age=60');
    } finally {
      jest.restoreAllMocks();
    }
  });
});
