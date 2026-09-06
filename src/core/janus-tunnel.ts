import { spawn, ChildProcess } from 'child_process';
import axios from 'axios';
import type { TunnelInfo, TunnelState } from './cloudflared-tunnel';

export interface JanusTunnelOptions {
  enabled: boolean;
  command: string;
  configPath?: string;
  baseUrl: string;
  serviceId: string;
  namespace: string;
  alias: string;
  publicUrl?: string;
  startupTimeoutMs: number;
  autoStart: boolean;
  apiKey?: string;
  pairingCode?: string;
  secretStore?: { get(account: string): Promise<string | undefined>; set(account: string, secret: string): Promise<void> };
  credentialAccount?: string;
}

export class JanusTunnel {
  private process: ChildProcess | null = null;
  private info: TunnelInfo;
  private startPromise: Promise<TunnelInfo> | null = null;
  private processPairingCode: Promise<string | undefined> | null = null;
  private pairingCodeResolve: ((code: string | undefined) => void) | null = null;
  private apiKey: string | undefined;

  constructor(private readonly options: JanusTunnelOptions) {
    this.info = {
      enabled: options.enabled,
      state: options.enabled ? 'starting' : 'disabled',
    };
    this.apiKey = options.apiKey;
  }

  getInfo(): TunnelInfo {
    return { ...this.info };
  }

  start(localUrl: string): Promise<TunnelInfo> {
    if (!this.options.enabled) {
      this.info = { enabled: false, state: 'disabled', localUrl };
      return Promise.resolve(this.getInfo());
    }
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startInternal(localUrl);
    return this.startPromise;
  }

  stop(): void {
    if (!this.process) return;
    this.process.kill('SIGTERM');
    this.process = null;
  }

  private async startInternal(localUrl: string): Promise<TunnelInfo> {
    this.info = { enabled: true, state: 'starting', localUrl };

    try {
      if (this.options.autoStart && !(await this.janusIsReady())) {
        this.startProcess();
        await this.waitForJanus();
      }

      await this.ensureCredential();

      if (this.options.publicUrl) {
        await this.registerAlias(localUrl, this.options.publicUrl);
      }

      const publicUrl = await this.waitForAliasEndpoint();
      if (!publicUrl) {
        throw new Error(
          `Janus alias "${this.options.namespace}/${this.options.alias}" has no active healthy endpoint. Configure LEYLINE_JANUS_PUBLIC_URL or register the alias in Janus.`,
        );
      }

      this.info = {
        enabled: true,
        state: 'ready',
        localUrl,
        publicUrl,
        publicBaseUrl: `${publicUrl.replace(/\/+$/, '')}/v1`,
      };
    } catch (error: any) {
      this.info = {
        enabled: true,
        state: 'error',
        localUrl,
        error: error?.message || 'Failed to start Janus external URL',
      };
    }

    return this.getInfo();
  }

  private startProcess(): void {
    const args = ['run'];
    if (this.options.configPath) args.push('--config', this.options.configPath);
    const pathEntries = [
      process.env.PATH,
      process.platform === 'darwin' ? '/opt/homebrew/bin' : undefined,
      process.platform === 'darwin' ? '/usr/local/bin' : undefined,
      process.env.HOME ? `${process.env.HOME}/.local/bin` : undefined,
    ].filter((entry): entry is string => Boolean(entry));
    this.process = spawn(this.options.command, args, {
      env: {
        ...process.env,
        PATH: pathEntries.join(':'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.processPairingCode = new Promise(resolve => {
      this.pairingCodeResolve = resolve;
      setTimeout(() => {
        this.pairingCodeResolve?.(undefined);
        this.pairingCodeResolve = null;
      }, 10_000);
    });
    this.process.stdout?.on('data', chunk => {
      const output = chunk.toString();
      const match = output.match(/mobile pairing code:\s*([A-Z0-9-]+)/i);
      if (match) {
        this.pairingCodeResolve?.(match[1].trim());
        this.pairingCodeResolve = null;
      }
      console.log(`[Janus] ${output.trim()}`);
    });
    this.process.stderr?.on('data', chunk => console.warn(`[Janus] ${chunk.toString().trim()}`));
    this.process.on('error', error => console.warn(`[Janus] ${error.message}`));
  }

  private async janusIsReady(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.options.baseUrl.replace(/\/+$/, '')}/api/status`, {
        timeout: 500,
        headers: this.authHeaders(),
      });
      return response.status === 200 || response.status === 401;
    } catch {
      return false;
    }
  }

  private async waitForJanus(): Promise<void> {
    const deadline = Date.now() + this.options.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.janusIsReady()) return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('Timed out waiting for Janus API');
  }

  private async ensureCredential(): Promise<void> {
    const status = await axios.get(`${this.options.baseUrl.replace(/\/+$/, '')}/api/status`, {
      timeout: 1_000,
      validateStatus: status => status === 200 || status === 401,
      headers: this.authHeaders(),
    });
    if (status.status === 200) return;
    if (this.apiKey) return;

    const account = this.options.credentialAccount || `janus-api-key:${this.options.baseUrl}`;
    if (this.options.secretStore) {
      this.apiKey = await this.options.secretStore.get(account);
    }
    if (!this.apiKey) {
      const pairingCode = this.options.pairingCode
        || (this.processPairingCode ? await this.processPairingCode : undefined);
      if (!pairingCode) {
        throw new Error('Janus requires authentication; no API key or pairing code is available');
      }
      const response = await axios.post<{ apiKey: string }>(
        `${this.options.baseUrl.replace(/\/+$/, '')}/api/auth/pairing/exchange`,
        { code: pairingCode },
        { timeout: 2_000 },
      );
      this.apiKey = response.data.apiKey;
      if (this.options.secretStore && this.apiKey) {
        await this.options.secretStore.set(account, this.apiKey);
      }
    }
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  private async registerAlias(localUrl: string, publicUrl: string): Promise<void> {
    const baseUrl = this.options.baseUrl.replace(/\/+$/, '');
    await axios.put(
      `${baseUrl}/api/namespaces/${encodeURIComponent(this.options.namespace)}/aliases/${encodeURIComponent(this.options.alias)}`,
      {
        namespace: this.options.namespace,
        alias: this.options.alias,
        id: this.options.serviceId,
        name: this.options.serviceId,
        hostname: new URL(publicUrl).host,
        localUrl,
        healthPath: '/healthz',
        tunnels: [{ id: 'primary', url: publicUrl }],
      },
      { timeout: 2_000, headers: this.authHeaders() },
    );
  }

  private async waitForAliasEndpoint(): Promise<string | undefined> {
    const deadline = Date.now() + this.options.startupTimeoutMs;
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/api/namespaces/${encodeURIComponent(this.options.namespace)}/aliases/${encodeURIComponent(this.options.alias)}/endpoint`;
    let lastError = 'Janus alias endpoint is not ready';

    while (Date.now() < deadline) {
      try {
        const response = await axios.get<{ url?: string; status?: string }>(url, {
          timeout: 1_000,
          headers: this.authHeaders(),
        });
        if (response.status === 200 && response.data.url && response.data.status === 'healthy') {
          return response.data.url;
        }
        lastError = `Janus returned HTTP ${response.status}`;
      } catch (error: any) {
        lastError = error?.message || lastError;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    throw new Error(`Timed out waiting for Janus alias "${this.options.namespace}/${this.options.alias}": ${lastError}`);
  }
}

export type { TunnelInfo, TunnelState };
