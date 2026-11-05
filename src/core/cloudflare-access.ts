import { createPublicKey, verify } from 'crypto';

/**
 * The admin host's own check behind Cloudflare Access: the Cf-Access-Jwt-Assertion header Access adds must be a
 * token signed by our team for our Access application (its AUD tag), not expired, and for an admin: a person whose
 * email is in LEYLINE_ADMIN_EMAILS, or a service token whose client id is listed in CF_ACCESS_SERVICE_TOKEN_IDS
 * (automation; its secret lives in Arcana). Not configured: nobody gets in.
 */
export type AccessConfig = {
  /** https://<team>.cloudflareaccess.com */
  teamDomain: string;
  /** The Access application's AUD tag. */
  aud: string;
  serviceTokenIds: string[];
  fetchImpl?: typeof fetch;
};

export function accessConfigFromEnv(env: Record<string, string | undefined>): AccessConfig | null {
  const teamDomain = (env.CF_ACCESS_TEAM_DOMAIN ?? '').trim().replace(/\/+$/, '');
  const aud = (env.CF_ACCESS_AUD ?? '').trim();
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/i.test(teamDomain) || !aud) return null;
  return { teamDomain, aud, serviceTokenIds: (env.CF_ACCESS_SERVICE_TOKEN_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean) };
}

type Jwk = { kid?: string; kty?: string; [k: string]: unknown };
const certs = new Map<string, { keys: Jwk[]; at: number }>();

async function keysFor(cfg: AccessConfig, refresh: boolean): Promise<Jwk[]> {
  const cached = certs.get(cfg.teamDomain);
  if (cached && !refresh && Date.now() - cached.at < 3_600_000) return cached.keys;
  const fetchImpl = cfg.fetchImpl ?? ((input, init) => fetch(input, init));
  const res = await fetchImpl(`${cfg.teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs ${res.status}`);
  const keys = ((await res.json()) as { keys?: Jwk[] }).keys ?? [];
  certs.set(cfg.teamDomain, { keys, at: Date.now() });
  return keys;
}

export type AccessIdentity = { email?: string; serviceTokenId?: string };

/** The identity in a valid Access token for this application, or null. */
export async function verifyAccessJwt(token: string | undefined, cfg: AccessConfig, now = Date.now()): Promise<AccessIdentity | null> {
  if (!token) return null;
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  try {
    const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { alg?: string; kid?: string };
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
    if (header.alg !== 'RS256') return null;
    let key = (await keysFor(cfg, false)).find((k) => k.kid === header.kid);
    if (!key) key = (await keysFor(cfg, true)).find((k) => k.kid === header.kid);
    if (!key) return null;
    const ok = verify('sha256', Buffer.from(`${h}.${p}`), createPublicKey({ key: key as never, format: 'jwk' }), Buffer.from(s, 'base64url'));
    if (!ok) return null;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(cfg.aud)) return null;
    if (claims.iss !== cfg.teamDomain) return null;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < now) return null;
    if (typeof claims.nbf === 'number' && claims.nbf * 1000 > now + 60_000) return null;
    if (typeof claims.email === 'string' && claims.email) return { email: claims.email.toLowerCase() };
    if (typeof claims.common_name === 'string' && claims.common_name) return { serviceTokenId: claims.common_name };
    return null;
  } catch {
    return null;
  }
}

/** Who may use the admin host: an admin email or an allowed service token; else null. */
export async function accessAdmin(header: string | undefined, cfg: AccessConfig | null | undefined, adminEmails: string[]): Promise<string | null> {
  if (!cfg) return null;
  const who = await verifyAccessJwt(header, cfg);
  if (!who) return null;
  if (who.email && adminEmails.some((e) => e.trim().toLowerCase() === who.email)) return who.email;
  if (who.serviceTokenId && cfg.serviceTokenIds.includes(who.serviceTokenId)) return `service:${who.serviceTokenId}`;
  return null;
}
