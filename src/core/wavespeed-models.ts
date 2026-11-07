import { isSoldMediaModel } from './media-catalog';

/**
 * WaveSpeed's own model list, for a workspace's WaveSpeed provider ("Your providers"): every model the customer's
 * WaveSpeed key can run, not only the ones Valefront sells. BYOK runs on the customer's key and costs Valefront
 * nothing, so Valefront's price list never limits it.
 *
 * - List: GET {base}/models (https://wavespeed.ai/docs/list-models) -> {code, message, data: [{model_id, name,
 *   base_price, description, type, api_schema: {api_schemas: [{type: "model_run", method, api_path, request_schema:
 *   {properties, required}}]}}]}. `type` is one of text-to-image, image-to-image, text-to-video, image-to-video,
 *   video-to-video, text-to-audio (others may appear; they are kept as "other").
 * - Submit: POST {base}/{model_id} (https://wavespeed.ai/docs/submit-task); result: GET
 *   {base}/predictions/{id}/result (https://wavespeed.ai/docs/get-result).
 *
 * The list is read with the workspace's key and kept a few minutes per provider (this instance's memory). When
 * WaveSpeed can't be read, the last list read is kept; with none, the model is not known and any WaveSpeed id the
 * customer asks for is still sent (WaveSpeed itself answers whether the key may run it).
 */

export type WaveSpeedKind = 'image' | 'video' | 'audio' | 'other';

export type WaveSpeedField = {
  type?: string; description?: string; default?: unknown; enum?: unknown[]; minimum?: number; maximum?: number;
  items?: { type?: string }; title?: string;
};
export type WaveSpeedSchema = { properties: Record<string, WaveSpeedField>; required: string[] };

export type WaveSpeedModelInfo = {
  id: string;
  name: string;
  /** WaveSpeed's task type, e.g. text-to-image, image-to-video ('' when not given). */
  type: string;
  kind: WaveSpeedKind;
  description?: string;
  /** WaveSpeed's base price in US dollars (what the customer's WaveSpeed account pays; Valefront charges nothing). */
  basePrice?: number;
  /** The model's request fields, when WaveSpeed lists them. */
  schema?: WaveSpeedSchema;
};

/**
 * A WaveSpeed model id: owner/name with optional more path parts (wavespeed-ai/flux-dev, kwaivgi/kling-v2.1-i2v-pro,
 * wavespeed-ai/z-image/turbo). Never an id Valefront sells (BytePlus Seedream/Seedance ids have no slash anyway).
 */
export function isWaveSpeedModelId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/.test(id) && !isSoldMediaModel(id);
}

export function kindOfType(type: string): WaveSpeedKind {
  const t = type.toLowerCase();
  if (/(^|-)video$/.test(t)) return 'video';
  if (/(^|-)image$/.test(t)) return 'image';
  if (/(^|-)(audio|speech|music)$/.test(t)) return 'audio';
  return 'other';
}

const FIELD_KEYS = ['type', 'description', 'default', 'enum', 'minimum', 'maximum', 'items', 'title'] as const;

function schemaOf(raw: unknown): WaveSpeedSchema | undefined {
  const schemas = (raw as { api_schemas?: unknown })?.api_schemas;
  if (!Array.isArray(schemas)) return undefined;
  const run = (schemas.find((s) => (s as { type?: unknown })?.type === 'model_run') ?? schemas[0]) as { request_schema?: { properties?: unknown; required?: unknown } } | undefined;
  const props = run?.request_schema?.properties;
  if (!props || typeof props !== 'object') return undefined;
  const properties: Record<string, WaveSpeedField> = {};
  for (const [name, def] of Object.entries(props as Record<string, unknown>)) {
    if (!def || typeof def !== 'object') continue;
    const field: Record<string, unknown> = {};
    for (const k of FIELD_KEYS) if ((def as Record<string, unknown>)[k] !== undefined) field[k] = (def as Record<string, unknown>)[k];
    properties[name] = field as WaveSpeedField;
  }
  const required = Array.isArray(run?.request_schema?.required) ? (run!.request_schema!.required as unknown[]).filter((r): r is string => typeof r === 'string') : [];
  return { properties, required };
}

/** WaveSpeed's /models answer -> the models in it (anything unreadable is skipped). */
export function parseWaveSpeedModels(body: unknown): WaveSpeedModelInfo[] {
  const data = (body as { data?: unknown })?.data;
  const list = Array.isArray(data) ? data : Array.isArray((data as { items?: unknown })?.items) ? (data as { items: unknown[] }).items : [];
  const out: WaveSpeedModelInfo[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const m = (raw ?? {}) as Record<string, unknown>;
    const id = typeof m.model_id === 'string' ? m.model_id : typeof m.id === 'string' ? m.id : '';
    if (!isWaveSpeedModelId(id) || seen.has(id)) continue;
    seen.add(id);
    const type = typeof m.type === 'string' ? m.type : '';
    const price = typeof m.base_price === 'number' ? m.base_price : typeof m.base_price === 'string' && m.base_price.trim() ? Number(m.base_price) : NaN;
    const schema = schemaOf(m.api_schema);
    out.push({
      id, name: typeof m.name === 'string' && m.name ? m.name : id, type, kind: kindOfType(type),
      ...(typeof m.description === 'string' && m.description ? { description: m.description.slice(0, 600) } : {}),
      ...(Number.isFinite(price) ? { basePrice: price } : {}),
      ...(schema ? { schema } : {}),
    });
  }
  return out;
}

/** GET {base}/models with the key. Throws on an HTTP error or an answer without a model list. */
export async function fetchWaveSpeedModels(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = (i, init) => fetch(i, init)): Promise<WaveSpeedModelInfo[]> {
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw Object.assign(new Error(`WaveSpeed model list failed (HTTP ${res.status})`), { status: res.status });
  const body = await res.json();
  if (!Array.isArray((body as { data?: unknown })?.data) && !Array.isArray((body as { data?: { items?: unknown } })?.data?.items)) throw new Error('WaveSpeed model list: no data');
  return parseWaveSpeedModels(body);
}

export type WaveSpeedModelList = {
  /** Null: never read (WaveSpeed unreachable): any WaveSpeed id is accepted and WaveSpeed decides. */
  models: WaveSpeedModelInfo[] | null;
  /** Read from WaveSpeed within the cache time (false: the last list kept after a failed read, or none). */
  live: boolean;
  fetchedAt: number | null;
};

/** Per provider (its id and last change, so a replaced key reads again): the list for `ttlMs`; a failed read waits `retryMs`. */
export class WaveSpeedModelCache {
  private readonly entries = new Map<string, { at: number; models: WaveSpeedModelInfo[] | null; failedAt?: number }>();
  private readonly inflight = new Map<string, Promise<WaveSpeedModelList>>();

  constructor(private readonly ttlMs = 5 * 60_000, private readonly retryMs = 30_000, private readonly now: () => number = Date.now) {}

  async get(cacheKey: string, load: () => Promise<WaveSpeedModelInfo[]>): Promise<WaveSpeedModelList> {
    const e = this.entries.get(cacheKey);
    const t = this.now();
    if (e?.models && t - e.at < this.ttlMs) return { models: e.models, live: true, fetchedAt: e.at };
    if (e?.failedAt !== undefined && t - e.failedAt < this.retryMs) return { models: e.models, live: false, fetchedAt: e.models ? e.at : null };
    const running = this.inflight.get(cacheKey);
    if (running) return running;
    const p = (async (): Promise<WaveSpeedModelList> => {
      try {
        const models = await load();
        const at = this.now();
        this.entries.set(cacheKey, { at, models });
        return { models, live: true, fetchedAt: at };
      } catch (err) {
        console.error(JSON.stringify({ event: 'wavespeed_models_failed', error: err instanceof Error ? err.message : String(err), kept: !!e?.models }));
        this.entries.set(cacheKey, { at: e?.at ?? 0, models: e?.models ?? null, failedAt: this.now() });
        return { models: e?.models ?? null, live: false, fetchedAt: e?.models ? e.at : null };
      } finally {
        this.inflight.delete(cacheKey);
      }
    })();
    this.inflight.set(cacheKey, p);
    return p;
  }

  clear(): void {
    this.entries.clear();
  }
}

export const wavespeedModelCache = new WaveSpeedModelCache();

const RESERVED = new Set(['model', 'keyId', 'response_format', 'n', 'user', 'stream', 'input', 'enable_sync_mode', 'enable_base64_output']);

/**
 * What to send WaveSpeed for a BYOK request: every field the client sent, unchanged (each model has its own schema:
 * image, images, seed, negative_prompt, aspect_ratio, guidance_scale, enable_safety_checker, …), plus `input` (an
 * object) merged over them. Only the OpenAI-shaped fields are translated: size "1024x1024" -> "1024*1024", n ->
 * num_images, and ratio -> aspect_ratio when the model has aspect_ratio but no ratio.
 */
export function wavespeedInput(body: Record<string, unknown>, schema?: WaveSpeedSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (!RESERVED.has(k) && v !== undefined) out[k] = v;
  if (body.input && typeof body.input === 'object' && !Array.isArray(body.input)) {
    for (const [k, v] of Object.entries(body.input as Record<string, unknown>)) if (k !== 'enable_sync_mode' && k !== 'enable_base64_output') out[k] = v;
  }
  if (typeof out.size === 'string' && /^\s*\d+\s*x\s*\d+\s*$/i.test(out.size)) out.size = out.size.replace(/\s*x\s*/i, '*').trim();
  const props = schema?.properties;
  if (body.n !== undefined && out.num_images === undefined && (!props || 'num_images' in props)) out.num_images = Number(body.n);
  if (out.ratio !== undefined && out.aspect_ratio === undefined && props && !('ratio' in props) && 'aspect_ratio' in props) {
    out.aspect_ratio = out.ratio;
    delete out.ratio;
  }
  return out;
}
