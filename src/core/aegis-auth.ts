import * as jose from 'jose';
import { Request, Response, NextFunction } from 'express';
import { QuotaManager } from './quota-manager';

/** Identifies the calling dependent app, resolved from a verified Aegis token-exchange JWT. */
export interface AegisTenant {
  clientId: string;
}

export interface AegisAuthOptions {
  /** Expected `iss` claim — Leyline's own Aegis tenant issuer. JWKS is fetched from `${issuer}/jwks`. */
  issuer: string;
  /** Expected `aud` claim — Leyline's own Aegis client id. */
  audience: string;
  quota: QuotaManager;
  defaultRequestsPerMinute: number;
  defaultRequestsPerDay: number;
  /** Override the key resolver (tests only) instead of fetching the real remote JWKS. */
  jwks?: jose.JWTVerifyGetKey;
}

function invalidApiKeyResponse(res: Response, message: string): void {
  res.status(401).json({
    error: {
      message,
      type: 'invalid_request_error',
      code: 'invalid_api_key',
    },
  });
}

/**
 * Express middleware verifying the Bearer token as an Aegis RFC 8693 token-exchange JWT,
 * minted for Leyline via an admin-approved ClientTrustPair. Only service-to-service tokens
 * (`service_account: true`) are accepted — Leyline has no on-behalf-of-user use case.
 * The dependent app's own `requester_client_id` claim becomes the tenant identity used for
 * per-tenant rate limiting.
 */
export function createRequireAegisToken(options: AegisAuthOptions) {
  const { issuer, audience, quota, defaultRequestsPerMinute, defaultRequestsPerDay } = options;

  const jwks = options.jwks ?? jose.createRemoteJWKSet(new URL(`${issuer}/jwks`));

  return async function requireAegisToken(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

    if (!token) {
      invalidApiKeyResponse(res, 'Missing bearer authentication');
      return;
    }

    let payload: jose.JWTPayload;
    try {
      ({ payload } = await jose.jwtVerify(token, jwks, { issuer, audience }));
    } catch {
      invalidApiKeyResponse(res, 'Incorrect API key provided');
      return;
    }

    if (payload.service_account !== true) {
      invalidApiKeyResponse(res, 'Token is not a service-to-service credential');
      return;
    }

    const clientId = payload.requester_client_id;
    if (typeof clientId !== 'string' || !clientId) {
      invalidApiKeyResponse(res, 'Token is missing requester_client_id');
      return;
    }

    quota.setQuota(clientId, {
      requestsPerMinute: defaultRequestsPerMinute,
      requestsPerDay: defaultRequestsPerDay,
    });

    if (!quota.checkQuota(clientId)) {
      res.status(429).json({
        error: {
          message: `Tenant "${clientId}" exceeded its request quota`,
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded',
        },
      });
      return;
    }

    quota.incrementUsage(clientId);
    (req as Request & { tenant?: AegisTenant }).tenant = { clientId };
    next();
  };
}
