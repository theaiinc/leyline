import { BytePlusProvider, BYTEPLUS_CATALOG_PRICING, BYTEPLUS_CHAT_MODEL_IDS, byteplusChatModelReadsImages } from '../src/providers/byteplus';
import { config } from '../src/config';
import { costUsd, isByteplusPeak, priceAt, type Price } from '../src/core/issued-keys';
import { builtinPrice, toPublicPricingModel } from '../src/core/pricing';
import { recordUsage, type HostedOptions } from '../src/core/hosted';
import { renderPricingPage } from '../src/core/pricing-page';
import type { Request } from 'express';

/**
 * The BytePlus ModelArk chat catalog against the official Pricing page (Standard online inference, US$ per 1M tokens)
 * and Model list, https://docs.byteplus.com/en/docs/ModelArk/1544106 and /1330310, read 2026-11-06.
 */
const OFFICIAL: Record<string, { input: number; output: number; cachedInput: number; vision: boolean }> = {
  'dola-seed-2-1-turbo-260628': { input: 0.5, output: 2.5, cachedInput: 0.1, vision: true },
  'seed-2-0-lite-260428': { input: 0.25, output: 2.0, cachedInput: 0.05, vision: true },
  'seed-2-0-mini-260428': { input: 0.1, output: 0.4, cachedInput: 0.02, vision: true },
  'seed-2-0-pro-260328': { input: 0.5, output: 3.0, cachedInput: 0.1, vision: true },
  'seed-2-0-code-preview-260328': { input: 0.5, output: 3.0, cachedInput: 0.1, vision: true },
  'deepseek-v4-1-flash-economy-261017': { input: 0.12, output: 0.48, cachedInput: 0.002, vision: true },
  'deepseek-v4-1-flash-261017': { input: 0.15, output: 0.6, cachedInput: 0.003, vision: true },
  'deepseek-v4-1-flash-260910': { input: 0.15, output: 0.6, cachedInput: 0.003, vision: true },
  'deepseek-v4-pro-ga-260813': { input: 1.32, output: 3.96, cachedInput: 0.044, vision: false },
  'deepseek-v4-flash-ga-260731': { input: 0.44, output: 1.32, cachedInput: 0.014, vision: false },
  'deepseek-v4-pro-260425': { input: 1.32, output: 3.96, cachedInput: 0.044, vision: false },
  'deepseek-v4-flash-260425': { input: 0.44, output: 1.32, cachedInput: 0.014, vision: false },
  'glm-5-3-flash-260828': { input: 0.15, output: 0.5, cachedInput: 0.03, vision: true },
  'glm-5-2-260617': { input: 1.4, output: 4.4, cachedInput: 0.26, vision: false },
};

// 2026-11-06 is a Friday. UTC+8 wall-clock times, as UTC instants.
const FRI_10_00 = Date.parse('2026-11-06T02:00:00Z'); // peak
const FRI_12_00 = Date.parse('2026-11-06T04:00:00Z'); // lunch: off-peak
const FRI_17_59 = Date.parse('2026-11-06T09:59:00Z'); // peak
const FRI_18_00 = Date.parse('2026-11-06T10:00:00Z'); // off-peak
const SAT_10_00 = Date.parse('2026-11-07T02:00:00Z'); // weekend: off-peak

const price = (id: string) => BYTEPLUS_CATALOG_PRICING[id] as Price;

describe('BytePlus ModelArk chat catalog', () => {
  it('has every official chat model, ids exactly as BytePlus spells them, at its official price', () => {
    expect([...BYTEPLUS_CHAT_MODEL_IDS].sort()).toEqual(Object.keys(OFFICIAL).sort());
    for (const [id, o] of Object.entries(OFFICIAL)) {
      const p = price(id);
      expect({ id, input: p.input, output: p.output, cachedInput: p.cachedInput }).toEqual({ id, input: o.input, output: o.output, cachedInput: o.cachedInput });
      for (const n of [p.input, p.output, p.cachedInput!]) expect(Number.isFinite(n) && n >= 0).toBe(true);
      expect(byteplusChatModelReadsImages(id)).toBe(o.vision);
      expect(id).toMatch(/^[a-z0-9-]+-\d{6}$/);
    }
  });

  it('is the default offered list, and every model in it is one the provider serves', () => {
    expect([...config.offeredModels].sort()).toEqual([...BYTEPLUS_CHAT_MODEL_IDS].sort());
    const provider = new BytePlusProvider('test-key');
    for (const id of BYTEPLUS_CHAT_MODEL_IDS) expect(provider.servesModel('chat', id)).toBe(true);
    expect(provider.servesModel('chat', 'dola-seedream-5-0-pro-260628')).toBe(false);
  });

  it('prices Seed 2.0 by prompt length: [0, 128K] and (128K, 256K], the whole request at its tier', () => {
    const lite = price('seed-2-0-lite-260428');
    // The official example: 200K input and 14K output tokens use the (128, 256]K tier: $0.50 in, $4.00 out.
    expect(costUsd(lite, { prompt_tokens: 200_000, completion_tokens: 14_000 })).toBeCloseTo(200_000 * 0.5 / 1e6 + 14_000 * 4.0 / 1e6, 12);
    expect(costUsd(lite, { prompt_tokens: 128_000, completion_tokens: 1_000 })).toBeCloseTo(128_000 * 0.25 / 1e6 + 1_000 * 2.0 / 1e6, 12);
    expect(priceAt(lite, { prompt_tokens: 128_001 })).toMatchObject({ input: 0.5, output: 4.0, cachedInput: 0.1 });
    // Cached tokens at the tier's cached price.
    expect(costUsd(lite, { prompt_tokens: 150_000, cached_tokens: 100_000, completion_tokens: 0 })).toBeCloseTo((50_000 * 0.5 + 100_000 * 0.1) / 1e6, 12);
    expect(priceAt(price('seed-2-0-mini-260428'), { prompt_tokens: 200_000 })).toMatchObject({ input: 0.2, output: 0.8, cachedInput: 0.04 });
    expect(priceAt(price('seed-2-0-pro-260328'), { prompt_tokens: 200_000 })).toMatchObject({ input: 1.0, output: 6.0, cachedInput: 0.2 });
    expect(priceAt(price('seed-2-0-code-preview-260328'), { prompt_tokens: 200_000 })).toMatchObject({ input: 1.0, output: 6.0, cachedInput: 0.2 });
    // Dola Seed 2.1 Turbo has one tier, [0, 256]K.
    expect(priceAt(price('dola-seed-2-1-turbo-260628'), { prompt_tokens: 200_000 })).toMatchObject({ input: 0.5, output: 2.5, cachedInput: 0.1 });
  });

  it('knows BytePlus peak hours: Mon-Fri 09:00-12:00 and 14:00-18:00 at UTC+8', () => {
    expect(isByteplusPeak(FRI_10_00)).toBe(true);
    expect(isByteplusPeak(FRI_12_00)).toBe(false);
    expect(isByteplusPeak(Date.parse('2026-11-06T06:00:00Z'))).toBe(true); // Fri 14:00
    expect(isByteplusPeak(FRI_17_59)).toBe(true);
    expect(isByteplusPeak(FRI_18_00)).toBe(false);
    expect(isByteplusPeak(SAT_10_00)).toBe(false);
    expect(isByteplusPeak(Date.parse('2026-11-09T00:59:00Z'))).toBe(false); // Mon 08:59
    expect(isByteplusPeak(Date.parse('2026-11-09T01:00:00Z'))).toBe(true); // Mon 09:00
    expect(isByteplusPeak(Date.parse('2026-11-06T16:30:00Z'))).toBe(false); // Sat 00:30 (still Friday in UTC)
  });

  it('prices DeepSeek V4.1 Flash at the peak price in peak hours and the off-peak price otherwise', () => {
    const flash = price('deepseek-v4-1-flash-261017');
    const usage = { prompt_tokens: 1_000_000, cached_tokens: 0, completion_tokens: 1_000_000 };
    expect(costUsd(flash, usage, FRI_10_00)).toBeCloseTo(0.3 + 1.2, 12);
    expect(costUsd(flash, usage, SAT_10_00)).toBeCloseTo(0.15 + 0.6, 12);
    expect(costUsd(flash, { prompt_tokens: 1_000_000, cached_tokens: 1_000_000 }, FRI_17_59)).toBeCloseTo(0.006, 12);
    expect(costUsd(flash, { prompt_tokens: 1_000_000, cached_tokens: 1_000_000 }, FRI_18_00)).toBeCloseTo(0.003, 12);
    const economy = price('deepseek-v4-1-flash-economy-261017');
    expect(priceAt(economy, undefined, FRI_10_00)).toMatchObject({ input: 0.24, output: 0.96, cachedInput: 0.005 });
    expect(priceAt(economy, undefined, FRI_12_00)).toMatchObject({ input: 0.12, output: 0.48, cachedInput: 0.002 });
    expect(priceAt(price('deepseek-v4-1-flash-260910'), undefined, FRI_10_00)).toMatchObject({ input: 0.3, output: 1.2, cachedInput: 0.006 });
  });

  it('prices one-price models (DeepSeek V4, GLM) the same at any time and prompt length, cached input at its own price', () => {
    for (const id of ['deepseek-v4-flash-ga-260731', 'deepseek-v4-pro-ga-260813', 'glm-5-3-flash-260828', 'glm-5-2-260617']) {
      const o = OFFICIAL[id]!;
      const usage = { prompt_tokens: 300_000, cached_tokens: 100_000, completion_tokens: 50_000 };
      const expected = (200_000 * o.input + 100_000 * o.cachedInput + 50_000 * o.output) / 1e6;
      expect(costUsd(price(id), usage, FRI_10_00)).toBeCloseTo(expected, 12);
      expect(costUsd(price(id), usage, SAT_10_00)).toBeCloseTo(expected, 12);
    }
  });

  it('a flat price is unchanged by priceAt', () => {
    const flat: Price = { input: 1, output: 2 };
    expect(priceAt(flat, { prompt_tokens: 1e6 }, FRI_10_00)).toBe(flat);
  });

  it('publishes cached input, prompt tiers and peak prices on /v1/pricing', () => {
    expect(toPublicPricingModel('BytePlus', { id: 'seed-2-0-lite-260428', name: 'Dola Seed 2.0 Lite', pricing: price('seed-2-0-lite-260428') })).toMatchObject({
      input: 0.25, output: 2.0, cached_input: 0.05,
      prompt_tiers: [{ above_tokens: 128_000, input: 0.5, output: 4.0, cached_input: 0.1 }],
    });
    const flash = toPublicPricingModel('BytePlus', { id: 'deepseek-v4-1-flash-261017', name: 'DeepSeek V4.1 Flash', pricing: price('deepseek-v4-1-flash-261017') });
    expect(flash).toMatchObject({ input: 0.15, output: 0.6, cached_input: 0.003, peak: { input: 0.3, output: 1.2, cached_input: 0.006 } });
    expect(flash!.peak!.hours).toContain('UTC+8');
    const page = renderPricingPage({ models: [flash] });
    expect(page).toContain('Off-peak prices shown');
  });

  it('refuses audio input (priced 15x text by BytePlus, not told apart in usage) and takes images', () => {
    const provider = new BytePlusProvider('test-key');
    const audio = { model: 'seed-2-0-lite-260428', messages: [{ role: 'user' as const, content: [{ type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }] as never }] };
    const image = { model: 'seed-2-0-lite-260428', messages: [{ role: 'user' as const, content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] as never }] };
    expect(provider.acceptsNonTextContent(audio)).toBe(false);
    expect(provider.acceptsNonTextContent(image)).toBe(true);
  });

  it('prices ModelArk text embeddings at the official text-input price', () => {
    expect(builtinPrice('skylark-embedding-vision-251215')).toEqual({ input: 0.125, output: 0 });
  });

  it('charges a customer the tier the prompt falls in (spend line and workspace charge alike)', async () => {
    const recorded: number[] = [];
    const charged: Array<number | null> = [];
    const opts = {
      keys: { record: async (_k: unknown, _m: string, _u: unknown, usd: number) => { recorded.push(usd); }, recordPromotion: async () => undefined },
      publishedPrice: (provider: string, model: string) => (provider === 'BytePlus' ? BYTEPLUS_CATALOG_PRICING[model] : undefined),
      anyPublishedPrice: () => undefined,
      billing: { charge: async (_ws: unknown, c: { usd: number | null }) => { charged.push(c.usd); return { campaign: null, discountMicros: 0, officialMicros: 0 }; } },
      aliases: {},
      prices: {},
      models: [],
    } as unknown as HostedOptions;
    const req = { issuedKey: { id: 'k1', caps: {} }, workspace: { id: 'ws1' }, requestedModel: 'seed-2-0-lite-260428', served: { provider: 'BytePlus', model: 'seed-2-0-lite-260428' }, body: {} } as unknown as Request;
    recordUsage(opts, req, { prompt_tokens: 200_000, completion_tokens: 14_000 });
    await new Promise((r) => setImmediate(r));
    const expected = 200_000 * 0.5 / 1e6 + 14_000 * 4.0 / 1e6;
    expect(recorded[0]).toBeCloseTo(expected, 12);
    expect(charged[0]).toBeCloseTo(expected, 12);
  });
});
