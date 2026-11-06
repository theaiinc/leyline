import type { Express, NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import type { Router } from './router';
import { AegisAuth, cookie, cookies, type AdminUser } from './admin-login';
import { CostAlerts, DEFAULT_ALERTS, type AlertChannels, type AlertSettings } from './alerts';
import { AnthropicStream, anthropicError, anthropicToOpenAI, estimateTokens, openAIToAnthropic, type AnthropicRequest } from './anthropic';
import { builtinPrice } from './pricing';
import type { ChargeBasis } from './campaigns';
import { errorStatus } from './media';
import { estimateBodyTokens } from './content';
import { DEFAULT_PRICE, IssuedKeys, costUsd, manualPriceOf, modelAllowed, priceAt, priceOf, type HostedSettings, type IssuedKey, type KeyCaps, type Price } from './issued-keys';
import type { BillingService } from './billing-service';
import type { WorkspaceRecord } from './billing-store';
import type { AccessConfig } from './cloudflare-access';
import type { PartnerInquiries } from './partner-inquiries';
import type { BenchmarkSnapshot } from './benchmarks';
import { RequestPiiRedactor } from './pii-redaction';
import { ADDON_PROVIDER, PII_ADDON_ID } from './addons';
import { RepriceRefused, repriceSpend } from './spend-reprice';
import { accessAdminOf } from './admin-billing';
import { isPublicSaleModel } from './pricing';
import { isMediaModel, isSoldMediaModel } from './media-catalog';
import { mountAdminCampaigns } from './admin-campaigns';
import { Memo, isRouterPick, planStrategy, strategyFor, isRoutingStrategy, routeByPlan, routeHeader, streamByPlan, strategyErrorResponse, ROUTING_STRATEGIES, type RoutePlan, type StrategyEnv } from './routing-strategies';
import { BYTEPLUS_BENCHMARK_ALIASES, byteplusChatModelReadsImages } from '../providers/byteplus';
import { logger, type LogEntry } from './logger';
import type { CompletionRequest } from './types';
import { BYOK_PREFIX, WorkspaceProviderError, type PoolCredentials, type WorkspaceByok, type WorkspaceProviders } from './workspace-providers';

/** An image or video generation, for pricing it under a promotion (recordUsage). */
export type MediaChargeBasis = Extract<ChargeBasis, { kind: 'image' | 'video' }>;

function capabilitiesForModel(modelId: string): string[] {
  const id = modelId.toLowerCase();
  if (/embed|bge|text-embedding/.test(id)) return ['embeddings'];
  if (/whisper|transcri/.test(id)) return ['transcription'];
  if (/tts|speech|aura|melotts|voice/.test(id)) return ['speech'];
  if (/image|dall-e|flux|stable-diffusion/.test(id)) return ['image'];
  if (/video|seedance|veo|sora|kling/.test(id)) return ['video'];
  return ['chat'];
}

/**
 * Hosted Leyline: an LLM API the owner hands out keys for, so people can plug it into their coding agents.
 *
 * - Requests carry an issued key (`Authorization: Bearer ll_…` or Anthropic's `x-api-key`); its caps (tokens a
 *   month, requests a day and a minute, models) are checked first and its usage counted after.
 * - OpenAI's /v1/chat/completions (server.ts) and Anthropic's /v1/messages (here) both route through Leyline's
 *   router to the owner's provider keys; /v1/models lists what's offered.
 * - The owner manages everything on the dashboard (/dashboard: provider keys, routing, these keys, the models
 *   offered), signed in with Aegis (emails in LEYLINE_ADMIN_EMAILS), or with LEYLINE_ADMIN_TOKEN as a bearer token
 *   for scripts. The models offered and aliases start from env and, once saved on the dashboard, come from the store.
 */

export type HostedOptions = {
  keys: IssuedKeys;
  /** Model ids offered (what /v1/models lists and what keys may ask for, unless a key narrows it). */
  models: string[];
  /** Requested model (exact or with *) -> upstream model, e.g. {"claude-*": "gemini-2.5-pro"} for Claude Code. */
  aliases: Record<string, string>;
  login: AegisAuth | null;
  adminEmails: string[];
  adminToken?: string;
  publicUrl: string;
  /** Additional approved public origins for dashboard requests and sign-in callbacks. */
  publicAliases?: string[];
  /** Builds the OAuth callback URI for the approved host used by this request. */
  redirectUriForRequest?: (req: Request) => string;
  /** Models turned off for every key (ids or patterns with *). */
  blockedModels?: string[];
  /** The most all keys together may spend a month (US dollars); null: no limit. */
  monthlyBudgetUsd?: number | null;
  /** The most each provider may be paid a month (US dollars), by provider name; see providersOverBudget. */
  providerBudgetsUsd?: Record<string, number>;
  /** US dollars per million tokens by model (or pattern), and the price for models without one. */
  prices?: Record<string, Price>;
  defaultPrice?: Price;
  /** Price models without a manual price at what their provider publishes (default on). */
  usePublishedPrices?: boolean;
  /** The serving provider's published price for a model (the router's model lists; set by mountHosted). */
  publishedPrice?: (provider: string, model: string) => Price | undefined;
  /** Any provider's published price for a model (for one served by a provider that publishes none). */
  anyPublishedPrice?: (model: string) => Price | undefined;
  publishedPriceCounts?: () => Record<string, number>;
  /** Cost alert thresholds and channels (saved with the settings). */
  alerts?: AlertSettings;
  /** Sends an alert email (the Worker's Email Sending binding); unset: email isn't available on this host. */
  sendEmail?: AlertChannels['sendEmail'];
  /** When the settings were last saved on the dashboard (null: env defaults). */
  settingsSaved?: { at: number; by: string } | null;
  /** Cached benchmark snapshot used by the public benchmark API and dashboard. */
  benchmarks?: () => Promise<BenchmarkSnapshot | null>;
  /**
   * Keeps work that finishes after the response alive (usage, spend). The Worker passes its waitUntil: Workers
   * cancels anything a finished request left running.
   */
  background?: (work: Promise<unknown>) => void;
  /** Self-serve workspaces and prepaid billing (D1); unset: only owner-issued keys, nothing is charged. */
  billing?: BillingService | null;
  /** Cloudflare Turnstile: the public site key, and Siteverify with the TURNSTILE_SECRET secret. */
  turnstile?: { siteKey: string; verify: (token: string, ip: string) => Promise<boolean> } | null;
  /** "Partner with Valefront" inquiries (D1; the valefront.com form, admin under /partners); unset: refused with 503. */
  partners?: PartnerInquiries | null;
  /** The admin host (adm.valefront.com), behind Cloudflare Access: billing admin is served there only. */
  adminHost?: string;
  access?: AccessConfig | null;
  /** The Worker's vars and secrets, for the admin page's "credentials present: yes/no" (values are never shown). */
  providerEnv?: Record<string, string | undefined>;
  /** Workspaces' own providers (BYOK, src/core/workspace-providers.ts); unset: none, every model is the pool's. */
  workspaceProviders?: WorkspaceProviders | null;
  /** A shared-pool provider's live settings, key included, for adm's from-pool copy (set by server.ts). */
  poolProvider?: (name: string) => Promise<PoolCredentials | null>;
};

type WithKey = Request & {
  issuedKey?: IssuedKey; freeTokensOnly?: boolean; requestedModel?: string; ownerRequest?: boolean; workspace?: WorkspaceRecord;
  served?: { provider: string; model: string }; timings?: { lookupMs: number; admitMs: number }; pii?: RequestPiiRedactor;
  /** The key's workspace's own providers (BYOK), and the model of theirs this request names (null: a pool model). */
  byok?: WorkspaceByok | null; byokModel?: string | null;
  /** Admitted for the workspace's own providers only (no credit): a routing strategy may pick only BYOK models. */
  byokOnly?: boolean;
};

/** The endpoints a workspace's own providers (BYOK) serve: chat, in the OpenAI, Anthropic and Responses formats. */
const BYOK_PATHS = new Set(['/v1/chat/completions', '/v1/messages', '/v1/responses']);

/** Served by a workspace's own provider (BYOK): never charged a model price, and no cost to Valefront. */
export function servedByByok(provider: string | undefined): boolean {
  return !!provider && provider.startsWith(BYOK_PREFIX);
}

/**
 * The model to send upstream for a request: the workspace's own model as asked (an alias never takes a BYOK model
 * to the pool), else the host's alias for it, else as asked.
 */
export function requestModel(opts: HostedOptions, req: Request, model: string): string {
  const r = req as WithKey;
  if (r.byok && r.byokModel && (model === r.requestedModel || model === r.byokModel)) return r.byokModel;
  return resolveModel(opts.aliases, model);
}

/** The router for this request: a workspace key's BYOK models go to its own providers, everything else as before. */
export function routerFor<R extends Router>(router: R, req: Request): Pick<Router, 'route' | 'routeStream'> {
  const byok = (req as WithKey).byok;
  return byok && byok.size ? byok.wrap(router) : router;
}

/** Route option that remembers which provider and model served this request (for spend by provider and model). */
export function servedBy(req: Request): (provider: string, model: string) => void {
  return (provider, model) => {
    (req as WithKey).served = { provider, model };
  };
}

/** The model to send upstream for what the client asked (an alias, else as asked). */
export function resolveModel(aliases: Record<string, string>, model: string): string {
  if (aliases[model]) return aliases[model];
  for (const [pattern, target] of Object.entries(aliases)) {
    if (pattern.includes('*') && modelAllowed({ models: [pattern] }, model)) return target;
  }
  return model;
}

function presentedKey(req: Request): string {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const x = req.headers['x-api-key'];
  return typeof x === 'string' ? x.trim() : '';
}

/** Checks the issued key and its caps; errors in the shape of the API being called. */
export function requireIssuedKey(opts: HostedOptions, format: 'openai' | 'anthropic') {
  return async (req: Request, res: Response, next: NextFunction) => {
    const fail = (status: number, code: string, message: string) => (format === 'anthropic'
      ? res.status(status).json(anthropicError(status, message))
      : res.status(status).json({ error: { message, type: status === 401 ? 'invalid_request_error' : status === 402 ? 'insufficient_credit' : status === 429 ? 'rate_limit_error' : 'permission_error', code } }));
    const presented = presentedKey(req);
    // The owner, signed in on the dashboard (its playground): no key, no caps, not counted.
    if (!presented && adminOf(opts, req) && sameOrigin(opts, req)) {
      (req as WithKey).requestedModel = typeof req.body?.model === 'string' ? req.body.model : '';
      (req as WithKey).ownerRequest = true;
      return next();
    }
    if (!presented) return fail(401, 'missing_api_key', 'Missing API key: send Authorization: Bearer <key> (or x-api-key).');
    let key: IssuedKey | null;
    const lookupAt = Date.now();
    try {
      key = await opts.keys.lookup(presented);
    } catch (err) {
      console.error('[hosted] key lookup failed', err);
      return fail(503, 'key_store_unavailable', 'Leyline could not check the API key just now; try again.');
    }
    if (!key) return fail(401, 'invalid_api_key', 'Incorrect API key provided.');
    const requested = typeof req.body?.model === 'string' ? req.body.model : '';
    if (/^auto:/i.test(requested.trim()) && !isRoutingStrategy(requested.trim().slice(5).toLowerCase())) {
      return fail(400, 'unknown_routing_strategy', `Unknown routing strategy "${requested}": use ${ROUTING_STRATEGIES.map((s) => `auto:${s}`).join(', ')}, auto, or a model id.`);
    }
    // A customer's own providers (BYOK): a model one of them lists goes there, for this workspace's keys only.
    let byok: WorkspaceByok | null = null;
    if (key.workspaceId && opts.workspaceProviders) {
      try {
        byok = await opts.workspaceProviders.forWorkspace(key.workspaceId);
      } catch (err) {
        // Never fails a request that worked before BYOK existed: without the list, every model is the pool's (as before).
        console.error(JSON.stringify({ event: 'workspace_providers_lookup_failed', workspaceId: key.workspaceId, error: err instanceof Error ? err.message : String(err) }));
      }
    }
    // Chat only (chat completions, Anthropic messages, responses): other endpoints (embeddings, media) keep the pool.
    const byokModel = byok && requested && !isRouterPick(requested) && BYOK_PATHS.has(req.path) ? byok.match(requested, resolveModel(opts.aliases, requested)) : null;
    (req as WithKey).byok = byok && byok.size ? byok : null;
    (req as WithKey).byokModel = byokModel;
    const offered = isRouterPick(requested) || !!byokModel || opts.models.length === 0 || opts.models.some((m) => modelAllowed({ models: [m] }, requested)) || !!resolveAlias(opts, requested) || isSoldMediaModel(requested);
    if (!offered) return fail(404, 'model_not_found', `The model "${requested}" is not offered here; see /v1/models.`);
    // The host's blocked list is for the shared pool: a workspace's own provider is the customer's to use.
    if (requested && !byokModel && isBlocked(opts, requested)) {
      return fail(403, 'model_disabled', `The model "${requested}" is turned off here; see /v1/models for what you can use.`);
    }
    const admitAt = Date.now();
    const refusal = await opts.keys.admit(key, requested, await ownerLimitFor(opts, key));
    (req as WithKey).timings = { lookupMs: admitAt - lookupAt, admitMs: Date.now() - admitAt };
    if (refusal) return fail(refusal.status, refusal.code, refusal.message);
    // A customer's key: the workspace must be in good standing, the model must have a real price, and there must be
    // credit (or free tokens) left. Owner/internal keys (no workspace) and the admins' own workspaces never are.
    if (key.workspaceId) {
      if (!opts.billing) return fail(503, 'billing_unavailable', 'Valefront could not check your balance just now; try again.');
      let ws: WorkspaceRecord | null;
      try {
        ws = await opts.billing.store.workspace(key.workspaceId);
      } catch (err) {
        console.error('[hosted] workspace lookup failed', err);
        return fail(503, 'billing_unavailable', 'Valefront could not check your balance just now; try again.');
      }
      if (!ws || ws.deletedAt) return fail(401, 'key_revoked', 'This API key has been revoked.');
      if (!isAdminEmail(opts, ws.email)) {
        const target = resolveModel(opts.aliases, requested);
        const routerPicks = isRouterPick(requested);
        if (byokModel) {
          // The customer's own provider bills them: no model price, no credit needed (PII protection still does).
          let own;
          try {
            own = await opts.billing.admitByok(ws, { piiProtection: piiProtectionOn(key) });
          } catch (err) {
            console.error('[hosted] workspace check failed', err);
            return fail(503, 'billing_unavailable', 'Valefront could not check your balance just now; try again.');
          }
          if (own.refusal) return fail(own.refusal.status, own.refusal.code, own.refusal.message);
        } else {
          if (!routerPicks && !realPrice(opts, target) && !isMediaModel(target)) {
            return fail(403, 'model_not_priced', `The model "${requested}" has no published price yet, so it can't be used with this key; see https://llm.valefront.com/v1/pricing.`);
          }
          let admission;
          try {
            admission = await opts.billing.admit(ws, routerPicks ? requested : target, { piiProtection: piiProtectionOn(key) });
          } catch (err) {
            console.error('[hosted] credit check failed', err);
            return fail(503, 'billing_unavailable', 'Valefront could not check your balance just now; try again.');
          }
          if ('refusal' in admission) {
            // No credit, but a routing strategy can still pick one of the workspace's own models (billed by them).
            const strategy = routerPicks && byok?.size && BYOK_PATHS.has(req.path) ? (() => { try { return strategyFor(requested, key.caps.routingStrategy); } catch { return null; } })() : null;
            const own = strategy && admission.refusal.status !== 403 ? await opts.billing.admitByok(ws, { piiProtection: piiProtectionOn(key) }).catch(() => null) : null;
            if (!own || own.refusal) return fail(admission.refusal.status, admission.refusal.code, admission.refusal.message);
            (req as WithKey).byokOnly = true;
          } else if (routerPicks && admission.mode === 'free' && !admission.paid) {
            // Admitted on free tokens alone (no balance): a routing strategy may pick only free-tier models.
            (req as WithKey).freeTokensOnly = true;
          }
        }
        (req as WithKey).workspace = ws;
      }
    }
    (req as WithKey).issuedKey = key;
    (req as WithKey).requestedModel = requested;
    (req as WithKey).pii = new RequestPiiRedactor({
      mode: key.caps.piiRedaction ?? 'off',
      allowlist: key.caps.piiAllowlist ?? [],
      presidioAnalyzerUrl: process.env.PRESIDIO_ANALYZER_URL,
      log: (event) => console.log(JSON.stringify(event)),
    });
    next();
  };
}

/**
 * The workspace lookup self-serve billing provides (opts.billing.store.workspace), typed by its shape only, so this
 * works before and after billing is part of HostedOptions.
 */
type WorkspaceLookup = { billing?: { store: { workspace(id: string): Promise<{ email: string } | null> } } | null };

/**
 * The monthly limit (monthlyBudgetUsd) this key is held to: it caps what the owner spends, so it applies to
 * owner/internal keys (no workspace) and the admins' own workspaces only. A customer's workspace pays from its own
 * credit (checked by billing) and is never refused because of the owner's spend; nor when its workspace can't be
 * read (billing's own check refuses that).
 */
export async function ownerLimitFor(opts: HostedOptions, key: IssuedKey): Promise<number | null> {
  const limit = opts.monthlyBudgetUsd ?? null;
  if (limit === null || !key.workspaceId) return limit;
  const billing = (opts as HostedOptions & WorkspaceLookup).billing;
  if (!billing) return null;
  try {
    const email = (await billing.store.workspace(key.workspaceId))?.email.trim().toLowerCase() ?? '';
    return email && opts.adminEmails.some((a) => a.trim().toLowerCase() === email) ? limit : null;
  } catch (err) {
    console.error('[hosted] workspace lookup for the monthly limit failed', err);
    return null;
  }
}

/** Turned off: the model asked for, or the one an alias maps it to, matches the blocked list. */
export function isBlocked(opts: HostedOptions, model: string): boolean {
  const blocked = opts.blockedModels ?? [];
  if (!blocked.length) return false;
  const matches = (m: string) => modelAllowed({ models: blocked }, m);
  return matches(model) || matches(resolveModel(opts.aliases, model));
}

function resolveAlias(opts: HostedOptions, model: string): string | null {
  const target = resolveModel(opts.aliases, model);
  return target !== model ? target : null;
}

/**
 * Count a finished request against its key and the monthly spend (never fails the request). The cost uses the price
 * of the model actually used: set by hand, else what its provider publishes (or Leyline's built-in list price, for
 * embeddings), else the default. Without usage from the provider it's estimated (four characters a token): the
 * request body for input (an inline image a fixed estimate, not its base64 length), outChars for output. `usd`, when given, is the cost already worked out (audio is priced
 * by the minute or the character, src/core/media.ts).
 */
export function recordUsage(opts: HostedOptions, req: Request, usage?: { prompt_tokens?: number; completion_tokens?: number }, outChars = 0, usd?: number, media?: MediaChargeBasis): void {
  const r = req as WithKey;
  if (!r.issuedKey && !r.ownerRequest) return;
  const counted = usage && ((usage.prompt_tokens ?? 0) > 0 || (usage.completion_tokens ?? 0) > 0)
    ? usage
    : { prompt_tokens: estimateBodyTokens(req.body), completion_tokens: Math.ceil(outChars / 4) };
  const model = r.requestedModel ?? '';
  // Priced by the model that actually answered (after aliases and routing), credited to the provider that served it.
  const used = r.served?.model || resolveModel(opts.aliases, model);
  const usePublished = opts.usePublishedPrices !== false;
  const published = usePublished
    ? (r.served ? opts.publishedPrice?.(r.served.provider, used) : undefined) ?? opts.anyPublishedPrice?.(used) ?? builtinPrice(used)
    : undefined;
  // One clock for the whole request: a price with peak hours or prompt-length tiers (BytePlus) is made flat once,
  // so the spend line, the charge and any promotion all use the same price.
  const at = Date.now();
  // A workspace's own provider (BYOK) costs Valefront nothing: counted ($0 spend line BYOK:<label>), never charged.
  const byok = servedByByok(r.served?.provider);
  const cost = byok ? 0 : usd ?? costUsd(priceAt(priceOf({ prices: opts.prices ?? {}, defaultPrice: opts.defaultPrice ?? DEFAULT_PRICE }, used, published), counted, at), counted, at);
  const work = opts.keys.record(r.issuedKey ?? null, model, counted, cost, { provider: r.served?.provider ?? 'unknown', model: used })
    .then(() => checkAlerts(opts, r.issuedKey ?? null))
    .catch((err) => console.error('[hosted] usage record failed', err));
  opts.background?.(work);
  // A customer pays real prices only: set by hand or published, never the default price.
  if (r.workspace && opts.billing && !byok) {
    const real = realPrice(opts, used, r.served?.provider);
    const price = real ? priceAt(real, counted, at) : undefined;
    const charged = usd ?? (price ? costUsd(price, counted, at) : null);
    const tokens = (counted.prompt_tokens ?? 0) + (counted.completion_tokens ?? 0);
    // What the request was, so a promotion can price it: chat by its tokens, images and videos by what was made.
    // Priced some other way (audio, by the minute or character): no promotion applies.
    const basis: ChargeBasis | undefined = media ?? (usd === undefined && price ? { kind: 'chat', price, usage: counted } : undefined);
    const key = r.issuedKey ?? null;
    const billing = opts.billing.charge(r.workspace, { model: used, tokens, usd: charged, ...(basis ? { basis } : {}) })
      .then((done) => (done.campaign && done.discountMicros > 0
        ? opts.keys.recordPromotion(key, done.campaign, tokens, done.officialMicros / 1_000_000, done.discountMicros / 1_000_000)
        : undefined))
      .catch((err) => console.error('[hosted] usage charge failed', r.workspace?.id, err));
    opts.background?.(billing);
  }
  if (r.workspace && opts.billing) {
    // PII protection (a paid add-on): its own fee on the input tokens, charged from credit even on free tokens and on
    // the workspace's own providers, and its own spend line. Only when the request's messages were actually redacted
    // (not, say, an embeddings call).
    if (r.pii?.applied) {
      const ws = r.workspace;
      const inputTokens = counted.prompt_tokens ?? 0;
      const addon = opts.billing.chargePiiProtection(ws, inputTokens)
        .then((fee) => opts.keys.recordAddon(r.issuedKey ?? null, { id: PII_ADDON_ID, provider: ADDON_PROVIDER }, fee.tokens, fee.usd))
        .catch((err) => console.error(JSON.stringify({ event: 'pii_fee_failed', workspaceId: ws.id, inputTokens, error: err instanceof Error ? err.message : String(err) })));
      opts.background?.(addon);
    }
  }
}

// ── routing strategies (auto:cheapest / best / fastest / balanced, src/core/routing-strategies.ts) ──────────

/** Benchmarks and the request log, read at most every 10 minutes / every minute for routing strategies. */
const strategyBenchmarks = new Memo<BenchmarkSnapshot | null>(10 * 60_000);
const strategyLogs = new Memo<LogEntry[]>(60_000);

/** Forget the cached benchmarks and request log (tests). */
export function clearStrategyCaches(): void {
  strategyBenchmarks.clear();
  strategyLogs.clear();
}

/**
 * What a routing strategy may pick from for this request: chat models offered here (opts.models, or every model the
 * providers list when none are configured), not blocked, allowed for the key, with a real price, served by a
 * provider that isn't over its monthly budget and reports available; free-tier models only for a customer admitted on
 * free tokens alone. Without hosted mode: every listed model with a published price.
 */
export function strategyEnv(router: Router, opts: HostedOptions | undefined, key: IssuedKey | undefined, excludeProviders: string[] = [], freeTokensOnly = false, byok: WorkspaceByok | null = null, byokOnly = false): StrategyEnv {
  // The workspace's own chat models (BYOK), when its key asks a strategy to pick (Steve: "Auto strategies can route to
  // byok models as well, as long as the user configured it"). Allowed for the key like any model; free to Valefront,
  // so not limited to free-tier models.
  const own = new Set((byok?.models() ?? []).filter((m) => capabilitiesForModel(m).join() === 'chat' && (!key || modelAllowed(key.caps, m))));
  return {
    offered: async () => {
      if (byokOnly) return [...own];
      const pool = opts?.models.length ? opts.models : Object.keys(router.getModelIndex());
      // A customer's key (a dash workspace) gets only models Valefront sells (its public catalog: BytePlus), never a
      // provider Valefront doesn't resell (live 2026-11-06 a strategy picked Workers AI and Azure models). A
      // shared-pool key may also use the providers its owner configured with their own keys (BYOK, Steve).
      return [...pool.filter((m) => !own.has(m) && !m.includes('*') && !isMediaModel(m) && capabilitiesForModel(m).join() === 'chat'
        && (!opts || !key?.workspaceId || isPublicSaleModel(m))
        && (!key || modelAllowed(key.caps, m)) && (!opts || !isBlocked(opts, m))
        // A customer with no balance, on free tokens: free-tier models only (anything else would be charged).
        && (!freeTokensOnly || !opts?.billing || opts.billing.isFreeModel(m))), ...own];
    },
    // Ranked by the price right now (peak hours count); prompt-length tiers aren't known yet, so the base tier. A BYOK
    // model by what its provider publishes (Valefront's own prices are for the pool); unknown: not ranked by price.
    price: (m) => {
      const p = own.has(m) ? router.anyPublishedPrice(m) ?? builtinPrice(m) : opts ? realPrice(opts, m) : router.anyPublishedPrice(m) ?? builtinPrice(m);
      return p ? priceAt(p, undefined) : undefined;
    },
    unpricedOk: (m) => own.has(m),
    served: async (m) => {
      if (own.has(m)) return true;
      for (const provider of await router.chatProvidersFor(m)) {
        if (excludeProviders.includes(provider.name)) continue;
        if (await provider.isAvailable()) return true;
      }
      return false;
    },
    // A workspace's own model: its provider decides what it reads.
    readsImages: (m) => own.has(m) || byteplusChatModelReadsImages(m),
    benchmarkAliases: BYTEPLUS_BENCHMARK_ALIASES,
    ...(opts?.benchmarks ? { benchmarks: () => strategyBenchmarks.get(() => opts.benchmarks!()) } : {}),
    recentLogs: () => strategyLogs.get(() => logger.recent()),
  };
}

/**
 * The routing plan for a chat request (`auto:<strategy>`, or `auto` on a key with a default strategy), or null to
 * route it as today. Throws UnknownStrategyError for an unknown strategy and NoEligibleModelError when nothing fits.
 */
export async function chatRoutePlan(router: Router, opts: HostedOptions | undefined, req: Request, request: CompletionRequest, excludeProviders: string[] = []): Promise<RoutePlan | null> {
  const key = (req as WithKey).issuedKey;
  const strategy = strategyFor(request.model, key?.caps.routingStrategy);
  if (!strategy) return null;
  const r = req as WithKey;
  return planStrategy(strategy, request, strategyEnv(router, opts, key, excludeProviders, r.freeTokensOnly === true, r.byok ?? null, r.byokOnly === true));
}

/** PII protection is on for this key (any mode but off). */
export function piiProtectionOn(key: IssuedKey): boolean {
  return (key.caps.piiRedaction ?? 'off') !== 'off';
}

/** A model's real price (set by hand, published by its provider, or Leyline's built-in list), or undefined. */
export function realPrice(opts: HostedOptions, model: string, provider?: string): Price | undefined {
  const manual = manualPriceOf(opts.prices ?? {}, model);
  if (manual) return manual;
  if (opts.usePublishedPrices === false) return undefined;
  return (provider ? opts.publishedPrice?.(provider, model) : undefined) ?? opts.anyPublishedPrice?.(model) ?? builtinPrice(model);
}

export function isAdminEmail(opts: HostedOptions, email: string): boolean {
  const e = email.trim().toLowerCase();
  return !!e && opts.adminEmails.some((a) => a.trim().toLowerCase() === e);
}

/** Whoever is signed in with Aegis (any account: customers too), or null. */
export function sessionOf(opts: HostedOptions, req: Request): AdminUser | null {
  const s = opts.login?.session(req.headers.cookie);
  return s && s.email ? s : null;
}

function alertsFor(opts: HostedOptions): CostAlerts {
  return new CostAlerts(opts.keys.docs, opts.keys);
}

function alertContext(opts: HostedOptions) {
  const settings = opts.alerts ?? DEFAULT_ALERTS;
  return { to: settings.emails.length ? settings.emails : opts.adminEmails, publicUrl: opts.publicUrl, adminUrl: opts.adminHost ? `https://${opts.adminHost}` : undefined };
}

/** After a request is counted: alert on thresholds newly crossed (never fails the request). */
async function checkAlerts(opts: HostedOptions, key: IssuedKey | null): Promise<void> {
  try {
    const fired = await alertsFor(opts).check(opts.alerts ?? DEFAULT_ALERTS, opts.monthlyBudgetUsd ?? null, key, alertContext(opts), { sendEmail: opts.sendEmail });
    for (const a of fired) console.log(JSON.stringify({ event: 'cost_alert', id: a.id, usd: a.usd, limitUsd: a.limitUsd, delivery: a.delivery }));
  } catch (err) {
    console.error('[hosted] cost alert check failed', err);
  }
}

/**
 * Middleware: an admin whose session cookie ran out but who still has Aegis's refresh token gets a fresh
 * session before anything checks who they are (adminOf reads cookies synchronously).
 */
export function resumeAdminSession(opts: HostedOptions) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const login = opts.login;
    if (!login || !req.headers.cookie?.includes('leyline_refresh=')) return next();
    const resumed = await login.resume(req.headers.cookie);
    if (resumed && 'clear' in resumed) {
      res.append('Set-Cookie', cookie('leyline_refresh', '', 0));
    } else if (resumed) {
      for (const c of resumed.cookies) res.append('Set-Cookie', c);
      // This request already counts as signed in: put the fresh session in its cookie header.
      const jar = cookies(req.headers.cookie);
      jar['leyline_session'] = decodeURIComponent(resumed.cookies[0].split(';')[0].slice('leyline_session='.length));
      req.headers.cookie = Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    }
    next();
  };
}

/** This month's spend by provider, read at most every 15 s (a D1 read when hosted), per HostedOptions. */
const providerSpendCache = new WeakMap<HostedOptions, { at: number; byProvider: Record<string, number> }>();
const PROVIDER_SPEND_TTL_MS = 15_000;

/**
 * Providers at their monthly spend limit (providerBudgetsUsd): the router skips them, so their requests go to
 * another provider serving the model, or get a 429 when there's none. A read failure blocks nobody.
 */
export async function providersOverBudget(opts: HostedOptions, now = Date.now()): Promise<string[]> {
  const budgets = opts.providerBudgetsUsd ?? {};
  if (Object.keys(budgets).length === 0) return [];
  let cached = providerSpendCache.get(opts);
  if (!cached || now - cached.at > PROVIDER_SPEND_TTL_MS) {
    try {
      const spend = await opts.keys.spend();
      const byProvider: Record<string, number> = {};
      for (const [name, line] of Object.entries(spend.byProvider ?? {})) byProvider[name] = line.usd;
      cached = { at: now, byProvider };
      providerSpendCache.set(opts, cached);
    } catch (err) {
      console.error('[hosted] provider spend read failed', err);
      return [];
    }
  }
  return Object.entries(budgets).filter(([name, limit]) => (cached!.byProvider[name] ?? 0) >= limit).map(([name]) => name);
}

/** Who is managing this Leyline: their email (Aegis session), 'token' (LEYLINE_ADMIN_TOKEN), or null. */
export function adminOf(opts: HostedOptions, req: Request): string | null {
  const auth = req.headers.authorization;
  if (opts.adminToken && auth?.startsWith('Bearer ')) {
    const a = Buffer.from(auth.slice(7).trim());
    const b = Buffer.from(opts.adminToken);
    if (a.length === b.length && timingSafeEqual(a, b)) return 'token';
  }
  // With a platform admin host (adm.valefront.com), the owner manages Valefront only there, through Cloudflare
  // Access: dash.valefront.com is the customers' dashboard, and an admin signed in there is a customer like anyone.
  const viaAccess = accessAdminOf(req);
  if (viaAccess) return viaAccess;
  if (opts.adminHost) return null;
  const s = opts.login?.session(req.headers.cookie);
  return s && opts.adminEmails.includes(s.email.toLowerCase()) ? s.email : null;
}

export function sameOrigin(opts: HostedOptions, req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;

  const normalizeOrigin = (value: string): string => {
    try {
      return new URL(value).origin;
    } catch {
      return value.replace(/\/+$/, '');
    }
  };

  const accepted = [opts.publicUrl, ...(opts.publicAliases ?? []), ...(opts.adminHost ? [`https://${opts.adminHost}`] : [])].map(normalizeOrigin);
  return accepted.includes(normalizeOrigin(origin));
}

/** What a key looks like to the admin page (never the hash). */
function view(k: IssuedKey & { usage?: unknown }) {
  const { hash: _hash, ...rest } = k;
  return rest;
}

export function applySettings(opts: HostedOptions, s: HostedSettings): void {
  opts.models = s.models;
  opts.aliases = s.aliases;
  // Settings saved before the spending limit existed keep the configured limit.
  if ('monthlyBudgetUsd' in s) opts.monthlyBudgetUsd = s.monthlyBudgetUsd;
  opts.providerBudgetsUsd = s.providerBudgetsUsd ?? opts.providerBudgetsUsd ?? {};
  opts.blockedModels = s.blockedModels ?? opts.blockedModels ?? [];
  opts.prices = s.prices ?? opts.prices ?? {};
  opts.defaultPrice = s.defaultPrice ?? opts.defaultPrice ?? DEFAULT_PRICE;
  opts.usePublishedPrices = s.usePublishedPrices ?? opts.usePublishedPrices ?? true;
  opts.alerts = s.alerts ?? opts.alerts ?? DEFAULT_ALERTS;
  opts.settingsSaved = s.updatedAt ? { at: s.updatedAt, by: s.updatedBy ?? '' } : null;
}

async function settingsView(opts: HostedOptions) {
  return {
    models: opts.models,
    aliases: opts.aliases,
    blockedModels: opts.blockedModels ?? [],
    monthlyBudgetUsd: opts.monthlyBudgetUsd ?? null,
    providerBudgetsUsd: opts.providerBudgetsUsd ?? {},
    prices: opts.prices ?? {},
    defaultPrice: opts.defaultPrice ?? DEFAULT_PRICE,
    usePublishedPrices: opts.usePublishedPrices !== false,
    publishedPrices: opts.publishedPriceCounts?.() ?? {},
    alerts: opts.alerts ?? DEFAULT_ALERTS,
    alertEmailAvailable: Boolean(opts.sendEmail),
    adminEmails: opts.adminEmails,
    spend: await opts.keys.spend(),
    saved: opts.settingsSaved ?? null,
    publicUrl: opts.publicUrl,
  };
}

/** Load the dashboard-saved models/aliases now and every minute (other instances may change them). */
export function watchSettings(opts: HostedOptions, everyMs = 60_000): () => void {
  const load = () => opts.keys.settings().then((s) => { if (s) applySettings(opts, s); }).catch((err) => console.error('[hosted] settings load failed', err));
  void load();
  const t = setInterval(load, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}

export function mountHosted(app: Express, router: Router, opts: HostedOptions): void {
  opts.publishedPrice ??= (provider, model) => router.publishedPrice(provider, model);
  opts.publishedPriceCounts ??= () => router.publishedPriceCounts();
  opts.anyPublishedPrice ??= (model) => router.anyPublishedPrice(model);
  // ── models ──────────────────────────────────────────────────────────────────────────────────────────
  app.get('/v1/models', requireIssuedKeyNoModel(opts), async (req, res) => {
    const key = (req as WithKey).issuedKey!;
    // An empty configured pool means "everything the providers currently serve", not "nothing".
    // Refresh stale provider listings here as a safety net for Node and cold Worker instances.
    if (opts.models.length === 0) await router.reindexStale();
    const configured = [...opts.models, ...Object.keys(opts.aliases).filter((a) => !a.includes('*'))];
    const providerModels = opts.models.length === 0 ? Object.keys(router.getModelIndex()) : [];
    // A workspace key also sees its workspace's own models (BYOK), which the host's blocked list doesn't cover.
    const byok = (req as WithKey).byok;
    const own = byok?.models() ?? [];
    const ids = [...configured, ...providerModels, ...own].filter((m, i, all) => all.indexOf(m) === i && modelAllowed(key.caps, m) && (byok?.has(m) || !isBlocked(opts, m)));
    const capability = typeof req.query.capability === 'string' ? req.query.capability : undefined;
    const snapshot = await opts.benchmarks?.();
    const data = ids.map((id) => {
      const benchmarks = Object.fromEntries((snapshot?.benchmarks ?? []).map((benchmark) => [
        benchmark.id,
        benchmark.scores.find((score) => score.leylineModel === id || score.model === id) ?? null,
      ]));
      return {
        id,
        object: 'model',
        created: 0,
        owned_by: byok?.has(id) ? 'byok' : 'leyline',
        type: 'model',
        display_name: id,
        capabilities: capabilitiesForModel(id),
        benchmarks,
      };
    }).filter((model) => !capability || model.capabilities.includes(capability));
    res.json({ object: 'list', data });
  });

  app.get('/v1/benchmarks', async (req, res, next) => {
    // Dashboard admins may view benchmarks from the same-origin dashboard session;
    // API clients continue through issued-key authorization.
    if (adminOf(opts, req) && sameOrigin(opts, req)) return next();
    return requireIssuedKeyNoModel(opts)(req, res, next);
  }, async (_req, res) => {
    const snapshot = await opts.benchmarks?.();
    res.json(snapshot ?? { fetchedAt: null, benchmarks: [] });
  });

  // ── Anthropic Messages (Claude Code: ANTHROPIC_BASE_URL) ───────────────────────────────────────────
  app.post('/v1/messages/count_tokens', requireIssuedKeyNoModel(opts, 'anthropic'), (req, res) => {
    res.json({ input_tokens: estimateTokens(req.body as AnthropicRequest) });
  });

  app.post('/v1/messages', requireIssuedKey(opts, 'anthropic'), async (req, res) => {
    let request;
    try {
      request = anthropicToOpenAI(req.body as AnthropicRequest);
    } catch (err) {
      return res.status(400).json(anthropicError(400, err instanceof Error ? err.message : String(err)));
    }
    const asked = request.model;
    request.model = requestModel(opts, req, asked);
    const pii = (req as WithKey).pii;
    if (pii) request = await pii.redact(request);
    const excludeProviders = await providersOverBudget(opts);
    const via = routerFor(router, req);
    let plan: RoutePlan | null;
    try {
      plan = await chatRoutePlan(router, opts, req, request, excludeProviders);
    } catch (err) {
      const refused = strategyErrorResponse(err);
      if (!refused) console.error('[hosted] /v1/messages routing plan failed', err);
      const status = refused?.status ?? 503;
      return res.status(status).json(anthropicError(status, refused?.body.error.message ?? 'Valefront could not pick a model just now; try again.'));
    }
    const routeOpts = { onServed: servedBy(req), excludeProviders };
    const setRoute = (model: string) => { if (plan && !res.headersSent) res.setHeader('X-Valefront-Route', routeHeader(plan, model)); };
    try {
      if (request.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const out = new AnthropicStream(asked);
        const send = (events: Array<{ event: string; data: unknown }>) => {
          for (const e of events) res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
        };
        try {
          const stream = plan ? streamByPlan(via, request, plan, routeOpts, setRoute) : via.routeStream(request, routeOpts);
          for await (const chunk of stream) {
            if (pii) {
              for (const [choiceIndex, choice] of (chunk.choices ?? []).entries() as Iterable<[number, { delta?: { content?: string | null; tool_calls?: Array<{ function?: { arguments?: string } }> } }]>) {
                if (choice.delta?.content) choice.delta.content = pii.rehydrateStream(choice.delta.content, `choice:${choiceIndex}:content`);
                for (const [toolIndex, call] of (choice.delta?.tool_calls ?? []).entries()) {
                  if (call.function?.arguments) call.function.arguments = pii.rehydrateStream(call.function.arguments, `choice:${choiceIndex}:tool:${toolIndex}`);
                }
              }
            }
            send(out.push(chunk));
          }
          if (pii) {
            for (const key of pii.streamKeys) {
              const tail = pii.finishStream(key);
              if (!tail) continue;
              const match = /^choice:(\d+):(content|tool:(\d+))$/.exec(key);
              if (!match) continue;
              const choiceIndex = Number(match[1]);
              if (match[2] === 'content') {
                send([{
                  event: 'content_block_delta',
                  data: {
                    type: 'content_block_delta',
                    index: choiceIndex,
                    delta: { type: 'text_delta', text: tail },
                  },
                }]);
              } else {
                send([{
                  event: 'content_block_delta',
                  data: {
                    type: 'content_block_delta',
                    index: Number(match[3]),
                    delta: { type: 'input_json_delta', partial_json: tail },
                  },
                }]);
            }
          }
        }
          send(out.end());
        } catch (err) {
          console.error('[hosted] /v1/messages stream failed', err);
          // Nothing sent yet and the request itself can't be served (images no provider can read): say so.
          if (!res.headersSent && errorStatus(err) === 400) return res.status(400).type('json').json(anthropicError(400, err instanceof Error ? err.message : String(err)));
          res.write(`event: error\ndata: ${JSON.stringify(anthropicError(502, 'The Valefront model provider failed; try again.'))}\n\n`);
        }
        res.end();
        recordUsage(opts, req, out.tokens, out.chars);
        return;
      }
      const response = plan ? await routeByPlan(via, request, plan, routeOpts, setRoute) : await via.route(request, routeOpts);
      const hydrated = pii ? { ...response, choices: response.choices?.map((choice) => ({
        ...choice,
        message: choice.message ? {
          ...choice.message,
          content: typeof choice.message.content === 'string' ? pii.rehydrate(choice.message.content) : choice.message.content,
          tool_calls: choice.message.tool_calls?.map((call) => ({
            ...call,
            function: call.function ? { ...call.function, arguments: pii.rehydrate(call.function.arguments ?? '') } : call.function,
          })),
        } : choice.message,
      })) } : response;
      if (pii) { await pii.finish(); }
      res.json(openAIToAnthropic(hydrated, asked));
      recordUsage(opts, req, response.usage);
    } catch (err) {
      console.error('[hosted] /v1/messages failed', err);
      if (!res.headersSent && errorStatus(err) === 400) return res.status(400).type('json').json(anthropicError(400, err instanceof Error ? err.message : String(err)));
      if (!res.headersSent) res.status(502).json(anthropicError(502, 'The Valefront model provider failed; try again.'));
    }
  });

  // ── admin sign-in ───────────────────────────────────────────────────────────────────────────────────
  const login = opts.login;
  if (login) {
    app.get('/auth/login', async (req, res) => {
      try {
        const redirectUri = opts.redirectUriForRequest?.(req);
        const { url, cookie: c } = await login.start(typeof req.query.next === 'string' ? req.query.next : '/dashboard/', { switchAccount: req.query.switch === '1', ...(redirectUri ? { redirectUri } : {}) });
        res.setHeader('Set-Cookie', c);
        res.redirect(302, url);
      } catch (err) {
        res.status(502).send(`Sign-in is unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    app.get('/auth/callback', async (req, res) => {
      try {
        const done = await login.finish(new URLSearchParams(req.url.split('?')[1] ?? ''), req.headers.cookie);
        // Sign-in is self-serve: every Aegis account may enter the dashboard (its own workspace). The owner's pages
        // and APIs stay behind adminOf (adminEmails or the admin token).
        res.setHeader('Set-Cookie', [...done.cookies, cookie('leyline_login', '', 0)]);
        res.redirect(302, done.next);
      } catch (err) {
        res.status(400).send(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    // Clearing our cookies alone signed people straight back in: Aegis still had its session (Steve, 2026-11-05,
    // "valefront dash can't logout"). The page goes on to Aegis's sign-out page, which ends that session too.
    app.post('/auth/logout', (_req, res) => {
      res.setHeader('Set-Cookie', [cookie('leyline_session', '', 0), cookie('leyline_refresh', '', 0)]);
      res.status(200).json({ next: login.endSessionUrl() });
    });
  }

  // ── admin: the page and the key API ─────────────────────────────────────────────────────────────────
  app.get('/admin', (_req, res) => res.redirect(302, opts.adminHost ? `https://${opts.adminHost}/#/keys` : '/dashboard/#/keys'));

  const guard = (req: Request, res: Response, next: NextFunction) => {
    const who = adminOf(opts, req);
    if (!who) return res.status(401).json({ error: 'admin_only' });
    if (req.method !== 'GET' && who !== 'token' && !sameOrigin(opts, req)) return res.status(403).json({ error: 'forbidden' });
    (req as Request & { admin?: string }).admin = who;
    next();
  };
  // Promotions: the Campaigns page (admin-campaigns.ts).
  mountAdminCampaigns(app, opts, guard);
  app.get('/admin/api/settings', guard, async (_req, res) => {
    res.json(await settingsView(opts));
  });
  app.put('/admin/api/settings', guard, async (req, res) => {
    try {
      // A save changes only what it names; the rest stays as it is.
      const current = { models: opts.models, aliases: opts.aliases, blockedModels: opts.blockedModels ?? [], monthlyBudgetUsd: opts.monthlyBudgetUsd ?? null, providerBudgetsUsd: opts.providerBudgetsUsd ?? {}, prices: opts.prices ?? {}, defaultPrice: opts.defaultPrice ?? DEFAULT_PRICE, usePublishedPrices: opts.usePublishedPrices !== false, alerts: opts.alerts ?? DEFAULT_ALERTS };
      const saved = await opts.keys.saveSettings({ ...current, ...(req.body as Partial<HostedSettings>) }, (req as Request & { admin?: string }).admin!);
      applySettings(opts, saved);
      console.log(JSON.stringify({ event: 'settings_saved', by: saved.updatedBy, models: saved.models, aliases: saved.aliases, monthlyBudgetUsd: saved.monthlyBudgetUsd }));
      res.json(await settingsView(opts));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  // Cost alerts: this month's (or another month's) log, and a test through every channel.
  app.get('/admin/api/alerts', guard, async (req, res) => {
    const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : undefined;
    res.json({ log: await alertsFor(opts).log(month), settings: opts.alerts ?? DEFAULT_ALERTS, emailAvailable: Boolean(opts.sendEmail), to: alertContext(opts).to });
  });
  app.post('/admin/api/alerts/test', guard, async (_req, res) => {
    const work = alertsFor(opts).test(opts.alerts ?? DEFAULT_ALERTS, alertContext(opts), { sendEmail: opts.sendEmail });
    opts.background?.(work);
    res.json({ alert: await work });
  });

  // Spend by provider and model for a month (default: this one), and which months have any.
  app.get('/admin/api/spend', guard, async (req, res) => {
    const month = typeof req.query.month === 'string' && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : undefined;
    const keyId = typeof req.query.key === 'string' ? req.query.key : undefined;
    if (keyId) {
      const key = await opts.keys.get(keyId);
      if (!key) return res.status(404).json({ error: 'key_not_found' });
      const [usage, months] = await Promise.all([opts.keys.usage(keyId, month), opts.keys.spendMonths()]);
      const spend = {
        month: usage.month,
        usd: usage.usd ?? 0,
        requests: usage.requests,
        tokens: usage.promptTokens + usage.completionTokens,
        byProvider: usage.byProvider,
        byModel: usage.byServed,
        byDay: usage.byDay,
        promotions: usage.promotions,
      };
      return res.json({ spend, months, monthlyBudgetUsd: opts.monthlyBudgetUsd ?? null, key: { id: key.id, name: key.name } });
    }
    const [spend, months] = await Promise.all([opts.keys.spend(month), opts.keys.spendMonths()]);
    res.json({ spend, months, monthlyBudgetUsd: opts.monthlyBudgetUsd ?? null });
  });
  // Correct dollars recorded at a wrong price (src/core/spend-reprice.ts). A dry run unless dryRun is false.
  app.post('/admin/api/spend/reprice', guard, async (req, res) => {
    try {
      const by = (req as Request & { admin?: string }).admin!;
      const result = await repriceSpend(opts.keys.docs, req.body, { by });
      if (!result.dryRun) console.log(JSON.stringify({ event: 'spend_repriced', by, id: result.adjustmentId, month: result.month, provider: result.provider, model: result.model, ratio: result.ratio, usdDelta: result.usdDelta, alreadyApplied: result.alreadyApplied }));
      res.json(result);
    } catch (err) {
      if (err instanceof RepriceRefused) return res.status(err.status).json({ error: err.message });
      console.error('[hosted] spend reprice failed', err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  // adm manages the shared pool only: customers' keys belong to their workspaces (dash), never listed here.
  app.get('/admin/api/keys', guard, async (req, res) => {
    const all = (await opts.keys.list()).map(view);
    res.json({ keys: req.query.all === '1' ? all : all.filter((k) => !k.workspaceId) });
  });
  app.post('/admin/api/keys', guard, async (req, res) => {
    try {
      const { key, record } = await opts.keys.create({ name: String(req.body?.name ?? ''), caps: (req.body?.caps ?? {}) as KeyCaps, note: typeof req.body?.note === 'string' ? req.body.note : undefined, by: (req as Request & { admin?: string }).admin! });
      console.log(JSON.stringify({ event: 'key_created', id: record.id, name: record.name, by: record.createdBy, caps: record.caps }));
      res.status(201).json({ key, record: view(record) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.patch('/admin/api/keys/:id', guard, async (req, res) => {
    try {
      const record = await opts.keys.setCaps(String(req.params.id), (req.body?.caps ?? {}) as KeyCaps);
      res.json({ record: view(record) });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  // A key put on an admin's workspace goes back to the shared pool (only for admins' own workspaces' keys).
  app.post('/admin/api/keys/:id/pool', guard, async (req, res) => {
    const billing = (opts as HostedOptions & WorkspaceLookup).billing;
    try {
      const cur = (await opts.keys.list()).find((k) => k.id === String(req.params.id));
      if (!cur) return res.status(404).json({ error: 'no such key' });
      if (cur.workspaceId) {
        const ws = billing ? await billing.store.workspace(cur.workspaceId) : null;
        if (!ws || !isAdminEmail(opts, ws.email)) return res.status(403).json({ error: "a customer's key stays with its workspace" });
      }
      const record = await opts.keys.returnToPool(cur.id);
      console.log(JSON.stringify({ event: 'key_returned_to_pool', id: record.id, by: (req as Request & { admin?: string }).admin }));
      res.json({ record: view(record) });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  // ── workspaces' own providers (BYOK), seen from adm ──────────────────────────────────────────────────
  // Find a workspace (the owner's, to move the pool's non-BytePlus providers into it), with its providers.
  app.get('/admin/api/workspaces', guard, async (req, res) => {
    const email = typeof req.query.email === 'string' ? req.query.email.trim() : '';
    if (!email) return res.status(400).json({ error: 'send ?email=<address>' });
    if (!opts.billing) return res.status(503).json({ error: 'billing_unavailable' });
    const found = await opts.billing.store.workspacesByEmail(email);
    const workspaces = await Promise.all(found.map(async (ws) => ({
      id: ws.id, email: ws.email, createdAt: ws.createdAt, deletedAt: ws.deletedAt ?? null, suspendedAt: ws.suspendedAt ?? null,
      admin: isAdminEmail(opts, ws.email),
      keys: (await opts.keys.listForWorkspace(ws.id)).filter((k) => !k.revokedAt).map((k) => ({ id: k.id, name: k.name, prefix: k.prefix })),
      providers: opts.workspaceProviders ? await opts.workspaceProviders.list(ws.id) : [],
    })));
    res.json({ workspaces });
  });
  app.get('/admin/api/workspaces/:workspaceId/providers', guard, async (req, res) => {
    if (!opts.workspaceProviders) return res.status(503).json({ error: 'workspace_providers_unavailable' });
    res.json({ providers: await opts.workspaceProviders.list(String(req.params.workspaceId)) });
  });
  /**
   * Copy a shared-pool provider (its key, base URL and deployment, read server-side) into a workspace as that
   * workspace's own provider: { provider: "<pool provider name>", models?: [...], label? }. The key is never returned.
   * The pool provider stays as it is; take it out of the pool separately, once the workspace's keys use the copy.
   */
  app.post('/admin/api/workspaces/:workspaceId/providers/from-pool', guard, async (req, res) => {
    const workspaces = opts.workspaceProviders;
    if (!workspaces || !opts.billing || !opts.poolProvider) return res.status(503).json({ error: 'workspace_providers_unavailable' });
    const workspaceId = String(req.params.workspaceId);
    const name = typeof req.body?.provider === 'string' ? req.body.provider.trim() : '';
    if (!name) return res.status(400).json({ error: 'send { "provider": "<pool provider name>" }' });
    try {
      const ws = await opts.billing.store.workspace(workspaceId);
      if (!ws || ws.deletedAt) return res.status(404).json({ error: 'workspace_not_found' });
      const pool = await opts.poolProvider(name);
      if (!pool) return res.status(404).json({ error: `no pool provider "${name}" of a kind a workspace can have (Azure OpenAI, OpenAI-compatible, Anthropic)` });
      if (!pool.apiKey) return res.status(409).json({ error: `pool provider "${name}" has no API key loaded` });
      const models = req.body?.models !== undefined ? req.body.models : pool.models;
      const label = typeof req.body?.label === 'string' && req.body.label.trim() ? req.body.label : name.slice(0, 40);
      const by = (req as Request & { admin?: string }).admin!;
      const saved = await workspaces.add(workspaceId, { kind: pool.kind, label, baseUrl: pool.baseUrl, deployment: pool.deployment, apiVersion: pool.apiVersion, models, apiKey: pool.apiKey }, by);
      console.log(JSON.stringify({ event: 'workspace_provider_from_pool', workspaceId, pool: name, id: saved.id, label: saved.label, models: saved.models, by }));
      await opts.billing.store.audit({ type: 'workspace_provider.added', workspaceId, meta: { id: saved.id, label: saved.label, kind: saved.kind, fromPool: name, by } });
      res.status(201).json({ provider: saved });
    } catch (err) {
      if (err instanceof WorkspaceProviderError) return res.status(err.status).json({ error: err.message, code: err.code });
      console.error('[hosted] from-pool copy failed', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'copy failed' });
    }
  });

  app.delete('/admin/api/keys/:id', guard, async (req, res) => {
    try {
      const record = await opts.keys.revoke(String(req.params.id));
      console.log(JSON.stringify({ event: 'key_revoked', id: record.id, by: (req as Request & { admin?: string }).admin }));
      res.json({ record: view(record) });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** The key check for endpoints with no model in the body (models list, token counting). */
function requireIssuedKeyNoModel(opts: HostedOptions, format: 'openai' | 'anthropic' = 'openai') {
  const check = requireIssuedKey(opts, format);
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' || !req.body || typeof req.body.model !== 'string') return check(req, res, next);
    const model = req.body.model;
    req.body.model = '';
    return check(req, res, (err?: unknown) => {
      req.body.model = model;
      next(err);
    });
  };
}

export type { AdminUser };
