import { spawn, ChildProcess } from 'child_process';
import axios from 'axios';
import type { TunnelInfo, TunnelState } from './cloudflared-tunnel';

export interface JanusTunnelOptions {
  enabled: boolean;
  command: string;
  configPath?: string;
  baseUrl: string;
  serviceId: string;
  publicUrl?: string;
  startupTimeoutMs: number;
  autoStart: boolean;
  apiKey?: string;
  pairingCode?: string;
  secretStore?: { get(account: string): Promise<string | undefined>; set(account: string, secret: string): Promise<void> };
  credentialAccount?: string;
}

interface JanusService {
  id: string;
  localUrl?: string;
  activeTunnel?: string;
  tunnels?: Array<{ id: string; url: string; status?: string }>;
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
        await this.registerService(localUrl, this.options.publicUrl);
      }

      const service = await this.waitForService();
      const publicUrl = this.activeTunnelUrl(service);
      if (!publicUrl) {
        throw new Error(
          `Janus service "${this.options.serviceId}" has no active healthy tunnel URL. Configure LEYLINE_JANUS_PUBLIC_URL or register the service in Janus.`,
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
    this.process = spawn(this.options.command, args, {
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

  private async registerService(localUrl: string, publicUrl: string): Promise<void> {
    const baseUrl = this.options.baseUrl.replace(/\/+$/, '');
    try {
      await axios.post(`${baseUrl}/api/services`, {
        id: this.options.serviceId,
        name: this.options.serviceId,
        hostname: new URL(publicUrl).host,
        localUrl,
        healthPath: '/healthz',
        tunnels: [{ id: 'primary', url: publicUrl }],
      }, {
        timeout: 2_000,
        headers: this.authHeaders(),
      });
    } catch (error: any) {
      if (error?.response?.status === 409) {
        await axios.post(`${baseUrl}/api/services/${encodeURIComponent(this.options.serviceId)}/refresh`, undefined, {
          timeout: 2_000,
          headers: this.authHeaders(),
        });
        return;
      }
      throw error;
    }
  }

  private async waitForService(): Promise<JanusService> {
    const deadline = Date.now() + this.options.startupTimeoutMs;
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/api/services/${encodeURIComponent(this.options.serviceId)}`;
    let lastError = 'Janus service is not ready';

    while (Date.now() < deadline) {
      try {
      const response = await axios.get<JanusService>(url, {
        timeout: 1_000,
        headers: this.authHeaders(),
      });
        if (response.status === 200) return response.data;
        lastError = `Janus returned HTTP ${response.status}`;
      } catch (error: any) {
        lastError = error?.message || lastError;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    throw new Error(`Timed out waiting for Janus service "${this.options.serviceId}": ${lastError}`);
  }

  private activeTunnelUrl(service: JanusService): string | undefined {
    const active = service.tunnels?.find(
      tunnel => tunnel.id === service.activeTunnel && tunnel.url && tunnel.status === 'healthy',
    );
    return active?.url || service.tunnels?.find(
      tunnel => tunnel.url && (tunnel.status === 'healthy' || !tunnel.status),
    )?.url;
  }
}

export type { TunnelInfo, TunnelState };
