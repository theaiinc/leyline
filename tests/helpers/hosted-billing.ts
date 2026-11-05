import { createSign, generateKeyPairSync } from 'crypto';
import { createServer } from '../../src/server';
import { Router } from '../../src/core/router';
import { QuotaManager } from '../../src/core/quota-manager';
import { ModelRegistry } from '../../src/core/model-registry';
import { IssuedKeys, MemoryDocStore } from '../../src/core/issued-keys';
import { MemorySecretStore } from '../../src/core/secret-store';
import { AegisAuth, sign } from '../../src/core/admin-login';
import type { HostedOptions } from '../../src/core/hosted';
import type { BillingServiceOptions } from '../../src/core/billing-service';
import type { CompletionRequest, CompletionResponse, Provider, StreamChunk } from '../../src/core/types';
import { billingFixture } from './billing-fixture';

class Upstream implements Provider {
  name = 'Fake';
  defaultModel = 'seed-2-0-lite-260428';
  seen: CompletionRequest[] = [];
  async isAvailable() { return true; }
  async getModels() { return [{ id: 'seed-2-0-lite-260428' }, { id: 'gpt-5.5' }, { id: 'unpriced-model' }]; }
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.seen.push(req);
    return { id: 'c1', object: 'chat.completion', created: 1, model: req.model, choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 } };
  }
  async *completeStream(req: CompletionRequest): AsyncGenerator<StreamChunk> {
    this.seen.push(req);
    yield { id: 's', object: 'chat.completion.chunk', created: 1, model: req.model, choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: 'stop' }] };
  }
}

export const SESSION_SECRET = 'test-session-secret';
export const ORIGIN = 'https://dash.valefront.com';

export function cookieFor(sub: string, email: string, emailVerified = true): string {
  return `leyline_session=${sign({ sub, email, emailVerified, exp: Math.floor(Date.now() / 1000) + 3600 }, SESSION_SECRET)}`;
}

/** Cloudflare Access for tests: a key pair, its certs endpoint, and tokens it signs. */
export function fakeAccess() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
  const teamDomain = 'https://theaiinc.cloudflareaccess.com';
  const aud = 'aud-tag-123';
  const token = (claims: Record<string, unknown>, opts: { kid?: string } = {}) => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ iss: teamDomain, aud: [aud], exp: Math.floor(Date.now() / 1000) + 600, ...claims })).toString('base64url');
    const s = createSign('RSA-SHA256').update(`${header}.${body}`).sign(privateKey).toString('base64url');
    return `${header}.${body}.${s}`;
  };
  const fetchImpl = (async (url: string | URL) => {
    if (String(url) === `${teamDomain}/cdn-cgi/access/certs`) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    return new Response('', { status: 404 });
  }) as typeof fetch;
  return { config: { teamDomain, aud, serviceTokenIds: ['svc-1.access'], fetchImpl }, token };
}

export function hostedBilling(over: { hosted?: Partial<HostedOptions>; billing?: Partial<BillingServiceOptions> } = {}) {
  const quotaManager = new QuotaManager();
  const router = new Router({ quotaManager, modelRegistry: new ModelRegistry() });
  const upstream = new Upstream();
  router.addProvider(upstream);
  const keys = new IssuedKeys(new MemoryDocStore());
  const fx = billingFixture({ isAdminWorkspace: (w) => w.email === 'owner@valefront.com', ...over.billing });
  const login = new AegisAuth({ issuer: 'https://id.example', clientId: 'c', clientSecret: 's', redirectUri: `${ORIGIN}/auth/callback`, sessionSecret: SESSION_SECRET });
  const turnstile = { tokens: new Set(['ok-token']), calls: 0 };
  const access = fakeAccess();
  const hosted: HostedOptions = {
    keys,
    models: ['seed-2-0-lite-260428', 'gpt-5.5', 'unpriced-model'],
    aliases: {},
    login,
    adminEmails: ['owner@valefront.com'],
    adminToken: 'admin-secret-token',
    publicUrl: 'https://llm.valefront.com',
    publicAliases: [ORIGIN],
    // Real prices for two models; "unpriced-model" has none; no published prices in tests.
    prices: { 'seed-2-0-lite-260428': { input: 1, output: 2 }, 'gpt-5.5': { input: 5, output: 15 } },
    usePublishedPrices: false,
    billing: fx.service,
    turnstile: { siteKey: 'site-key', verify: async (token) => { turnstile.calls++; return turnstile.tokens.has(token); } },
    adminHost: 'adm.valefront.com',
    access: access.config,
    providerEnv: { PAYPAL_LIVE_CLIENT_ID: 'x', PAYPAL_LIVE_CLIENT_SECRET: 'super-secret-value', PAYPAL_LIVE_WEBHOOK_ID: 'wh' },
    background: (work) => { pending.push(work); },
    ...over.hosted,
  };
  const pending: Promise<unknown>[] = [];
  const app = createServer(router, quotaManager, { hosted, enforceExternalSurface: false, apiKeyStore: new MemorySecretStore() });
  const settle = async () => { while (pending.length) await Promise.allSettled(pending.splice(0)); };
  return { app, keys, upstream, hosted, turnstile, access, settle, ...fx };
}
