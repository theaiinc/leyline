import { execFile, type ExecFileException } from 'child_process';

export type ApiKeyPersistenceMode = 'keychain' | 'memory' | 'localStorage';
export type ApiKeySource = ApiKeyPersistenceMode | 'env' | 'none';

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

  status(): SecretStoreStatus {
    const primaryStatus = this.primary.status();
    if (primaryStatus.available) return primaryStatus;

    return {
      ...this.memory.status(),
      warning: primaryStatus.warning || this.memory.status().warning,
    };
  }
}

export function createDefaultSecretStore(): SecretStore {
  const service = process.env.LEYLINE_KEYCHAIN_SERVICE || DEFAULT_KEYCHAIN_SERVICE;
  const enabled = process.env.LEYLINE_KEYCHAIN_ENABLED !== 'false';

  if (!enabled) {
    return new MemorySecretStore(service, 'Apple Keychain persistence is disabled by LEYLINE_KEYCHAIN_ENABLED=false.');
  }

  return new FallbackSecretStore(new KeychainSecretStore(service), service);
}
