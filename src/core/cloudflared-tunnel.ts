import { spawn, ChildProcess } from 'child_process';

export type TunnelState = 'disabled' | 'starting' | 'ready' | 'error';

export interface TunnelInfo {
  enabled: boolean;
  state: TunnelState;
  publicUrl?: string;
  /** OpenAI SDK baseURL — public tunnel URL + `/v1`. */
  publicBaseUrl?: string;
  localUrl?: string;
  error?: string;
}

export interface CloudflaredTunnelOptions {
  enabled: boolean;
  binary: string;
  startupTimeoutMs: number;
}

const TRYCLOUDFLARE_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export function parseCloudflaredPublicUrl(line: string): string | undefined {
  const match = line.match(TRYCLOUDFLARE_URL_PATTERN);
  return match?.[0];
}

export class CloudflaredTunnel {
  private process: ChildProcess | null = null;
  private info: TunnelInfo;
  private startPromise: Promise<TunnelInfo> | null = null;

  constructor(private readonly options: CloudflaredTunnelOptions) {
    this.info = {
      enabled: options.enabled,
      state: options.enabled ? 'starting' : 'disabled',
    };
  }

  getInfo(): TunnelInfo {
    return { ...this.info };
  }

  start(localUrl: string): Promise<TunnelInfo> {
    if (!this.options.enabled) {
      this.info = { enabled: false, state: 'disabled', localUrl };
      return Promise.resolve(this.getInfo());
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.info = {
      enabled: true,
      state: 'starting',
      localUrl,
    };

    this.startPromise = new Promise<TunnelInfo>((resolve) => {
      let settled = false;
      const finish = (info: TunnelInfo) => {
        if (settled) return;
        settled = true;
        this.info = info;
        resolve(info);
      };

      const timeout = setTimeout(() => {
        this.stopProcess();
        finish({
          enabled: true,
          state: 'error',
          localUrl,
          error: `Timed out waiting for cloudflared public URL after ${this.options.startupTimeoutMs}ms`,
        });
      }, this.options.startupTimeoutMs);

      const handleLine = (line: string) => {
        const publicUrl = parseCloudflaredPublicUrl(line);
        if (!publicUrl || this.info.state === 'ready') return;

        clearTimeout(timeout);
        finish({
          enabled: true,
          state: 'ready',
          localUrl,
          publicUrl,
          publicBaseUrl: `${publicUrl.replace(/\/+$/, '')}/v1`,
        });
      };

      try {
        const child = spawn(
          this.options.binary,
          ['tunnel', '--url', localUrl, '--no-autoupdate'],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        this.process = child;

        child.stdout?.on('data', (chunk: Buffer) => {
          chunk.toString('utf8').split(/\r?\n/).forEach(handleLine);
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          chunk.toString('utf8').split(/\r?\n/).forEach(handleLine);
        });

        child.on('error', (error) => {
          clearTimeout(timeout);
          finish({
            enabled: true,
            state: 'error',
            localUrl,
            error: error.message.includes('ENOENT')
              ? `${this.options.binary} not found — install cloudflared or set LEYLINE_TUNNEL_ENABLED=false`
              : error.message,
          });
        });

        child.on('exit', (code, signal) => {
          if (this.info.state === 'ready') return;

          clearTimeout(timeout);
          if (settled) return;

          finish({
            enabled: true,
            state: 'error',
            localUrl,
            error: `cloudflared exited before publishing a URL (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
          });
        });
      } catch (error: any) {
        clearTimeout(timeout);
        finish({
          enabled: true,
          state: 'error',
          localUrl,
          error: error?.message || 'Failed to start cloudflared',
        });
        return;
      }
    });

    return this.startPromise;
  }

  stop(): void {
    this.stopProcess();
    if (this.info.enabled) {
      this.info = {
        ...this.info,
        state: this.info.state === 'ready' ? 'ready' : 'error',
        error: this.info.state === 'ready' ? undefined : this.info.error,
      };
    }
  }

  private stopProcess(): void {
    if (!this.process) return;

    const child = this.process;
    this.process = null;
    child.removeAllListeners();
    child.kill('SIGTERM');
  }
}
