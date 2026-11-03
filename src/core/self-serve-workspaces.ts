import { createHash, randomUUID } from 'crypto';

export type WorkspaceRecord = {
  id: string;
  ownerAegisAccountId: string;
  ownerEmailHash: string;
  verifiedEmail: string;
  createdAt: number;
  suspendedAt?: number;
};

export type WorkspaceKeyRecord = {
  id: string;
  workspaceId: string;
  secretHash: string;
  createdAt: number;
  suspendedAt?: number;
  autoPausedAt?: number;
  anomalyScore: number;
};

export type WorkspaceUsageRecord = {
  workspaceId: string;
  keyId: string;
  day: string;
  requests: number;
  tokens: number;
};

export type SelfServeAuditEvent = {
  id: string;
  workspaceId?: string;
  actorAegisAccountId?: string;
  type: 'signup' | 'key_created' | 'grant_used' | 'workspace_suspended' | 'key_suspended' | 'key_auto_paused';
  at: number;
  metadata?: Record<string, string | number | boolean>;
};

export interface SelfServeStore {
  getWorkspaceByAegisAccount(accountId: string): Promise<WorkspaceRecord | null>;
  getWorkspaceByEmailHash(emailHash: string): Promise<WorkspaceRecord | null>;
  putWorkspace(workspace: WorkspaceRecord): Promise<void>;
  getKeyByHash(secretHash: string): Promise<WorkspaceKeyRecord | null>;
  putKey(key: WorkspaceKeyRecord): Promise<void>;
  putUsage(usage: WorkspaceUsageRecord): Promise<void>;
  listKeys(workspaceId: string): Promise<WorkspaceKeyRecord[]>;
  listUsage(workspaceId: string, day?: string): Promise<WorkspaceUsageRecord[]>;
  appendAudit(event: SelfServeAuditEvent): Promise<void>;
  countWorkspaceCreations(ip: string, since: number): Promise<number>;
}

export type TurnstileSiteverifyResponse = {
  success: boolean;
  'error-codes'?: string[];
};

export async function verifyTurnstile(
  token: string,
  secret: string | undefined,
  remoteIp: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (!token || !secret) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);
  const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) return false;
  const result = await response.json() as TurnstileSiteverifyResponse;
  return result.success === true;
}

export function hashIdentity(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

export function disposableEmail(email: string, blockedDomains: ReadonlySet<string>): boolean {
  const domain = email.trim().toLowerCase().split('@').pop() ?? '';
  return blockedDomains.has(domain);
}

export async function createSelfServeWorkspace(
  store: SelfServeStore,
  identity: { aegisAccountId: string; verifiedEmail: string; emailVerified: boolean },
  ip: string,
  turnstileToken: string,
  now = Date.now(),
): Promise<WorkspaceRecord> {
  if (!identity.emailVerified || !identity.verifiedEmail.trim()) {
    throw new Error('email_verification_required');
  }

  const emailHash = hashIdentity(identity.verifiedEmail);
  const existingByAccount = await store.getWorkspaceByAegisAccount(identity.aegisAccountId);
  if (existingByAccount) return existingByAccount;

  const existingByEmail = await store.getWorkspaceByEmailHash(emailHash);
  if (existingByEmail) {
    throw new Error('free_grant_already_used');
  }

  const creations = await store.countWorkspaceCreations(ip, now - 24 * 60 * 60 * 1000);
  if (creations >= 3) {
    throw new Error('workspace_creation_rate_limited');
  }

  const verified = await verifyTurnstile(
    turnstileToken,
    process.env.TURNSTILE_SECRET,
    ip,
  );
  if (!verified) {
    throw new Error('turnstile_verification_failed');
  }

  const workspace: WorkspaceRecord = {
    id: randomUUID(),
    ownerAegisAccountId: identity.aegisAccountId,
    ownerEmailHash: emailHash,
    verifiedEmail: identity.verifiedEmail.trim().toLowerCase(),
    createdAt: now,
  };

  await store.putWorkspace(workspace);
  await store.appendAudit({
    id: randomUUID(),
    workspaceId: workspace.id,
    actorAegisAccountId: identity.aegisAccountId,
    type: 'signup',
    at: now,
    metadata: { ip },
  });

  return workspace;
}