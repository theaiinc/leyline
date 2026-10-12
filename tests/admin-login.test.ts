import { generateKeyPairSync, sign as cryptoSign } from 'crypto';
import { AegisAuth, cookies, seal, sign, unseal } from '../src/core/admin-login';

const SECRET = 'test-session-secret';
const ISSUER = 'https://id.example';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256' };

function idToken(claims: Record<string, unknown>): string {
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const head = `${b64({ alg: 'ES256', kid: 'k1' })}.${b64({ iss: ISSUER, aud: 'leyline-dashboard', exp: Math.floor(Date.now() / 1000) + 300, ...claims })}`;
  return `${head}.${cryptoSign('sha256', Buffer.from(head), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

/** A fake Aegis whose token endpoint answers with `token` (status, body), recording what it was sent. */
function fakeAegis(token: { status: number; body?: unknown }) {
  const sent: URLSearchParams[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/.well-known/openid-configuration')) {
      return json(200, { issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` });
    }
    if (url === `${ISSUER}/jwks`) return json(200, { keys: [jwk] });
    if (url === `${ISSUER}/token`) {
      sent.push(new URLSearchParams(String(init?.body)));
      return json(token.status, token.body ?? { error: 'invalid_grant' });
    }
    return json(404, {});
  }) as typeof fetch;
  const auth = new AegisAuth({ issuer: ISSUER, clientId: 'leyline-dashboard', clientSecret: 's', redirectUri: 'https://leyline.test/auth/callback', sessionSecret: SECRET, fetchImpl });
  return { auth, sent };
}

const refreshCookie = (token: string) => `leyline_refresh=${encodeURIComponent(seal(token, SECRET))}`;

describe('staying signed in', () => {
  it('asks Aegis for a refresh token, and keeps it when switching accounts', async () => {
    const { auth } = fakeAegis({ status: 200 });
    const plain = new URL((await auth.start('/dashboard/')).url);
    expect(plain.searchParams.get('scope')).toBe('openid email profile offline_access');
    expect(plain.searchParams.get('prompt')).toBeNull();
    const switching = new URL((await auth.start('/dashboard/', { switchAccount: true })).url);
    expect(switching.searchParams.get('prompt')).toBe('login consent');
  });

  it('seals the refresh token: unreadable, and tampering is refused', () => {
    const sealed = seal('rt-secret', SECRET);
    expect(sealed).not.toContain('rt-secret');
    expect(unseal(sealed, SECRET)).toBe('rt-secret');
    expect(unseal(sealed, 'another-secret')).toBeNull();
    const [iv, tag, body] = sealed.split('.');
    const flipped = Buffer.from(body, 'base64url');
    flipped[0] ^= 1;
    expect(unseal([iv, tag, flipped.toString('base64url')].join('.'), SECRET)).toBeNull();
  });

  it('trades the refresh token for a fresh session when the session cookie has run out', async () => {
    const { auth, sent } = fakeAegis({ status: 200, body: { id_token: idToken({ sub: 'u1', email: 'Owner@Example.com' }), refresh_token: 'rt-2' } });
    const resumed = await auth.resume(refreshCookie('rt-1'));
    expect(resumed && !('clear' in resumed) && resumed.session.email).toBe('owner@example.com');
    expect(sent[0].get('grant_type')).toBe('refresh_token');
    expect(sent[0].get('refresh_token')).toBe('rt-1');
    const set = resumed && !('clear' in resumed) ? resumed.cookies : [];
    const jar = cookies(set.map((c) => c.split(';')[0]).join('; '));
    expect(auth.session(`leyline_session=${encodeURIComponent(jar['leyline_session'])}`)?.email).toBe('owner@example.com');
    expect(unseal(jar['leyline_refresh'], SECRET)).toBe('rt-2');
  });

  it('does nothing while the session cookie is still good', async () => {
    const { auth, sent } = fakeAegis({ status: 200 });
    const session = `leyline_session=${sign({ sub: 'u1', email: 'owner@example.com', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET)}`;
    expect(await auth.resume(`${session}; ${refreshCookie('rt-1')}`)).toBeNull();
    expect(sent).toEqual([]);
  });

  it('clears the refresh cookie once Aegis has ended the sign-in', async () => {
    const { auth } = fakeAegis({ status: 400, body: { error: 'invalid_grant' } });
    expect(await auth.resume(refreshCookie('rt-1'))).toEqual({ clear: true });
    expect(await auth.resume('leyline_refresh=garbage')).toEqual({ clear: true });
  });

  it('keeps the cookie when Aegis is just unavailable', async () => {
    const { auth } = fakeAegis({ status: 503, body: {} });
    expect(await auth.resume(refreshCookie('rt-1'))).toBeNull();
  });

  it("refuses a refreshed id_token issued to another app", async () => {
    const { auth } = fakeAegis({ status: 200, body: { id_token: idToken({ sub: 'u1', email: 'o@e.com', aud: 'someone-else' }) } });
    expect(await auth.resume(refreshCookie('rt-1'))).toEqual({ clear: true });
  });
});
