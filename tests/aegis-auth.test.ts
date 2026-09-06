import request from 'supertest';
import express from 'express';
import * as jose from 'jose';
import { createRequireAegisToken } from '../src/core/aegis-auth';
import { QuotaManager } from '../src/core/quota-manager';

const ISSUER = 'https://leyline-test.id.theaiinc.com';
const AUDIENCE = 'leyline';
const KID = 'test-key';

async function buildApp(overrides: { defaultRequestsPerMinute?: number; defaultRequestsPerDay?: number } = {}) {
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256', { extractable: true });
  const publicJwk = await jose.exportJWK(publicKey);
  const jwks = jose.createLocalJWKSet({ keys: [{ ...publicJwk, kid: KID, alg: 'RS256', use: 'sig' }] });
  const quota = new QuotaManager();

  const middleware = createRequireAegisToken({
    jwks,
    issuer: ISSUER,
    audience: AUDIENCE,
    quota,
    defaultRequestsPerMinute: overrides.defaultRequestsPerMinute ?? 2,
    defaultRequestsPerDay: overrides.defaultRequestsPerDay ?? 100,
  });

  const app = express();
  app.get('/protected', middleware, (req, res) => {
    res.json({ ok: true, tenant: (req as express.Request & { tenant?: { clientId: string } }).tenant });
  });

  const sign = async (claims: Record<string, unknown>, opts: { issuer?: string; audience?: string; key?: CryptoKey; expiresIn?: string } = {}) =>
    new jose.SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(opts.issuer ?? ISSUER)
      .setAudience(opts.audience ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(opts.expiresIn ?? '1h')
      .sign(opts.key ?? privateKey);

  return { app, sign };
}

const serviceAccountClaims = { service_account: true, requester_client_id: 'dependent-app' };

describe('requireAegisToken', () => {
  it('accepts a valid service-to-service token and attaches the tenant', async () => {
    const { app, sign } = await buildApp();
    const token = await sign(serviceAccountClaims);

    const response = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.tenant).toEqual({ clientId: 'dependent-app' });
  });

  it('rejects a missing bearer token', async () => {
    const { app } = await buildApp();

    const response = await request(app).get('/protected');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('invalid_api_key');
  });

  it('rejects a token signed by an untrusted key', async () => {
    const { app } = await buildApp();
    const { privateKey: otherKey } = await jose.generateKeyPair('RS256', { extractable: true });
    const token = await new jose.SignJWT(serviceAccountClaims)
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(otherKey);

    const response = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
  });

  it('rejects a token with the wrong audience', async () => {
    const { app, sign } = await buildApp();
    const token = await sign(serviceAccountClaims, { audience: 'someone-else' });

    const response = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
  });

  it('rejects a token that is not a service_account credential', async () => {
    const { app, sign } = await buildApp();
    const token = await sign({ requester_client_id: 'dependent-app', act: { sub: 'user-1' } });

    const response = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
  });

  it('rejects a token missing requester_client_id', async () => {
    const { app, sign } = await buildApp();
    const token = await sign({ service_account: true });

    const response = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(401);
  });

  it('rate-limits per tenant once the default quota is exceeded', async () => {
    const { app, sign } = await buildApp({ defaultRequestsPerMinute: 1, defaultRequestsPerDay: 100 });
    const token = await sign(serviceAccountClaims);

    const first = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);
    const second = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('rate_limit_exceeded');
  });
});
