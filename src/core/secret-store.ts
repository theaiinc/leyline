import { execFile, type ExecFileException } from 'child_process';
import axios from 'axios';

export type ApiKeyPersistenceMode = 'keychain' | 'memory' | 'localStorage' | 'arcana';
export type ApiKeySource = ApiKeyPersistenceMode | 'arcana' | 'env' | 'none';

export interface SecretStoreStatus {
  mode: 'keychain' | 'memory';
  available: boolean;
  service: string;
  warning?: string;
}

export interface SecretStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
  status(): SecretStoreStatus;
  getSource?(account: string): Promise<ApiKeySource>;
  hasArcanaReference?(account?: string): boolean;
  getArcanaReference?(account: string): string | undefined;
  setArcanaReference?(account: string, reference: string): void;
}

export const DEFAULT_KEYCHAIN_SERVICE = '@theaiinc/leyline';

type SecurityCommandError = ExecFileException & {
  stderr?: string;
};

function execSecurity(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('security', args, (error, stdout, stderr) => {
      if (error) {
        const securityError = error as SecurityCommandError;
        securityError.stderr = stderr;
        reject(securityError);
        return;
      }

      resolve(stdout);
    });
  });
}

function isMissingKeychainItem(error: unknown): boolean {
  const securityError = error as Partial<SecurityCommandError>;
  const stderr = typeof securityError.stderr === 'string' ? securityError.stderr.toLowerCase() : '';

  return securityError.code === 44 || stderr.includes('specified item could not be found');
}

function keychainFailureReason(error: unknown): string {
  const securityError = error as Partial<SecurityCommandError>;
  const stderr = typeof securityError.stderr === 'string' ? securityError.stderr.toLowerCase() : '';

  if (stderr.includes('user interaction is not allowed') || stderr.includes('authorization') || stderr.includes('denied')) {
    return 'Keychain access was denied or requires permission';
  }
  if (securityError.code === 'ENOENT') {
    return 'macOS security CLI was not found';
  }
  if (securityError.code === 'EACCES') {
    return 'macOS security CLI is not executable';
  }
  if (typeof securityError.code === 'number') {
    return `security exited with code ${securityError.code}`;
  }
  if (typeof securityError.code === 'string') {
    return `security failed with ${securityError.code}`;
  }

  return 'security command failed';
}

function keychainFailureWarning(action: 'lookup' | 'save' | 'delete', error: unknown): string {
  return `Apple Keychain ${action} failed (${keychainFailureReason(error)}); using process memory for server-side keys. Check Keychain access or set LEYLINE_KEYCHAIN_ENABLED=false to use memory-only mode.`;
}

export function apiKeyAccount(providerName: string): string {
  return `api-key:${providerName}`;
}

export function runtimeConfigAccount(providerName: string): string {
  return `runtime-config:${providerName}`;
}

export interface PersistedRuntimeConfig {
  baseUrl?: string;
  model?: string;
}

export function serializeRuntimeConfig(config: PersistedRuntimeConfig): string {
  return JSON.stringify({
    baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : '',
    model: typeof config.model === 'string' ? config.model : '',
  });
}

export function parseRuntimeConfig(raw: string): PersistedRuntimeConfig | undefined {
  try {
    const parsed = JSON.parse(raw) as PersistedRuntimeConfig;
    if (!parsed || typeof parsed !== 'object') return undefined;
    return {
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : undefined,
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
    };
  } catch {
    return undefined;
  }
}

export const ROUTING_CONFIG_ACCOUNT = 'routing-config';

export interface PersistedRoutingConfig {
  /** 'auto' routes across the enabled model pool; 'pinned' forces one provider/model. */
  mode?: 'auto' | 'pinned';
  pinnedProvider?: string;
  pinnedModel?: string;
  /** Provider name → model ids enabled for auto routing. Empty/absent = all models. */
  enabledModels?: Record<string, string[]>;
  /** Model id → preferred provider name, used to disambiguate when more than one provider lists a model. */
  modelPins?: Record<string, string>;
}

export function serializeRoutingConfig(config: PersistedRoutingConfig): string {
  return JSON.stringify({
    mode: config.mode === 'pinned' ? 'pinned' : 'auto',
    pinnedProvider: typeof config.pinnedProvider === 'string' ? config.pinnedProvider : '',
    pinnedModel: typeof config.pinnedModel === 'string' ? config.pinnedModel : '',
    enabledModels: sanitizeEnabledModels(config.enabledModels) ?? {},
    modelPins: sanitizeModelPins(config.modelPins) ?? {},
  });
}

export function parseRoutingConfig(raw: string): PersistedRoutingConfig | undefined {
  try {
    const parsed = JSON.parse(raw) as PersistedRoutingConfig;
    if (!parsed || typeof parsed !== 'object') return undefined;
    return {
      mode: parsed.mode === 'pinned' ? 'pinned' : 'auto',
      pinnedProvider: typeof parsed.pinnedProvider === 'string' ? parsed.pinnedProvider : undefined,
      pinnedModel: typeof parsed.pinnedModel === 'string' ? parsed.pinnedModel : undefined,
      enabledModels: sanitizeEnabledModels(parsed.enabledModels),
      modelPins: sanitizeModelPins(parsed.modelPins),
    };
  } catch {
    return undefined;
  }
}

export function sanitizeEnabledModels(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, string[]> = {};
  for (const [provider, models] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(models)) continue;
    result[provider] = models.filter((model): model is string => typeof model === 'string');
  }
  return result;
}

export function sanitizeModelPins(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [model, provider] of Object.entries(value as Record<string, unknown>)) {
    if (typeof provider === 'string' && provider) result[model] = provider;
  }
  return result;
}

// ── Multi-instance provider manifests ───────────────────────────────
//
// Secrets/runtime config for each instance reuse the existing generic
// apiKeyAccount/runtimeConfigAccount helpers (keyed by the instance's
// composed provider name). This manifest only tracks *which instance ids
// exist* per family, plus any non-secret "extra" fields, so bootstrap knows
// what to reconstruct before it can look up those accounts.

export function instanceManifestAccount(family: string): string {
  return `instances:${family}`;
}

export interface PersistedProviderInstance {
  id: string;
  label: string;
  extra?: Record<string, string>;
}

export function serializeInstanceManifest(instances: PersistedProviderInstance[]): string {
  return JSON.stringify(instances.map(instance => ({
    id: instance.id,
    label: instance.label || instance.id,
    extra: instance.extra ?? {},
  })));
}

export function parseInstanceManifest(raw: string): PersistedProviderInstance[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const result: PersistedProviderInstance[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) continue;
      const extra: Record<string, string> = {};
      if (entry.extra && typeof entry.extra === 'object') {
        for (const [key, value] of Object.entries(entry.extra)) {
          if (typeof value === 'string') extra[key] = value;
        }
      }
      result.push({
        id: entry.id,
        label: typeof entry.label === 'string' && entry.label ? entry.label : entry.id,
        extra,
      });
    }
    return result;
  } catch {
    return [];
  }
}

export class MemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, string>();

  constructor(private readonly service = DEFAULT_KEYCHAIN_SERVICE, private readonly warning?: string) {}

  async get(account: string): Promise<string | undefined> {
    return this.secrets.get(account);
  }

  async set(account: string, secret: string): Promise<void> {
    this.secrets.set(account, secret);
  }

  async delete(account: string): Promise<void> {
    this.secrets.delete(account);
  }

  status(): SecretStoreStatus {
    return {
      mode: 'memory',
      available: true,
      service: this.service,
      warning: this.warning,
    };
  }

  async getSource(account: string): Promise<ApiKeySource> {
    return (await this.get(account)) ? 'memory' : 'none';
  }
}

export class KeychainSecretStore implements SecretStore {
  private available: boolean;
  private warning: string | undefined;

  constructor(private readonly service = DEFAULT_KEYCHAIN_SERVICE, available = process.platform === 'darwin') {
    this.available = available;
    this.warning = this.available ? undefined : 'Apple Keychain is only available on macOS.';
  }

  async get(account: string): Promise<string | undefined> {
    if (!this.available) return undefined;

    try {
      const stdout = await execSecurity([
        'find-generic-password',
        '-s',
        this.service,
        '-a',
        account,
        '-w',
      ]);
      return stdout.trim() || undefined;
    } catch (error) {
      if (isMissingKeychainItem(error)) return undefined;

      this.markUnavailable(keychainFailureWarning('lookup', error));
      return undefined;
    }
  }

  async set(account: string, secret: string): Promise<void> {
    if (!this.available) {
      throw new Error(this.warning || 'Apple Keychain is unavailable.');
    }

    try {
      await this.deleteFromKeychain(account);
      await execSecurity([
        'add-generic-password',
        '-U',
        '-s',
        this.service,
        '-a',
        account,
        '-w',
        secret,
      ]);
    } catch (error) {
      this.markUnavailable(keychainFailureWarning('save', error));
      throw new Error(this.warning);
    }
  }

  async delete(account: string): Promise<void> {
    if (!this.available) return;

    try {
      await this.deleteFromKeychain(account);
    } catch (error) {
      this.markUnavailable(keychainFailureWarning('delete', error));
    }
  }

  private async deleteFromKeychain(account: string): Promise<void> {
    try {
      await execSecurity([
        'delete-generic-password',
        '-s',
        this.service,
        '-a',
        account,
      ]);
    } catch (error) {
      if (isMissingKeychainItem(error)) return;
      throw error;
    }
  }

  status(): SecretStoreStatus {
    return {
      mode: this.available ? 'keychain' : 'memory',
      available: this.available,
      service: this.service,
      warning: this.warning,
    };
  }

  async getSource(account: string): Promise<ApiKeySource> {
    return (await this.get(account)) ? 'keychain' : 'none';
  }

  private markUnavailable(warning: string): void {
    this.available = false;
    this.warning = warning;
  }
}

export class FallbackSecretStore implements SecretStore {
  private readonly memory: MemorySecretStore;

  constructor(private readonly primary: SecretStore, service = DEFAULT_KEYCHAIN_SERVICE) {
    this.memory = new MemorySecretStore(service, primary.status().warning);
  }

  async get(account: string): Promise<string | undefined> {
    const primarySecret = await this.primary.get(account);
    return primarySecret ?? this.memory.get(account);
  }

  async set(account: string, secret: string): Promise<void> {
    if (this.primary.status().available) {
      try {
        await this.primary.set(account, secret);
        return;
      } catch {
        // Fall through to memory so runtime key updates still work.
      }
    }

    await this.memory.set(account, secret);
  }

  async delete(account: string): Promise<void> {
    await this.primary.delete(account);
    await this.memory.delete(account);
  }

  async getSource(account: string): Promise<ApiKeySource> {
    const primarySource = this.primary.getSource
      ? await this.primary.getSource(account)
      : (await this.primary.get(account) ? 'keychain' : 'none');
    if (primarySource !== 'none') return primarySource;
    return (await this.memory.get(account)) ? 'memory' : 'none';
  }

  status(): SecretStoreStatus {
    const primaryStatus = this.primary.status();
    if (primaryStatus.available) return primaryStatus;

    return {
      ...this.memory.status(),
      warning: primaryStatus.warning || this.memory.status().warning,
    };
  }
}

/**
 * Resolves Arcana references through the Arcana Secret Bridge CLI.
 *
 * Arcana intentionally injects secrets into an allowlisted child process
 * instead of returning them directly. The child prints only the requested
 * value, which is captured in memory and never logged.
 */
export class ArcanaSecretStore implements SecretStore {
  constructor(
    private readonly references: Record<string, string>,
    private readonly command = process.env.LEYLINE_ARCANA_COMMAND || 'arcana',
    private readonly runner = process.env.LEYLINE_ARCANA_RUNNER || 'python3',
    private readonly timeoutMs = Number.parseInt(process.env.LEYLINE_ARCANA_TIMEOUT_MS || '10000', 10),
  ) {}

  async get(account: string): Promise<string | undefined> {
    const reference = this.references[account];
    if (!reference) return undefined;

    const environmentName = arcanaEnvironmentName(account);
    const source = `import os,sys; sys.stdout.write(os.environ.get(${JSON.stringify(environmentName)}, ""))`;

    return new Promise(resolve => {
      execFile(
        this.command,
        ['run', '--secret', reference, '--env', environmentName, '--', this.runner, '-c', source],
        { timeout: this.timeoutMs },
        (error, stdout) => {
          if (error) {
            resolve(undefined);
            return;
          }
          resolve(stdout.trim() || undefined);
        },
      );
    });
  }

  async set(): Promise<void> {
    throw new Error('Arcana references are read-only; update the secret in Arcana.');
  }

  async delete(): Promise<void> {
    // Arcana references are configuration, not locally persisted values.
  }

  status(): SecretStoreStatus {
    return {
      mode: 'memory',
      available: Object.keys(this.references).length > 0,
      service: 'Arcana Secret Bridge',
    };
  }

  async getSource(account: string): Promise<ApiKeySource> {
    return (await this.get(account)) ? 'arcana' : 'none';
  }

  hasArcanaReference(account?: string): boolean {
    return account ? Boolean(this.references[account]) : Object.keys(this.references).length > 0;
  }

  getArcanaReference(account: string): string | undefined {
    return this.references[account];
  }

  setArcanaReference(account: string, reference: string): void {
    if (!reference.startsWith('arcana://')) {
      throw new Error('Arcana reference must start with arcana://');
    }
    this.references[account] = reference;
  }
}

export class ArcanaFallbackSecretStore implements SecretStore {
  constructor(
    private readonly arcana: ArcanaSecretStore,
    private readonly persistent: SecretStore,
  ) {}

  async get(account: string): Promise<string | undefined> {
    return (await this.arcana.get(account)) ?? this.persistent.get(account);
  }

  async set(account: string, secret: string): Promise<void> {
    return this.persistent.set(account, secret);
  }

  async delete(account: string): Promise<void> {
    await this.arcana.delete();
    await this.persistent.delete(account);
  }

  status(): SecretStoreStatus {
    return this.persistent.status();
  }

  async getSource(account: string): Promise<ApiKeySource> {
    if (await this.arcana.get(account)) return 'arcana';
    return this.persistent.getSource
      ? this.persistent.getSource(account)
      : (await this.persistent.get(account) ? this.persistent.status().mode : 'none');
  }

  hasArcanaReference(account?: string): boolean {
    return this.arcana.hasArcanaReference(account);
  }

  getArcanaReference(account: string): string | undefined {
    return this.arcana.getArcanaReference(account);
  }

  setArcanaReference(account: string, reference: string): void {
    this.arcana.setArcanaReference(account, reference);
  }
}

export interface ArcanaCloudConfig {
  baseUrl: string;
  aegisUrl: string;
  workspaceId: string;
  clientId: string;
  clientSecret: string;
  accessClientId?: string;
  accessClientSecret?: string;
  timeoutMs: number;
}

interface CachedAegisToken {
  token: string;
  expiresAt: number;
}

/**
 * Resolves Arcana references over the network through services/arcana-cloud,
 * for deployments with no OS keychain and no local Arcana daemon to shell
 * out to (e.g. Leyline running headless on Render) — the network-reachable
 * counterpart to ArcanaSecretStore's local child-process bridge. Mints and
 * caches its own Aegis client_credentials token (service_account, arcana:pull
 * scope); if Cloudflare Access sits in front of arcana-cloud, accessClientId/
 * accessClientSecret are sent as service-token headers alongside it.
 */
export class ArcanaCloudSecretStore implements SecretStore {
  private token: CachedAegisToken | undefined;

  constructor(
    private readonly references: Record<string, string>,
    private readonly config: ArcanaCloudConfig,
  ) {}

  async get(account: string): Promise<string | undefined> {
    const reference = this.references[account];
    const parsed = reference ? parseArcanaCloudReference(reference) : undefined;
    if (!parsed) return undefined;

    try {
      const token = await this.getAccessToken();
      const url = `${this.config.baseUrl}/v1/workspaces/${encodeURIComponent(this.config.workspaceId)}/projects/${encodeURIComponent(parsed.project)}/secrets/${encodeURIComponent(parsed.secretName)}`;
      const response = await axios.get(url, {
        timeout: this.config.timeoutMs,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(this.config.accessClientId && this.config.accessClientSecret
            ? {
                'CF-Access-Client-Id': this.config.accessClientId,
                'CF-Access-Client-Secret': this.config.accessClientSecret,
              }
            : {}),
        },
      });
      const value = response.data?.value;
      return typeof value === 'string' && value ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async set(): Promise<void> {
    throw new Error('Arcana Cloud references are read-only; push the secret via the Arcana operator API instead.');
  }

  async delete(): Promise<void> {
    // Arcana Cloud references are configuration, not locally persisted values.
  }

  status(): SecretStoreStatus {
    return {
      mode: 'memory',
      available: Object.keys(this.references).length > 0,
      service: 'Arcana Cloud',
    };
  }

  async getSource(account: string): Promise<ApiKeySource> {
    return (await this.get(account)) ? 'arcana' : 'none';
  }

  hasArcanaReference(account?: string): boolean {
    return account ? Boolean(this.references[account]) : Object.keys(this.references).length > 0;
  }

  getArcanaReference(account: string): string | undefined {
    return this.references[account];
  }

  setArcanaReference(account: string, reference: string): void {
    if (!parseArcanaCloudReference(reference)) {
      throw new Error('Arcana Cloud reference must be arcana-cloud://<project>/<secretName>');
    }
    this.references[account] = reference;
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAt > now) return this.token.token;

    const response = await axios.post(
      `${this.config.aegisUrl}/token`,
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        scope: 'arcana:pull',
      }).toString(),
      {
        timeout: this.config.timeoutMs,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
    );

    const accessToken = response.data?.access_token;
    if (typeof accessToken !== 'string' || !accessToken) {
      throw new Error('Aegis did not return an access token');
    }

    const expiresIn = Number(response.data?.expires_in) || 300;
    this.token = { token: accessToken, expiresAt: now + Math.max(expiresIn - 30, 30) * 1000 };
    return this.token.token;
  }
}

export class ArcanaCloudFallbackSecretStore implements SecretStore {
  constructor(
    private readonly cloud: ArcanaCloudSecretStore,
    private readonly persistent: SecretStore,
  ) {}

  async get(account: string): Promise<string | undefined> {
    return (await this.cloud.get(account)) ?? this.persistent.get(account);
  }

  async set(account: string, secret: string): Promise<void> {
    return this.persistent.set(account, secret);
  }

  async delete(account: string): Promise<void> {
    await this.cloud.delete();
    await this.persistent.delete(account);
  }

  status(): SecretStoreStatus {
    return this.persistent.status();
  }

  async getSource(account: string): Promise<ApiKeySource> {
    if (await this.cloud.get(account)) return 'arcana';
    return this.persistent.getSource
      ? this.persistent.getSource(account)
      : (await this.persistent.get(account) ? this.persistent.status().mode : 'none');
  }

  hasArcanaReference(account?: string): boolean {
    return this.cloud.hasArcanaReference(account);
  }

  getArcanaReference(account: string): string | undefined {
    return this.cloud.getArcanaReference(account);
  }

  setArcanaReference(account: string, reference: string): void {
    this.cloud.setArcanaReference(account, reference);
  }
}

function parseArcanaCloudReference(reference: string): { project: string; secretName: string } | undefined {
  const match = /^arcana-cloud:\/\/([^/]+)\/([^/]+)$/.exec(reference);
  if (!match) return undefined;
  return { project: match[1], secretName: match[2] };
}

function arcanaEnvironmentName(account: string): string {
  if (account === runtimeConfigAccount('LLM API')) return 'LLM_API_BASE_URL';
  const provider = account.replace(/^api-key:/, '');
  const providerEnvironmentNames: Record<string, string> = {
    Gemini: 'GEMINI_API_KEY',
    HuggingFace: 'HF_API_KEY',
    OpenAI: 'OPENAI_API_KEY',
    OpenRouter: 'OPENROUTER_API_KEY',
    AzureOpenAI: 'AZURE_OPENAI_API_KEY',
    'LLM API': 'LLM_API_KEY',
  };
  return providerEnvironmentNames[provider]
    || `${provider.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_API_KEY`;
}

function parseArcanaReferences(): Record<string, string> {
  const references: Record<string, string> = {};
  const raw = process.env.LEYLINE_ARCANA_SECRET_REFS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [account, reference] of Object.entries(parsed)) {
        if (typeof reference === 'string' && reference.startsWith('arcana://')) references[account] = reference;
      }
    } catch {
      // Invalid optional configuration is ignored; Keychain remains available.
    }
  }

  const providers: Record<string, string> = {
    Gemini: 'GEMINI',
    HuggingFace: 'HF',
    OpenAI: 'OPENAI',
    OpenRouter: 'OPENROUTER',
    AzureOpenAI: 'AZURE_OPENAI',
  };
  for (const [provider, envName] of Object.entries(providers)) {
    const reference = process.env[`LEYLINE_ARCANA_${envName}_REF`];
    if (reference?.startsWith('arcana://')) references[apiKeyAccount(provider)] = reference;
  }
  const llmApiKeyReference = process.env.LEYLINE_ARCANA_OPENAI_API_KEY_REF;
  if (llmApiKeyReference?.startsWith('arcana://')) {
    references[apiKeyAccount('LLM API')] = llmApiKeyReference;
  }
  const llmApiUrlReference = process.env.LEYLINE_ARCANA_OPENAI_API_URL_REF;
  if (llmApiUrlReference?.startsWith('arcana://')) {
    references[runtimeConfigAccount('LLM API')] = llmApiUrlReference;
  }
  const janusApiKeyReference = process.env.LEYLINE_ARCANA_JANUS_API_KEY_REF;
  if (janusApiKeyReference?.startsWith('arcana://')) {
    const janusBaseUrl = process.env.LEYLINE_JANUS_BASE_URL || 'http://127.0.0.1:8088';
    references[`janus-api-key:${janusBaseUrl}`] = janusApiKeyReference;
  }
  return references;
}

function parseArcanaCloudReferences(): Record<string, string> {
  const references: Record<string, string> = {};
  const raw = process.env.LEYLINE_ARCANA_CLOUD_SECRET_REFS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [account, reference] of Object.entries(parsed)) {
        if (typeof reference === 'string' && parseArcanaCloudReference(reference)) references[account] = reference;
      }
    } catch {
      // Invalid optional configuration is ignored; the persistent store remains available.
    }
  }

  const providers: Record<string, string> = {
    Gemini: 'GEMINI',
    HuggingFace: 'HF',
    OpenAI: 'OPENAI',
    OpenRouter: 'OPENROUTER',
    AzureOpenAI: 'AZURE_OPENAI',
  };
  for (const [provider, envName] of Object.entries(providers)) {
    const reference = process.env[`LEYLINE_ARCANA_CLOUD_${envName}_REF`];
    if (reference && parseArcanaCloudReference(reference)) references[apiKeyAccount(provider)] = reference;
  }
  const llmApiKeyReference = process.env.LEYLINE_ARCANA_CLOUD_OPENAI_API_KEY_REF;
  if (llmApiKeyReference && parseArcanaCloudReference(llmApiKeyReference)) {
    references[apiKeyAccount('LLM API')] = llmApiKeyReference;
  }
  const llmApiUrlReference = process.env.LEYLINE_ARCANA_CLOUD_OPENAI_API_URL_REF;
  if (llmApiUrlReference && parseArcanaCloudReference(llmApiUrlReference)) {
    references[runtimeConfigAccount('LLM API')] = llmApiUrlReference;
  }
  const janusApiKeyReference = process.env.LEYLINE_ARCANA_CLOUD_JANUS_API_KEY_REF;
  if (janusApiKeyReference && parseArcanaCloudReference(janusApiKeyReference)) {
    const janusBaseUrl = process.env.LEYLINE_JANUS_BASE_URL || 'http://127.0.0.1:8088';
    references[`janus-api-key:${janusBaseUrl}`] = janusApiKeyReference;
  }
  return references;
}

function arcanaCloudConfigFromEnv(): ArcanaCloudConfig | undefined {
  const workspaceId = process.env.LEYLINE_ARCANA_CLOUD_WORKSPACE_ID;
  const clientId = process.env.LEYLINE_ARCANA_CLOUD_CLIENT_ID;
  const clientSecret = process.env.LEYLINE_ARCANA_CLOUD_CLIENT_SECRET;
  if (!workspaceId || !clientId || !clientSecret) return undefined;

  return {
    baseUrl: process.env.LEYLINE_ARCANA_CLOUD_URL || 'https://arcana-cloud.theaiinc.com',
    aegisUrl: process.env.LEYLINE_ARCANA_CLOUD_AEGIS_URL || 'https://id.theaiinc.com',
    workspaceId,
    clientId,
    clientSecret,
    accessClientId: process.env.LEYLINE_ARCANA_CLOUD_ACCESS_CLIENT_ID || undefined,
    accessClientSecret: process.env.LEYLINE_ARCANA_CLOUD_ACCESS_CLIENT_SECRET || undefined,
    timeoutMs: Number.parseInt(process.env.LEYLINE_ARCANA_CLOUD_TIMEOUT_MS || '10000', 10),
  };
}

export function createDefaultSecretStore(): SecretStore {
  const service = process.env.LEYLINE_KEYCHAIN_SERVICE || DEFAULT_KEYCHAIN_SERVICE;
  const enabled = process.env.LEYLINE_KEYCHAIN_ENABLED !== 'false';
  const persistent = enabled
    ? new FallbackSecretStore(new KeychainSecretStore(service), service)
    : new MemorySecretStore(service, 'Apple Keychain persistence is disabled by LEYLINE_KEYCHAIN_ENABLED=false.');

  // arcana-cloud (network) takes precedence over the local Arcana CLI bridge
  // when fully configured — the deployment target (headless/cloud vs. desktop
  // with a local daemon) determines which set of env vars is actually set.
  const arcanaCloudConfig = arcanaCloudConfigFromEnv();
  const arcanaCloudReferences = arcanaCloudConfig ? parseArcanaCloudReferences() : {};
  if (arcanaCloudConfig && Object.keys(arcanaCloudReferences).length > 0) {
    return new ArcanaCloudFallbackSecretStore(new ArcanaCloudSecretStore(arcanaCloudReferences, arcanaCloudConfig), persistent);
  }

  const arcanaReferences = parseArcanaReferences();
  return Object.keys(arcanaReferences).length > 0
    ? new ArcanaFallbackSecretStore(new ArcanaSecretStore(arcanaReferences), persistent)
    : persistent;
}
