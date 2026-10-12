import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'crypto';

type JsonWebKey = { kid?: string; alg?: string; kty?: string; [k: string]: unknown };

/** A signed-in person. */
export type AdminUser = { sub: string; email: string; name?: string };

/**
 * Sign-in with Aegis (OpenID Connect, authorization code + PKCE) for Leyline's admin page, then a signed
 * session cookie. No session store: the cookie carries who you are and when that expires, signed with
 * LEYLINE_SESSION_SECRET. Ported from echo-hosted (packages/hosted/src/auth.ts).
 *
 * Staying signed in: the sign-in asks for offline_access, and Aegis's refresh token is kept in a second,
 * encrypted cookie. When the session cookie runs out, resume() trades the refresh token for a fresh
 * session, so someone who uses the page keeps using it until Aegis ends the sign-in (its "long" policy for
 * leyline-dashboard: 30 days after the last refresh, at most 90 after signing in).
 */
export type AuthConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Where Aegis sends the browser back: {public url}/auth/callback */
  redirectUri: string;
  sessionSecret: string;
  sessionHours?: number;
  fetchImpl?: typeof fetch;
};

const b64u = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

export function sign(value: object, secret: string): string {
  const body = b64u(JSON.stringify(value));
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

export function unsign<T>(token: string | undefined, secret: string): T | null {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString()) as T & { exp?: number };
    if (typeof value.exp === 'number' && value.exp * 1000 < Date.now()) return null;
    return value;
  } catch {
    return null;
  }
}

export function cookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/** How long the refresh cookie lives; Aegis decides how long the token in it actually works. */
const REFRESH_COOKIE_SECONDS = 90 * 24 * 3600;

/** AES-256-GCM under a key derived from the session secret: the refresh token is a credential, not just signed data. */
function sealKey(secret: string): Buffer {
  return createHash('sha256').update(`leyline-refresh:${secret}`).digest();
}

export function seal(value: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', sealKey(secret), iv);
  const body = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

export function unseal(token: string | undefined, secret: string): string | null {
  if (!token) return null;
  const [iv, tag, body] = token.split('.').map((p) => Buffer.from(p ?? '', 'base64url'));
  if (!iv?.length || !tag?.length || !body) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', sealKey(secret), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

type Discovery = { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; issuer: string; userinfo_endpoint?: string };
type PendingLogin = { state: string; verifier: string; nonce: string; next: string; exp: number };
export type Session = AdminUser & { exp: number };

export class AegisAuth {
  private discovery: Promise<Discovery> | null = null;
  private jwks: { keys: Array<JsonWebKey & { kid?: string; alg?: string }> } | null = null;
  private jwksAt = 0;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: AuthConfig) {
    // Called through a wrapper: Workers throws "Illegal invocation" for a bare fetch called as a method.
    this.fetchImpl = cfg.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private discover(): Promise<Discovery> {
    this.discovery ??= this.fetchImpl(`${this.cfg.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`)
      .then((r) => {
        if (!r.ok) throw new Error(`Aegis discovery ${r.status}`);
        return r.json() as Promise<Discovery>;
      })
      .catch((err) => {
        this.discovery = null;
        throw err;
      });
    return this.discovery;
  }

  /** Where to send the browser, and the cookie that remembers this attempt. switchAccount: ask Aegis to sign in again. */
  async start(next: string, opts: { switchAccount?: boolean } = {}): Promise<{ url: string; cookie: string }> {
    const d = await this.discover();
    const pending: PendingLogin = {
      state: b64u(randomBytes(16)),
      verifier: b64u(randomBytes(32)),
      nonce: b64u(randomBytes(16)),
      next: next.startsWith('/') && !next.startsWith('//') ? next : '/',
      exp: Math.floor(Date.now() / 1000) + 600,
    };
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: 'code',
      // offline_access: a refresh token, so the page stays signed in while it's used (see resume).
      scope: 'openid email profile offline_access',
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: b64u(createHash('sha256').update(pending.verifier).digest()),
      code_challenge_method: 'S256',
      // A prompt without "consent" makes Aegis (oidc-provider) drop offline_access.
      ...(opts.switchAccount ? { prompt: 'login consent' } : {}),
    }).toString();
    return { url: url.toString(), cookie: cookie('leyline_login', sign(pending, this.cfg.sessionSecret), 600) };
  }

  /** Back from Aegis: the signed-in user, their session cookie, and where they were going. */
  async finish(query: URLSearchParams, cookieHeader: string | undefined): Promise<{ session: Session; cookie: string; cookies: string[]; next: string }> {
    const pending = unsign<PendingLogin>(cookies(cookieHeader)['leyline_login'], this.cfg.sessionSecret);
    if (!pending) throw new Error('sign-in expired; start again');
    if (query.get('error')) throw new Error(`Aegis: ${query.get('error')}`);
    if (query.get('state') !== pending.state) throw new Error('sign-in state mismatch');
    const code = query.get('code');
    if (!code) throw new Error('no code from Aegis');
    const d = await this.discover();
    const res = await this.fetchImpl(d.token_endpoint, {
      method: 'POST',
      // Aegis takes client_secret_post (not basic).
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.cfg.redirectUri,
        code_verifier: pending.verifier,
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`Aegis token exchange ${res.status}`);
    const { id_token, refresh_token } = (await res.json()) as { id_token?: string; refresh_token?: string };
    if (!id_token) throw new Error('Aegis returned no id_token');
    const claims = await this.verifyIdToken(id_token, d.issuer, pending.nonce);
    const session = this.sessionFrom(claims);
    const sessionCookie = this.sessionCookie(session);
    return {
      session,
      cookie: sessionCookie,
      cookies: [sessionCookie, ...(refresh_token ? [this.refreshCookie(refresh_token)] : [])],
      next: pending.next,
    };
  }

  /**
   * The session cookie ran out (or is missing) but a refresh cookie is there: a fresh session from Aegis,
   * with the cookies to set. Null when there's nothing to resume or Aegis ended the sign-in; then the
   * refresh cookie should be cleared (clear: true).
   */
  async resume(cookieHeader: string | undefined): Promise<{ session: Session; cookies: string[] } | { clear: true } | null> {
    if (this.session(cookieHeader)) return null;
    const jar = cookies(cookieHeader);
    if (!jar['leyline_refresh']) return null;
    const refreshToken = unseal(jar['leyline_refresh'], this.cfg.sessionSecret);
    if (!refreshToken) return { clear: true };
    try {
      const d = await this.discover();
      const res = await this.fetchImpl(d.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: this.cfg.clientId,
          client_secret: this.cfg.clientSecret,
        }),
      });
      // 400 invalid_grant: Aegis ended the sign-in (expired, revoked, signed out).
      if (res.status === 400 || res.status === 401) return { clear: true };
      if (!res.ok) return null;
      const body = (await res.json()) as { id_token?: string; refresh_token?: string };
      if (!body.id_token) return { clear: true };
      // A refreshed id_token has no nonce to check; signature, issuer, audience and expiry still are.
      const claims = await this.verifySigned(body.id_token, d.issuer, 'id_token');
      const aud = Array.isArray(claims['aud']) ? claims['aud'] : [claims['aud']];
      if (!aud.includes(this.cfg.clientId)) return { clear: true };
      const session = this.sessionFrom(claims);
      // Aegis may rotate the refresh token; keep whichever is current.
      return { session, cookies: [this.sessionCookie(session), this.refreshCookie(body.refresh_token ?? refreshToken)] };
    } catch {
      // Aegis unreachable or a bad answer: leave the cookie for the next request.
      return null;
    }
  }

  private sessionFrom(claims: Record<string, unknown>): Session {
    if (typeof claims['email'] !== 'string' || !claims['email']) throw new Error('your Aegis account has no email');
    return {
      sub: String(claims['sub']),
      email: String(claims['email']).toLowerCase(),
      ...(nameFrom(claims) ? { name: nameFrom(claims)! } : {}),
      exp: Math.floor(Date.now() / 1000) + (this.cfg.sessionHours ?? 12) * 3600,
    };
  }

  private sessionCookie(session: Session): string {
    return cookie('leyline_session', sign(session, this.cfg.sessionSecret), (this.cfg.sessionHours ?? 12) * 3600);
  }

  private refreshCookie(refreshToken: string): string {
    return cookie('leyline_refresh', seal(refreshToken, this.cfg.sessionSecret), REFRESH_COOKIE_SECONDS);
  }

  session(cookieHeader: string | undefined): Session | null {
    return unsign<Session>(cookies(cookieHeader)['leyline_session'], this.cfg.sessionSecret);
  }

  async verifyIdToken(jwt: string, issuer: string, nonce: string): Promise<Record<string, unknown>> {
    const claims = await this.verifySigned(jwt, issuer, 'id_token');
    const aud = Array.isArray(claims['aud']) ? claims['aud'] : [claims['aud']];
    if (!aud.includes(this.cfg.clientId)) throw new Error('id_token audience mismatch');
    if (claims['nonce'] !== nonce) throw new Error('id_token nonce mismatch');
    return claims;
  }

  /** A JWT signed by Aegis, from this issuer and not expired: its claims (or it throws). */
  private async verifySigned(jwt: string, issuer: string, what: string): Promise<Record<string, unknown>> {
    const [h, p, s] = jwt.split('.');
    if (!h || !p || !s) throw new Error(`malformed ${what}`);
    const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { alg: string; kid?: string };
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
    const jwk = await this.key(header.kid);
    const data = Buffer.from(`${h}.${p}`);
    const sig = Buffer.from(s, 'base64url');
    const key = createPublicKey({ key: jwk as never, format: 'jwk' });
    const ok = header.alg === 'RS256' ? verify('sha256', data, key, sig)
      : header.alg === 'ES256' ? verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig)
      : header.alg === 'EdDSA' ? verify(null, data, key, sig)
      : false;
    if (!ok) throw new Error(`${what} signature invalid (${header.alg})`);
    if (claims['iss'] !== issuer) throw new Error(`${what} issuer mismatch`);
    if (typeof claims['exp'] !== 'number' || claims['exp'] * 1000 < Date.now() - 60_000) throw new Error(`${what} expired`);
    return claims;
  }

  private async key(kid: string | undefined): Promise<JsonWebKey> {
    const find = () => this.jwks?.keys.find((k) => !kid || k.kid === kid);
    // Refetch for an unknown key (Aegis rotated), but at most once a minute.
    if (!find() && Date.now() - this.jwksAt > 60_000) {
      this.jwksAt = Date.now();
      const d = await this.discover();
      const res = await this.fetchImpl(d.jwks_uri);
      if (!res.ok) throw new Error(`Aegis JWKS ${res.status}`);
      this.jwks = (await res.json()) as typeof this.jwks;
    }
    const k = find();
    if (!k) throw new Error('signed with an unknown key');
    return k;
  }
}

/** The person's name from OIDC profile claims, if the account has one. */
function nameFrom(claims: Record<string, unknown>): string | undefined {
  const name = typeof claims['name'] === 'string' ? claims['name'].trim() : '';
  if (name) return name.slice(0, 80);
  const parts = [claims['given_name'], claims['family_name']].filter((p): p is string => typeof p === 'string' && !!p.trim());
  return parts.length ? parts.join(' ').slice(0, 80) : undefined;
}
