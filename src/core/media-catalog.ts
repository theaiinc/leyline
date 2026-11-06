/**
 * Image and video models Valefront sells, with each provider's official price. One table for routing (which provider
 * serves a model), the price check before a request reaches a provider, and what a finished generation costs.
 *
 * Prices (read 2026-11-06):
 * - BytePlus ModelArk: https://docs.byteplus.com/en/docs/ModelArk/1544106 ("Pricing"). Images are per image (text to
 *   image, no input image). Videos are per million tokens of the finished video (text input, online inference), and
 *   BytePlus charges only for videos that were generated: a failed or moderated one costs nothing.
 * - WaveSpeed: https://wavespeed.ai/docs/docs-api/wavespeed-ai/flux-dev ($0.012 per image).
 *
 * A model missing here is not sold for media: it is refused before any provider is called, never priced by default.
 */

export type MediaKind = 'image' | 'video';
export type MediaProvider = 'BytePlus' | 'WaveSpeed';

export type ImagePrice = {
  /** US dollars per generated image. */
  perImageUsd: number;
  /** A higher price for images above this many pixels (Seedream 5.0 Pro: 2.61M pixels, i.e. above 1.5K). */
  above?: { pixels: number; perImageUsd: number };
};

export type VideoPrice = {
  /** US dollars per million tokens of the generated video at 480p/720p. */
  perMTokensUsd: number;
  /** At 1080p, when the model offers it at another price; unset: 1080p not offered (or same price, see maxResolution). */
  perMTokensUsd1080p?: number;
  maxResolution: '720p' | '1080p';
  /** Seconds a video may last (inclusive); the default is used when the request names none. */
  durations: { min: number; max: number; default: number };
};

export type MediaModel = {
  id: string;
  name: string;
  provider: MediaProvider;
  kind: MediaKind;
  image?: ImagePrice;
  video?: VideoPrice;
};

const BYTEPLUS_PRICING = 'https://docs.byteplus.com/en/docs/ModelArk/1544106';
const WAVESPEED_PRICING = 'https://wavespeed.ai/docs/docs-api/wavespeed-ai/flux-dev';

export const MEDIA_PRICING_SOURCES: Record<MediaProvider, string> = { BytePlus: BYTEPLUS_PRICING, WaveSpeed: WAVESPEED_PRICING };

export const MEDIA_MODELS: MediaModel[] = [
  // Images, BytePlus (Seedream / Dola Seedream: ByteDance's Doubao image models on ModelArk).
  { id: 'dola-seedream-5-0-pro-260628', name: 'Dola Seedream 5.0 Pro', provider: 'BytePlus', kind: 'image', image: { perImageUsd: 0.045, above: { pixels: 2_610_000, perImageUsd: 0.09 } } },
  { id: 'dola-seedream-5-0-flash-260915', name: 'Dola Seedream 5.0 Flash', provider: 'BytePlus', kind: 'image', image: { perImageUsd: 0.018 } },
  { id: 'seedream-4-5-251128', name: 'Seedream 4.5', provider: 'BytePlus', kind: 'image', image: { perImageUsd: 0.04 } },
  { id: 'seedream-4-0-250828', name: 'Seedream 4.0', provider: 'BytePlus', kind: 'image', image: { perImageUsd: 0.03 } },
  // Images, WaveSpeed.
  { id: 'wavespeed-ai/flux-dev', name: 'FLUX.1 [dev]', provider: 'WaveSpeed', kind: 'image', image: { perImageUsd: 0.012 } },
  // Videos, BytePlus (Seedance / Dreamina Seedance).
  { id: 'dreamina-seedance-2-5-260628', name: 'Dreamina Seedance 2.5', provider: 'BytePlus', kind: 'video', video: { perMTokensUsd: 10.7, perMTokensUsd1080p: 11.7, maxResolution: '1080p', durations: { min: 4, max: 15, default: 5 } } },
  { id: 'dreamina-seedance-2-0-260128', name: 'Dreamina Seedance 2.0', provider: 'BytePlus', kind: 'video', video: { perMTokensUsd: 7.0, perMTokensUsd1080p: 7.7, maxResolution: '1080p', durations: { min: 4, max: 15, default: 5 } } },
  { id: 'dreamina-seedance-2-0-fast-260128', name: 'Dreamina Seedance 2.0 Fast', provider: 'BytePlus', kind: 'video', video: { perMTokensUsd: 5.6, maxResolution: '720p', durations: { min: 4, max: 15, default: 5 } } },
  { id: 'dreamina-seedance-2-0-mini-260615', name: 'Dreamina Seedance 2.0 Mini', provider: 'BytePlus', kind: 'video', video: { perMTokensUsd: 3.5, maxResolution: '720p', durations: { min: 4, max: 15, default: 5 } } },
  { id: 'seedance-1-0-pro-250528', name: 'Seedance 1.0 Pro', provider: 'BytePlus', kind: 'video', video: { perMTokensUsd: 2.5, perMTokensUsd1080p: 2.5, maxResolution: '1080p', durations: { min: 2, max: 12, default: 5 } } },
  { id: 'seedance-1-0-pro-fast-251015', name: 'Seedance 1.0 Pro Fast', provider: 'BytePlus', kind: 'video', video: { perMTokensUsd: 1.0, perMTokensUsd1080p: 1.0, maxResolution: '1080p', durations: { min: 2, max: 12, default: 5 } } },
];

const BY_ID = new Map(MEDIA_MODELS.map((m) => [m.id, m]));

export function mediaModel(id: string, kind?: MediaKind): MediaModel | undefined {
  const m = BY_ID.get(id);
  return m && (!kind || m.kind === kind) ? m : undefined;
}

export function isMediaModel(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * Sold by Valefront itself: only BytePlus models (Valefront's one redistribution agreement, Steve 2026-11-06). Others
 * here (WaveSpeed) are not listed publicly or offered to keys by default; an admin can still offer one on adm.
 */
export function isSoldMediaModel(id: string): boolean {
  return BY_ID.get(id)?.provider === 'BytePlus';
}

export function mediaModelsOf(provider: MediaProvider, kind?: MediaKind): MediaModel[] {
  return MEDIA_MODELS.filter((m) => m.provider === provider && (!kind || m.kind === kind));
}

/** "1024x1024" or "1024*1024" -> pixels; undefined when it isn't a size. */
export function pixelsOf(size: string | undefined): number | undefined {
  const m = /^\s*(\d{2,5})\s*[x*×]\s*(\d{2,5})\s*$/i.exec(size ?? '');
  return m ? Number(m[1]) * Number(m[2]) : undefined;
}

/** What `count` generated images cost, in US dollars (exact to the micro-dollar). */
export function imageCostUsd(model: MediaModel, count: number, size?: string): number {
  const p = model.image!;
  const px = pixelsOf(size);
  const each = p.above && px !== undefined && px > p.above.pixels ? p.above.perImageUsd : p.perImageUsd;
  return Math.round(each * Math.max(0, Math.floor(count)) * 1_000_000) / 1_000_000;
}

/** What a finished video costs: its tokens x the per-million rate for its resolution. */
export function videoCostUsd(model: MediaModel, tokens: number, resolution?: string): number {
  const p = model.video!;
  const rate = resolution === '1080p' && p.perMTokensUsd1080p !== undefined ? p.perMTokensUsd1080p : p.perMTokensUsd;
  return Math.round((Math.max(0, tokens) * rate) / 1_000_000 * 1_000_000) / 1_000_000;
}

/** The duration to ask for: the one requested within the model's range (whole seconds), else its default. */
export function videoDuration(model: MediaModel, requested: unknown): number {
  const d = model.video!.durations;
  const n = typeof requested === 'number' && Number.isFinite(requested) ? Math.round(requested) : d.default;
  return Math.min(d.max, Math.max(d.min, n));
}

/** The resolution to ask for: 480p, 720p or (where offered) 1080p; default 720p. */
export function videoResolution(model: MediaModel, requested: unknown): '480p' | '720p' | '1080p' {
  if (requested === '480p') return '480p';
  if (requested === '1080p' && model.video!.maxResolution === '1080p') return '1080p';
  return '720p';
}
