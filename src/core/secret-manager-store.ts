import type { ApiKeySource, SecretStore, SecretStoreStatus } from './secret-store';
import { GcpToken } from './gcp';

/**
 * Provider keys and dashboard settings kept in Google Secret Manager, for Leyline on Cloud Run (no Keychain there).
 * It plays the dashboard's "keychain" role: the persistent server-side store. Each account is one secret named
 * `{prefix}{account}` (characters Secret Manager doesn't allow are hex-escaped); a write adds a version and
 * destroys the older ones. Values are cached in memory after the first read.
 */
export class SecretManagerSecretStore implements SecretStore {
  private readonly token: GcpToken;
  private readonly cache = new Map<string, string | undefined>();
  private project: string | null;
  private lastError: string | undefined;

  constructor(project: string | null, private readonly prefix = 'leyline-', private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {
    this.project = project || null;
    this.token = new GcpToken(fetchImpl);
  }

  /** The secret id for an account: letters, digits, - and _ kept; anything else as _xx. */
  secretId(account: string): string {
    return `${this.prefix}${account.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}`;
  }

  private async base(): Promise<string> {
    if (!this.project) this.project = await this.token.projectId();
    return `https://secretmanager.googleapis.com/v1/projects/${this.project}/secrets`;
  }

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${await this.token.get()}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  }

  async get(account: string): Promise<string | undefined> {
    if (this.cache.has(account)) return this.cache.get(account);
    const res = await this.call(`${await this.base()}/${this.secretId(account)}/versions/latest:access`);
    if (res.status === 404 || res.status === 400) {
      this.cache.set(account, undefined);
      return undefined;
    }
    if (!res.ok) {
      this.lastError = `Secret Manager read failed (${res.status})`;
      throw new Error(`${this.lastError} for ${account}`);
    }
    const body = (await res.json()) as { payload?: { data?: string } };
    const value = body.payload?.data ? Buffer.from(body.payload.data, 'base64').toString('utf8') : undefined;
    this.cache.set(account, value);
    return value;
  }

  async set(account: string, secret: string): Promise<void> {
    const base = await this.base();
    const id = this.secretId(account);
    const made = await this.call(`${base}?secretId=${id}`, { method: 'POST', body: JSON.stringify({ replication: { automatic: {} }, labels: { app: 'leyline' } }) });
    if (!made.ok && made.status !== 409) throw new Error(`Secret Manager create failed (${made.status}) for ${account}`);
    const added = await this.call(`${base}/${id}:addVersion`, { method: 'POST', body: JSON.stringify({ payload: { data: Buffer.from(secret, 'utf8').toString('base64') } }) });
    if (!added.ok) throw new Error(`Secret Manager write failed (${added.status}) for ${account}`);
    const version = ((await added.json()) as { name?: string }).name;
    this.cache.set(account, secret);
    this.lastError = undefined;
    void this.destroyOlder(base, id, version).catch((err) => console.warn('[Leyline] could not destroy old secret versions', err));
  }

  private async destroyOlder(base: string, id: string, keep: string | undefined): Promise<void> {
    const res = await this.call(`${base}/${id}/versions?filter=${encodeURIComponent('state:ENABLED')}`);
    if (!res.ok) return;
    const { versions = [] } = (await res.json()) as { versions?: Array<{ name: string }> };
    for (const v of versions) {
      if (v.name !== keep) await this.call(`https://secretmanager.googleapis.com/v1/${v.name}:destroy`, { method: 'POST', body: '{}' });
    }
  }

  async delete(account: string): Promise<void> {
    const res = await this.call(`${await this.base()}/${this.secretId(account)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`Secret Manager delete failed (${res.status}) for ${account}`);
    this.cache.set(account, undefined);
  }

  status(): SecretStoreStatus {
    return { mode: 'keychain', available: true, service: this.project ? `projects/${this.project}` : 'Google Secret Manager', label: 'Google Secret Manager', ...(this.lastError ? { warning: this.lastError } : {}) };
  }

  async getSource(account: string): Promise<ApiKeySource> {
    return (await this.get(account)) ? 'keychain' : 'none';
  }
}
