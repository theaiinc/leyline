import dotenv from 'dotenv';
import { randomBytes } from 'crypto';

dotenv.config();

// ── Configuration types (exported for consumers) ──────────────────────

export interface QuotaConfig {
  requestsPerMinute: number;
  requestsPerDay: number;
}

export interface RouterModelConfig {
  /** Model name for the lightweight router classifier (e.g. 'arch-router-1.5b.gguf'). */
  model: string;
  /** Base URL for the LLM endpoint that hosts the router model. */
  baseUrl: string;
  /** Max tokens for router model output (default 64 — 3 lines is tiny). */
  maxTokens: number;
  /** Temperature for router model (default 0 — deterministic). */
  temperature: number;
}

export interface DefaultModelsConfig {
  GEMINI: string;
  HF: string;
  OPENAI: string;
  OPENROUTER: string;
  OLLAMA: string;
  AZURE_OPENAI: string;
}

export interface CompressionConfig {
  /** Enable prompt/context compression before sending to providers (default: false). */
  enabled: boolean;
  /** Model hint sent to headroom-ai for compression routing. */
  model: string;
  /** Optional token budget — compress to fit within this limit. */
  tokenBudget: number | undefined;
}

export interface SingleModelConfig {
  /** Disable dynamic routing and force all requests to one provider/model. */
  enabled: boolean;
  /** Optional provider name (e.g. OpenAI, AzureOpenAI, Ollama). Inferred from the registry when omitted. */
  provider: string;
  /** The model/deployment to send every request to when single-model mode is enabled. */
  model: string;
}

export interface TunnelConfig {
  /** Start a Cloudflare quick tunnel so cloud clients can reach Leyline. */
  enabled: boolean;
  /** cloudflared binary name or path. */
  binary: string;
  /** Max time to wait for trycloudflare.com URL on startup. */
  startupTimeoutMs: number;
}

/** Default Bearer token clients send when calling Leyline's OpenAI-compatible API. */
export const DEFAULT_LEYLINE_CLIENT_API_KEY = 'leyline';

export function resolveClientApiKey(): string {
  if (process.env.LEYLINE_CLIENT_AUTH_ENABLED === 'false') return '';
  if (process.env.LEYLINE_CLIENT_API_KEY !== undefined) return process.env.LEYLINE_CLIENT_API_KEY;
  if (process.env.LEYLINE_TUNNEL_ENABLED !== 'false') return `ll-${randomBytes(32).toString('base64url')}`;
  return DEFAULT_LEYLINE_CLIENT_API_KEY;
}

export interface LeylineConfig {
  port: number;
  quotas: {
    /** When false, Leyline does not enforce RPM/RPD caps (providers enforce their own limits). */
    enabled: boolean;
    gemini: QuotaConfig;
    huggingface: QuotaConfig;
    openai: QuotaConfig;
    openrouter: QuotaConfig;
    ollama: QuotaConfig;
    azureOpenAI: QuotaConfig;
  };
  DEFAULT_MODELS: DefaultModelsConfig;
  routerModel: RouterModelConfig;
  /** Maps tier labels to actual model names (e.g. '2b' → 'gemma-4-2b'). */
  tierModels: Record<string, string | undefined>;
  /**
   * JSON string of custom ModelVariant[].
   * If set, the ModelRegistry uses these instead of the built-in defaults.
   */
  customVariants: string;
  compression: CompressionConfig;
  singleModel: SingleModelConfig;
  /** Expected client Bearer token for /v1/* endpoints. Empty string disables validation. */
  clientApiKey: string;
  tunnel: TunnelConfig;
  /** Max JSON request body size (express limit string, e.g. 50mb). */
  bodyLimit: string;
}

// ── Default config ────────────────────────────────────────────────────

export const config: LeylineConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  quotas: {
    enabled: process.env.LEYLINE_QUOTAS_ENABLED === 'true',
    gemini: {
       requestsPerMinute: parseInt(process.env.GEMINI_QUOTA_RPM || '10', 10),
       requestsPerDay: parseInt(process.env.GEMINI_QUOTA_RPD || '1000', 10),
    },
    huggingface: {
        requestsPerMinute: parseInt(process.env.HF_QUOTA_RPM || '100', 10),
        requestsPerDay: parseInt(process.env.HF_QUOTA_RPD || '1000', 10),
    },
    openai: {
        requestsPerMinute: parseInt(process.env.OPENAI_QUOTA_RPM || '60', 10),
        requestsPerDay: parseInt(process.env.OPENAI_QUOTA_RPD || '1000', 10),
    },
    openrouter: {
        requestsPerMinute: parseInt(process.env.OPENROUTER_QUOTA_RPM || '20', 10),
        requestsPerDay: parseInt(process.env.OPENROUTER_QUOTA_RPD || '200', 10),
    },
    ollama: {
        requestsPerMinute: 999999,
        requestsPerDay: 999999,
    },
    azureOpenAI: {
        requestsPerMinute: parseInt(process.env.AZURE_OPENAI_QUOTA_RPM || '60', 10),
        requestsPerDay: parseInt(process.env.AZURE_OPENAI_QUOTA_RPD || '1000', 10),
    },
  },
  DEFAULT_MODELS: {
      GEMINI: process.env.GEMINI_DEFAULT_MODEL || 'gemini-2.0-flash',
      HF: process.env.HF_DEFAULT_MODEL || 'microsoft/Phi-3-mini-4k-instruct',
      OPENAI: process.env.OPENAI_DEFAULT_MODEL || 'gpt-5.5',
      OPENROUTER: process.env.OPENROUTER_DEFAULT_MODEL || 'mistralai/mistral-7b-instruct:free',
      OLLAMA: process.env.OLLAMA_DEFAULT_MODEL || 'llama2',
      AZURE_OPENAI: process.env.AZURE_OPENAI_DEFAULT_MODEL || process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5.5',
  },
  routerModel: {
    model: process.env.LEYLINE_ROUTER_MODEL || '',
    baseUrl: process.env.LEYLINE_OPENAI_BASE_URL || 'http://localhost:1234/v1',
    maxTokens: parseInt(process.env.LEYLINE_ROUTER_MAX_TOKENS || '64', 10),
    temperature: parseFloat(process.env.LEYLINE_ROUTER_TEMPERATURE || '0'),
  },
  tierModels: {
    '2b': process.env.LEYLINE_MODEL_2B || '',
    '4b': process.env.LEYLINE_MODEL_4B || '',
    '12b': process.env.LEYLINE_MODEL_12B || '',
  },
  customVariants: process.env.LEYLINE_CUSTOM_VARIANTS || '',
  compression: {
    enabled: process.env.LEYLINE_COMPRESSION_ENABLED === 'true',
    model: process.env.LEYLINE_COMPRESSION_MODEL || '',
    tokenBudget: process.env.LEYLINE_COMPRESSION_TOKEN_BUDGET ? parseInt(process.env.LEYLINE_COMPRESSION_TOKEN_BUDGET, 10) : undefined,
  },
  singleModel: {
    enabled: process.env.LEYLINE_ROUTER_ENABLED === 'false' || process.env.LEYLINE_SINGLE_MODEL_ENABLED === 'true',
    provider: process.env.LEYLINE_FIXED_PROVIDER || '',
    model: process.env.LEYLINE_FIXED_MODEL || '',
  },
  clientApiKey: resolveClientApiKey(),
  tunnel: {
    enabled: process.env.LEYLINE_TUNNEL_ENABLED !== 'false',
    binary: process.env.LEYLINE_TUNNEL_BINARY || 'cloudflared',
    startupTimeoutMs: parseInt(process.env.LEYLINE_TUNNEL_TIMEOUT_MS || '45000', 10),
  },
  bodyLimit: process.env.LEYLINE_BODY_LIMIT || '100mb',
};
