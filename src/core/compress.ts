import { spawn } from 'child_process';
import { config } from '../config';
import type { CompletionRequest } from './types';

let bridgeWarned = false;

interface CompressResult {
  messages: Array<{ role: string; content: string }>;
  tokens_before: number;
  tokens_after: number;
  tokens_saved: number;
  compression_ratio: number;
  transforms_applied: string[];
  compressed: boolean;
}

/**
 * Build input JSON for the headroom-compress subprocess.
 */
function buildInput(request: CompletionRequest): string {
  const input: Record<string, unknown> = {
    messages: request.messages,
    model: request.model || 'gpt-4o',
  };
  return JSON.stringify(input);
}

/**
 * Compress messages using @theaiinc/headroom-ai Python bridge.
 *
 * Spawns `headroom-compress` (or falls back to `python3 -m headroom.json_cli`)
 * with JSON on stdin. Returns compressed messages synchronously.
 *
 * Only active when LEYLINE_COMPRESSION_ENABLED=true and
 * the Python headroom-ai package is installed.
 */
export async function maybeCompress(
  request: CompletionRequest,
): Promise<CompletionRequest> {
  if (!config.compression.enabled) return request;

  try {
    const result = await runCompression(request);
    if (result?.compressed && Array.isArray(result.messages) && result.messages.length > 0) {
      return { ...request, messages: result.messages.map((message) => ({
        role: typeof message.role === 'string' ? message.role : 'user',
        content: typeof message.content === 'string' ? message.content : String(message.content ?? ''),
      })) };
    }
  } catch (err: any) {
    if (!bridgeWarned) {
      console.warn(`[Leyline] Compression failed: ${err.message}. Install: pip install headroom-ai`);
      bridgeWarned = true;
    }
  }

  return request;
}

/**
 * Run compression via the headroom-compress CLI.
 */
async function runCompression(request: CompletionRequest): Promise<CompressResult> {
  return new Promise((resolve, reject) => {
    const input = buildInput(request);

    // Try the installed entry point first, fall back to python -m
    const proc = spawn('headroom-compress', [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('error', () => {
      // headroom-compress not on PATH — try python3 -m
      const fallback = spawn('python3', ['-m', 'headroom.json_cli'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let fbStdout = '';
      let fbStderr = '';
      fallback.stdout!.on('data', (chunk: Buffer) => { fbStdout += chunk.toString(); });
      fallback.stderr!.on('data', (chunk: Buffer) => { fbStderr += chunk.toString(); });
      fallback.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(fbStderr.trim() || `Exit code ${code}`));
          return;
        }
        parseAndResolve(fbStdout, resolve, reject);
      });
      fallback.on('error', (err) => reject(err));
      fallback.stdin!.write(input);
      fallback.stdin!.end();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Exit code ${code}`));
        return;
      }
      parseAndResolve(stdout, resolve, reject);
    });

    proc.stdin!.write(input);
    proc.stdin!.end();
  });
}

function parseAndResolve(
  raw: string,
  resolve: (value: CompressResult) => void,
  reject: (reason: unknown) => void,
): void {
  try {
    const data = JSON.parse(raw);
    if (data.error) {
      reject(new Error(data.error));
      return;
    }
    resolve(data as CompressResult);
  } catch {
    reject(new Error(`Invalid JSON from headroom: ${raw.slice(0, 200)}`));
  }
}

/**
 * Check whether compression is configured and available.
 */
export function isCompressionAvailable(): Promise<boolean> {
  if (!config.compression.enabled) return Promise.resolve(false);
  return new Promise((resolve) => {
    const proc = spawn('headroom-compress', ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => {
      // Fallback: check python module
      const fb = spawn('python3', ['-c', 'from headroom import compress; print("ok")'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      fb.on('close', (fbCode) => resolve(fbCode === 0));
      fb.on('error', () => resolve(false));
    });
  });
}
