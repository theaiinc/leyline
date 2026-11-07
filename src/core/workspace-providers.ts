import { AzureOpenAIProvider } from '../providers/azure-openai';
import { OpenAIProvider } from '../providers/openai';
import { AnthropicProvider } from '../providers/anthropic';
import { WaveSpeedProvider } from '../providers/wavespeed';
import { mediaModel, mediaModelsOf } from './media-catalog';
import type { D1Database } from './d1-stores';
import type { CompletionRequest, CompletionResponse, Provider, RouteOptions, StreamChunk } from './types';

/**
 * A workspace's own model providers ("bring your own key"): Valefront resells BytePlus ModelArk only; any other
 * provider (an Azure OpenAI resource, an OpenAI-compatible gateway such as LLM API or OpenRouter, Anthropic) is the
 * customer's own account, configured on dash ("Your providers") and used only by that workspace's keys, for the
 * models it lists. Billed by that provider: requests through it are counted (spend line `BYOK:<label>`) but never
 * charged a model price, and the credit check doesn't apply to them (hosted.ts). Table: worker/migrations/0007.
 *
 * The API key is encrypted with AES-GCM under LEYLINE_STORE_KEY (the D1SecretStore scheme, d1-stores.ts), with the
 * workspace id and provider id as additional data, so a value can't be moved to another workspace or provider. It is
 * write-only: no view or API returns it, and a provider is built from it per request.
 *
 * WaveSpeed (images and video) is a media kind: its models are WaveSpeed's ids in the media catalog
 * (src/core/media-catalog.ts), served on /v1/images/generations and /v1/videos only, never on chat. The shared pool
 * has no WaveSpeed key: a WaveSpeed model works for a workspace only through its own WaveSpeed provider.
 */

export const BYOK_KINDS = ['azure-openai', 'openai-compatible', 'anthropic', 'wavespeed'] as const;
export type ByokKind = (typeof BYOK_KINDS)[number];
/** Kinds that serve images and video (media-routes.ts), not chat. */
export const MEDIA_BYOK_KINDS: readonly ByokKind[] = ['wavespeed'];
export const isMediaKind = (kind: ByokKind) => MEDIA_BYOK_KINDS.includes(kind);
const WAVESPEED_API = 'https://api.wavespeed.ai/api/v3';
/** The WaveSpeed models a workspace's WaveSpeed provider can serve: WaveSpeed's ids in the media catalog. */
export const wavespeedModelIds = () => mediaModelsOf('WaveSpeed').map((m) => m.id);
/** Spend lines and the request log name a workspace's own provider `BYOK:<label>`. */
export const BYOK_PREFIX = 'BYOK:';
export const MAX_PROVIDERS_PER_WORKSPACE = 20;
export const MAX_MODELS_PER_PROVIDER = 200;
const ANTHROPIC_API = 'https://api.anthropic.com/v1';
const AZURE_DEFAULT_API_VERSION = '2024-10-21';

/** A workspace provider as anyone may see it: never its key. */
export type WorkspaceProvider = {
  id: string;
  workspaceId: string;
  kind: ByokKind;
  label: string;
  baseUrl: string;
  deployment: string | null;
  apiVersion: string | null;
  models: string[];
  enabled: boolean;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
};

/** The stored row, with the sealed key (inside this module and the store only). */
type SealedProvider = WorkspaceProvider & { keyIv: string; keyData: string };

export type WorkspaceProviderInput = {
  kind?: unknown;
  label?: unknown;
  baseUrl?: unknown;
  deployment?: unknown;
  apiVersion?: unknown;
  models?: unknown;
  apiKey?: unknown;
  enabled?: unknown;
};

export class WorkspaceProviderError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = 'WorkspaceProviderError';
  }
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const aad = (workspaceId: string, id: string) => new TextEncoder().encode(`workspace-provider:${workspaceId}:${id}`);

/** AES-GCM under LEYLINE_STORE_KEY (32 bytes, base64), additional data bound to the workspace and the provider. */
class KeyBox {
  private key: Promise<CryptoKey> | null = null;
  constructor(private readonly storeKey: string) {}

  private cryptoKey(): Promise<CryptoKey> {
    if (!this.key) {
      const raw = unb64(this.storeKey);
      if (raw.length !== 32) throw new Error('LEYLINE_STORE_KEY must be 32 bytes, base64');
      this.key = crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    }
    return this.key;
  }

  async seal(workspaceId: string, id: string, secret: string): Promise<{ keyIv: string; keyData: string }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(workspaceId, id) }, await this.cryptoKey(), new TextEncoder().encode(secret));
    return { keyIv: b64(iv), keyData: b64(new Uint8Array(data)) };
  }

  async open(workspaceId: string, id: string, sealed: { keyIv: string; keyData: string }): Promise<string> {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.keyIv), additionalData: aad(workspaceId, id) }, await this.cryptoKey(), unb64(sealed.keyData));
    return new TextDecoder().decode(plain);
  }
}

type Row = Record<string, unknown>;
const strOrNull = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));

function rowToProvider(r: Row): SealedProvider {
  let models: string[] = [];
  try {
    const parsed = JSON.parse(String(r.models));
    if (Array.isArray(parsed)) models = parsed.filter((m): m is string => typeof m === 'string');
  } catch {
    // a bad row lists nothing
  }
  return {
    id: String(r.id), workspaceId: String(r.workspace_id), kind: String(r.kind) as ByokKind, label: String(r.label), baseUrl: String(r.base_url),
    deployment: strOrNull(r.deployment), apiVersion: strOrNull(r.api_version), models, enabled: Number(r.enabled) === 1,
    createdAt: Number(r.created_at), createdBy: String(r.created_by), updatedAt: Number(r.updated_at),
    keyIv: String(r.key_iv), keyData: String(r.key_data),
  };
}

/** Never the key: what views, APIs and logs get. */
export function publicView(p: WorkspaceProvider | SealedProvider): WorkspaceProvider {
  return {
    id: p.id, workspaceId: p.workspaceId, kind: p.kind, label: p.label, baseUrl: p.baseUrl, deployment: p.deployment, apiVersion: p.apiVersion,
    models: [...p.models], enabled: p.enabled, createdAt: p.createdAt, createdBy: p.createdBy, updatedAt: p.updatedAt,
  };
}

// ── validation ─────────────────────────────────────────────────────────────────────────────────────────────

const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,39}$/;
const MODEL = /^[^\s*,]{1,200}$/;

function privateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === '::1' || h === '::' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  return false;
}

/** An https URL on a public host (requests to it are made from Valefront's servers), without a trailing slash. */
export function cleanBaseUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WorkspaceProviderError('invalid_base_url', 'Base URL must be a full https:// URL.');
  }
  if (url.protocol !== 'https:') throw new WorkspaceProviderError('invalid_base_url', 'Base URL must use https://.');
  if (url.username || url.password) throw new WorkspaceProviderError('invalid_base_url', 'Put the API key in its own field, not in the URL.');
  if (privateHost(url.hostname)) throw new WorkspaceProviderError('invalid_base_url', 'Base URL must be on a public host.');
  if (url.search || url.hash) throw new WorkspaceProviderError('invalid_base_url', 'Base URL must not have a query or fragment.');
  return url.toString().replace(/\/+$/, '');
}

export function cleanModels(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,]/) : [];
  const models = [...new Set(list.map((m) => (typeof m === 'string' ? m.trim() : '')).filter(Boolean))];
  if (!models.length) throw new WorkspaceProviderError('models_required', 'List at least one model id this provider serves.');
  if (models.length > MAX_MODELS_PER_PROVIDER) throw new WorkspaceProviderError('too_many_models', `A provider can list up to ${MAX_MODELS_PER_PROVIDER} models.`);
  for (const m of models) {
    if (!MODEL.test(m)) throw new WorkspaceProviderError('invalid_model', `"${m.slice(0, 60)}" is not a model id (no spaces, commas or *).`);
    if (/^auto($|[:-])/i.test(m)) throw new WorkspaceProviderError('invalid_model', `"${m}" is reserved for Valefront's routing.`);
  }
  return models;
}

function cleanLabel(value: unknown): string {
  const label = typeof value === 'string' ? value.trim() : '';
  if (!LABEL.test(label)) throw new WorkspaceProviderError('invalid_label', 'Name it with 1-40 letters, digits, spaces or . _ : -');
  return label;
}

function cleanKind(value: unknown): ByokKind {
  if (typeof value === 'string' && (BYOK_KINDS as readonly string[]).includes(value)) return value as ByokKind;
  throw new WorkspaceProviderError('invalid_kind', `kind must be one of ${BYOK_KINDS.join(', ')}.`);
}

function cleanApiKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key) throw new WorkspaceProviderError('api_key_required', 'Enter the API key for this provider.');
  if (key.length > 4096 || /\s/.test(key)) throw new WorkspaceProviderError('invalid_api_key', 'That does not look like an API key.');
  return key;
}

const cleanOptional = (value: unknown, max = 200): string | null => {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) return null;
  if (s.length > max || /\s/.test(s)) throw new WorkspaceProviderError('invalid_field', 'Deployment and API version have no spaces.');
  return s;
};

/** A full, checked provider from what was sent (an add), or the changes to apply to `current` (an update). */
function cleanInput(input: WorkspaceProviderInput, current?: WorkspaceProvider): Omit<WorkspaceProvider, 'id' | 'workspaceId' | 'createdAt' | 'createdBy' | 'updatedAt'> & { apiKey?: string } {
  const kind = current ? current.kind : cleanKind(input.kind);
  if (current && input.kind !== undefined && input.kind !== current.kind) throw new WorkspaceProviderError('kind_fixed', 'The kind of a provider cannot change; add a new one.');
  const label = input.label !== undefined || !current ? cleanLabel(input.label) : current.label;
  const defaultBaseUrl = kind === 'anthropic' ? ANTHROPIC_API : kind === 'wavespeed' ? WAVESPEED_API : undefined;
  const baseUrlInput = (input.baseUrl === '' && !current ? undefined : input.baseUrl) ?? (current ? current.baseUrl : defaultBaseUrl);
  if (baseUrlInput === undefined || baseUrlInput === '') throw new WorkspaceProviderError('base_url_required', 'Enter the base URL of this provider.');
  const baseUrl = cleanBaseUrl(baseUrlInput);
  const deployment = kind === 'azure-openai' ? (input.deployment !== undefined ? cleanOptional(input.deployment) : current?.deployment ?? null) : null;
  const apiVersion = kind === 'azure-openai' ? (input.apiVersion !== undefined ? cleanOptional(input.apiVersion, 40) : current?.apiVersion ?? null) : null;
  // Azure: each model is a deployment name; without a list, the deployment is the one model.
  // WaveSpeed: only its catalog models (each one is priced and has a known request shape); without a list, all of them.
  const models = input.models !== undefined ? cleanModels(input.models)
    : current ? current.models
      : kind === 'azure-openai' && deployment ? [deployment] : kind === 'wavespeed' ? wavespeedModelIds() : cleanModels(undefined);
  if (kind === 'wavespeed') {
    const other = models.find((m) => mediaModel(m)?.provider !== 'WaveSpeed');
    if (other) throw new WorkspaceProviderError('invalid_model', `"${other.slice(0, 60)}" is not a WaveSpeed model Valefront supports (${wavespeedModelIds().join(', ')}).`);
  }
  const enabled = input.enabled === undefined ? (current?.enabled ?? true) : input.enabled === true;
  const apiKey = input.apiKey !== undefined || !current ? cleanApiKey(input.apiKey) : undefined;
  return { kind, label, baseUrl, deployment, apiVersion, models, enabled, ...(apiKey !== undefined ? { apiKey } : {}) };
}

// ── the store ──────────────────────────────────────────────────────────────────────────────────────────────

export class D1WorkspaceProviderStore {
  private readonly box: KeyBox;
  constructor(private readonly db: D1Database, storeKey: string, private readonly now: () => number = Date.now) {
    this.box = new KeyBox(storeKey);
  }

  async listSealed(workspaceId: string): Promise<SealedProvider[]> {
    const { results = [] } = await this.db.prepare('SELECT * FROM workspace_providers WHERE workspace_id = ? ORDER BY created_at, id').bind(workspaceId).all<Row>();
    return results.map(rowToProvider);
  }

  async list(workspaceId: string): Promise<WorkspaceProvider[]> {
    return (await this.listSealed(workspaceId)).map(publicView);
  }

  private async sealed(workspaceId: string, id: string): Promise<SealedProvider | null> {
    const r = await this.db.prepare('SELECT * FROM workspace_providers WHERE id = ? AND workspace_id = ?').bind(id, workspaceId).first<Row>();
    return r ? rowToProvider(r) : null;
  }

  async get(workspaceId: string, id: string): Promise<WorkspaceProvider | null> {
    const p = await this.sealed(workspaceId, id);
    return p ? publicView(p) : null;
  }

  async add(workspaceId: string, input: WorkspaceProviderInput, by: string): Promise<WorkspaceProvider> {
    const clean = cleanInput(input);
    const existing = await this.listSealed(workspaceId);
    if (existing.length >= MAX_PROVIDERS_PER_WORKSPACE) throw new WorkspaceProviderError('too_many_providers', `A workspace can have ${MAX_PROVIDERS_PER_WORKSPACE} providers; remove one first.`, 409);
    if (existing.some((p) => p.label.toLowerCase() === clean.label.toLowerCase())) throw new WorkspaceProviderError('label_taken', `You already have a provider named "${clean.label}".`, 409);
    const id = `wsp_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const now = this.now();
    const sealed = await this.box.seal(workspaceId, id, clean.apiKey!);
    await this.db.prepare('INSERT INTO workspace_providers (id, workspace_id, kind, label, base_url, deployment, api_version, models, key_iv, key_data, enabled, created_at, created_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, workspaceId, clean.kind, clean.label, clean.baseUrl, clean.deployment, clean.apiVersion, JSON.stringify(clean.models), sealed.keyIv, sealed.keyData, clean.enabled ? 1 : 0, now, by, now).run();
    return (await this.get(workspaceId, id))!;
  }

  async update(workspaceId: string, id: string, input: WorkspaceProviderInput): Promise<WorkspaceProvider> {
    const current = await this.sealed(workspaceId, id);
    if (!current) throw new WorkspaceProviderError('not_found', 'Provider not found.', 404);
    const clean = cleanInput(input, current);
    if (clean.label.toLowerCase() !== current.label.toLowerCase()
      && (await this.listSealed(workspaceId)).some((p) => p.id !== id && p.label.toLowerCase() === clean.label.toLowerCase())) {
      throw new WorkspaceProviderError('label_taken', `You already have a provider named "${clean.label}".`, 409);
    }
    const sealed = clean.apiKey !== undefined ? await this.box.seal(workspaceId, id, clean.apiKey) : { keyIv: current.keyIv, keyData: current.keyData };
    await this.db.prepare('UPDATE workspace_providers SET label = ?, base_url = ?, deployment = ?, api_version = ?, models = ?, key_iv = ?, key_data = ?, enabled = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
      .bind(clean.label, clean.baseUrl, clean.deployment, clean.apiVersion, JSON.stringify(clean.models), sealed.keyIv, sealed.keyData, clean.enabled ? 1 : 0, this.now(), id, workspaceId).run();
    return (await this.get(workspaceId, id))!;
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const r = await this.db.prepare('DELETE FROM workspace_providers WHERE id = ? AND workspace_id = ?').bind(id, workspaceId).run();
    return (r.meta.changes ?? 0) > 0;
  }

  /** Every provider of a workspace, keys included (the workspace is being deleted). */
  async removeAll(workspaceId: string): Promise<number> {
    const r = await this.db.prepare('DELETE FROM workspace_providers WHERE workspace_id = ?').bind(workspaceId).run();
    return r.meta.changes ?? 0;
  }

  /** The provider's API key (for building it for a request; never returned by any API). */
  async apiKey(p: SealedProvider): Promise<string> {
    return this.box.open(p.workspaceId, p.id, p);
  }
}

// ── building a provider for a request ──────────────────────────────────────────────────────────────────────

/** The provider for one request to `model` (for Azure, the model is the deployment name; for WaveSpeed, its media model). */
export function buildByokProvider(p: WorkspaceProvider, apiKey: string, model: string): Provider {
  const name = `${BYOK_PREFIX}${p.label}`;
  let provider: Provider;
  if (p.kind === 'azure-openai') {
    const azure = AzureOpenAIProvider.forInstance({ endpoint: p.baseUrl, deployment: model || p.deployment || '', apiKey, apiVersion: p.apiVersion && p.apiVersion !== 'v1' ? p.apiVersion : AZURE_DEFAULT_API_VERSION });
    azure.embeddingDeployment = '';
    azure.setOpenAICompatible(p.apiVersion === 'v1' || /\/openai\/v1\/?$/.test(p.baseUrl));
    azure.capabilities = ['chat'];
    provider = azure;
  } else if (p.kind === 'anthropic') {
    provider = new AnthropicProvider(apiKey, model, p.baseUrl);
  } else if (p.kind === 'wavespeed') {
    // Built from the workspace's own key (never process.env.WAVESPEED_API_KEY: the shared pool has none).
    provider = new WaveSpeedProvider(apiKey, p.baseUrl);
  } else {
    const openai = new OpenAIProvider(apiKey, model, p.baseUrl);
    openai.capabilities = ['chat'];
    provider = openai;
  }
  provider.name = name;
  provider.label = p.label;
  return provider;
}

type RouterLike = {
  route(request: CompletionRequest, opts?: RouteOptions): Promise<CompletionResponse>;
  routeStream(request: CompletionRequest, opts?: RouteOptions): AsyncGenerator<StreamChunk, void, unknown>;
  routeVia(provider: Provider, request: CompletionRequest, opts?: Pick<RouteOptions, 'onServed'>): Promise<CompletionResponse>;
  routeStreamVia(provider: Provider, request: CompletionRequest, opts?: Pick<RouteOptions, 'onServed'>): AsyncGenerator<StreamChunk, void, unknown>;
};

/**
 * One workspace's enabled providers, as a request sees them: which model goes where, and the provider for it. Two
 * providers listing the same model: the older first, the next one only when it failed (before its first chunk).
 */
export class WorkspaceByok {
  /** Chat models (Azure OpenAI, OpenAI-compatible, Anthropic). */
  private readonly byModel = new Map<string, SealedProvider[]>();
  /** Image and video models (WaveSpeed). */
  private readonly byMediaModel = new Map<string, SealedProvider[]>();

  constructor(readonly workspaceId: string, providers: SealedProvider[], private readonly keyOf: (p: SealedProvider) => Promise<string>) {
    for (const p of providers) {
      if (!p.enabled) continue;
      const map = isMediaKind(p.kind) ? this.byMediaModel : this.byModel;
      for (const m of p.models) (map.get(m) ?? map.set(m, []).get(m)!).push(p);
    }
  }

  get size(): number {
    return new Set([...this.byModel.keys(), ...this.byMediaModel.keys()]).size;
  }

  /** Every model this workspace's own providers serve (chat and media). */
  models(): string[] {
    return [...new Set([...this.byModel.keys(), ...this.byMediaModel.keys()])];
  }

  /** The models of the workspace's own chat providers. */
  chatModels(): string[] {
    return [...this.byModel.keys()];
  }

  /** Served by one of the workspace's own providers (chat or media). */
  has(model: string | undefined | null): boolean {
    return !!model && (this.byModel.has(model) || this.byMediaModel.has(model));
  }

  /** Served by one of the workspace's own chat providers. */
  hasChat(model: string | undefined | null): boolean {
    return !!model && this.byModel.has(model);
  }

  /** The image or video model, if one of the workspace's own media providers (WaveSpeed) serves it; else null. */
  mediaMatch(model: string | undefined | null): string | null {
    return model && this.byMediaModel.has(model) ? model : null;
  }

  /** The label of the first provider serving the model. */
  labelFor(model: string): string | undefined {
    return (this.byModel.get(model) ?? this.byMediaModel.get(model))?.[0]?.label;
  }

  /**
   * What the client asked for, if a provider of the workspace's serves it: the model itself, else what the host's
   * alias maps it to. Null: not a BYOK model. A BYOK model wins over the shared pool.
   */
  match(requested: string, aliased: string): string | null {
    if (this.hasChat(requested)) return requested;
    if (aliased !== requested && this.hasChat(aliased)) return aliased;
    return null;
  }

  async providersFor(model: string): Promise<Provider[]> {
    return Promise.all((this.byModel.get(model) ?? []).map(async (p) => buildByokProvider(p, await this.keyOf(p), model)));
  }

  /** The workspace's own media providers for an image or video model, in order (built from their keys, per request). */
  async mediaProvidersFor(model: string): Promise<Provider[]> {
    return Promise.all((this.byMediaModel.get(model) ?? []).map(async (p) => buildByokProvider(p, await this.keyOf(p), model)));
  }

  /** The media provider named `BYOK:<label>` (reading a video job it started), or null when it's gone or off. */
  async mediaProviderNamed(name: string, model: string): Promise<Provider | null> {
    const p = (this.byMediaModel.get(model) ?? []).find((x) => `${BYOK_PREFIX}${x.label}` === name);
    return p ? buildByokProvider(p, await this.keyOf(p), model) : null;
  }

  /** The router for this request: a BYOK model goes to the workspace's provider, never to the pool; the rest as usual. */
  wrap(router: RouterLike): RouterLike {
    const self = this;
    return {
      route: async (request, opts) => {
        if (opts?.forceProvider || !self.hasChat(request.model)) return router.route(request, opts);
        let last: unknown;
        for (const provider of await self.providersFor(request.model)) {
          try {
            return await router.routeVia(provider, request, opts);
          } catch (err) {
            last = err;
          }
        }
        throw last;
      },
      routeStream: async function* (request, opts) {
        if (opts?.forceProvider || !self.hasChat(request.model)) {
          yield* router.routeStream(request, opts);
          return;
        }
        let last: unknown;
        for (const provider of await self.providersFor(request.model)) {
          let started = false;
          try {
            for await (const chunk of router.routeStreamVia(provider, request, opts)) {
              started = true;
              yield chunk;
            }
            return;
          } catch (err) {
            if (started) throw err;
            last = err;
          }
        }
        throw last;
      },
      routeVia: router.routeVia.bind(router),
      routeStreamVia: router.routeStreamVia.bind(router),
    };
  }
}

/**
 * Workspace providers for requests: each workspace's list is read at most every `ttlMs` per instance (a key's every
 * request would otherwise read D1), and at once after a change made on this instance. Keys stay sealed in the cache
 * and are opened per request.
 */
export class WorkspaceProviders {
  private readonly cache = new Map<string, { at: number; byok: WorkspaceByok }>();

  constructor(readonly store: D1WorkspaceProviderStore, private readonly ttlMs = 30_000, private readonly now: () => number = Date.now) {}

  async forWorkspace(workspaceId: string): Promise<WorkspaceByok> {
    const cached = this.cache.get(workspaceId);
    if (cached && this.now() - cached.at < this.ttlMs) return cached.byok;
    try {
      const byok = new WorkspaceByok(workspaceId, await this.store.listSealed(workspaceId), (p) => this.store.apiKey(p));
      this.cache.set(workspaceId, { at: this.now(), byok });
      return byok;
    } catch (err) {
      // D1 unreachable: keep using what this instance last read rather than sending BYOK models to the pool.
      if (cached) return cached.byok;
      throw err;
    }
  }

  forget(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }

  async list(workspaceId: string): Promise<WorkspaceProvider[]> {
    return this.store.list(workspaceId);
  }

  async add(workspaceId: string, input: WorkspaceProviderInput, by: string): Promise<WorkspaceProvider> {
    try {
      return await this.store.add(workspaceId, input, by);
    } finally {
      this.forget(workspaceId);
    }
  }

  async update(workspaceId: string, id: string, input: WorkspaceProviderInput): Promise<WorkspaceProvider> {
    try {
      return await this.store.update(workspaceId, id, input);
    } finally {
      this.forget(workspaceId);
    }
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    try {
      return await this.store.remove(workspaceId, id);
    } finally {
      this.forget(workspaceId);
    }
  }

  async removeAll(workspaceId: string): Promise<number> {
    try {
      return await this.store.removeAll(workspaceId);
    } finally {
      this.forget(workspaceId);
    }
  }

  /**
   * One tiny request through the provider (its first model, or the one named): ok, or the upstream HTTP status. The
   * provider's own error text is not passed on (it can echo what was sent).
   */
  async test(workspaceId: string, id: string, model?: string): Promise<{ ok: boolean; model: string; status: number | null; ms: number }> {
    const sealed = (await this.store.listSealed(workspaceId)).find((p) => p.id === id);
    if (!sealed) throw new WorkspaceProviderError('not_found', 'Provider not found.', 404);
    const target = model && sealed.models.includes(model) ? model : sealed.models[0] ?? sealed.deployment ?? '';
    const provider = buildByokProvider(sealed, await this.store.apiKey(sealed), target);
    const started = Date.now();
    try {
      // WaveSpeed: its balance (GET /balance), an authenticated read that generates nothing and costs nothing.
      if (provider instanceof WaveSpeedProvider) {
        await provider.balance();
        return { ok: true, model: target, status: 200, ms: Date.now() - started };
      }
      await provider.complete({ model: target, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 16 } as CompletionRequest);
      return { ok: true, model: target, status: 200, ms: Date.now() - started };
    } catch (err) {
      const e = err as { status?: number; response?: { status?: number } };
      const status = typeof e?.status === 'number' ? e.status : typeof e?.response?.status === 'number' ? e.response.status : null;
      return { ok: false, model: target, status, ms: Date.now() - started };
    }
  }
}

// ── copying a shared-pool provider into a workspace (adm) ──────────────────────────────────────────────────

/** A shared-pool provider's settings, read server-side for the admin's from-pool copy (the key never leaves). */
export type PoolCredentials = { kind: ByokKind; apiKey: string; baseUrl: string; deployment: string | null; apiVersion: string | null; models: string[] };

const OPENROUTER_API = 'https://openrouter.ai/api/v1';

/**
 * The live settings of a pool provider (what the router itself uses: a key from env, D1 or Arcana), for the kinds a
 * workspace can have: Azure OpenAI (AzureOpenAI and its named instances), OpenAI-compatible (LLM API, OpenAI,
 * OpenRouter) and Anthropic. Null: no such provider, or one of another kind (BytePlus is the pool itself).
 */
export function poolCredentials(provider: Provider, listedModels: string[]): PoolCredentials | null {
  const field = (name: string): string => {
    const v = (provider as unknown as Record<string, unknown>)[name];
    return typeof v === 'string' ? v : '';
  };
  const chat = listedModels.filter((m) => !/embed|whisper|transcri|tts|speech/i.test(m));
  if (provider.family === 'AzureOpenAI' || provider.name === 'AzureOpenAI' || provider.name.startsWith('AzureOpenAI:')) {
    const runtime = (provider as unknown as { getRuntimeConfig?: () => Record<string, unknown> }).getRuntimeConfig?.() ?? {};
    const baseUrl = typeof runtime.baseUrl === 'string' ? runtime.baseUrl : field('endpoint');
    const deployment = (typeof runtime.model === 'string' ? runtime.model : '') || field('deployment');
    const v1 = runtime.openAICompatible === true;
    return {
      kind: 'azure-openai', apiKey: field('apiKey'), baseUrl, deployment: deployment || null,
      // A v1 endpoint whose URL doesn't say so (AZURE_OPENAI_BASE_URL) keeps v1 through apiVersion "v1".
      apiVersion: v1 && !/\/openai\/v1\/?$/.test(baseUrl) ? 'v1' : v1 ? null : field('apiVersion') || null,
      models: deployment ? [deployment] : chat,
    };
  }
  if (provider.name === 'Anthropic') {
    return { kind: 'anthropic', apiKey: field('apiKey'), baseUrl: field('api') || ANTHROPIC_API, deployment: null, apiVersion: null, models: chat };
  }
  if (provider.name === 'OpenRouter') {
    return { kind: 'openai-compatible', apiKey: field('apiKey'), baseUrl: OPENROUTER_API, deployment: null, apiVersion: null, models: chat };
  }
  if (provider.name === 'LLM API' || provider.name === 'OpenAI') {
    return { kind: 'openai-compatible', apiKey: field('apiKey'), baseUrl: field('baseUrl'), deployment: null, apiVersion: null, models: chat };
  }
  return null;
}
