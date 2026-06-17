import dotenv from 'dotenv';

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
  OPENROUTER: string;
  OLLAMA: string;
}

export interface LeylineConfig {
  port: number;
  quotas: {
    gemini: QuotaConfig;
    huggingface: QuotaConfig;
    openrouter: QuotaConfig;
    ollama: QuotaConfig;
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
}

// ── Default config ────────────────────────────────────────────────────

export const config: LeylineConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  quotas: {
    gemini: {
       requestsPerMinute: parseInt(process.env.GEMINI_QUOTA_RPM || '10', 10),
       requestsPerDay: parseInt(process.env.GEMINI_QUOTA_RPD || '1000', 10),
    },
    huggingface: {
        requestsPerMinute: parseInt(process.env.HF_QUOTA_RPM || '100', 10),
        requestsPerDay: parseInt(process.env.HF_QUOTA_RPD || '1000', 10),
    },
    openrouter: {
        requestsPerMinute: parseInt(process.env.OPENROUTER_QUOTA_RPM || '20', 10),
        requestsPerDay: parseInt(process.env.OPENROUTER_QUOTA_RPD || '200', 10),
    },
    ollama: {
        requestsPerMinute: 999999,
        requestsPerDay: 999999,
    },
  },
  DEFAULT_MODELS: {
      GEMINI: process.env.GEMINI_DEFAULT_MODEL || 'gemini-2.0-flash',
      HF: process.env.HF_DEFAULT_MODEL || 'microsoft/Phi-3-mini-4k-instruct',
      OPENROUTER: process.env.OPENROUTER_DEFAULT_MODEL || 'mistralai/mistral-7b-instruct:free',
      OLLAMA: process.env.OLLAMA_DEFAULT_MODEL || 'llama2',
  },
  routerModel: {
    model: process.env.LEYLINE_ROUTER_MODEL || process.env.OASIS_ROUTER_MODEL || '',
    baseUrl: process.env.LEYLINE_OPENAI_BASE_URL || process.env.OASIS_OPENAI_BASE_URL || 'http://localhost:1234/v1',
    maxTokens: parseInt(process.env.LEYLINE_ROUTER_MAX_TOKENS || '64', 10),
    temperature: parseFloat(process.env.LEYLINE_ROUTER_TEMPERATURE || '0'),
  },
  tierModels: {
    '2b': process.env.LEYLINE_MODEL_2B || process.env.OASIS_MODEL_2B || '',
    '4b': process.env.LEYLINE_MODEL_4B || process.env.OASIS_MODEL_4B || '',
    '12b': process.env.LEYLINE_MODEL_12B || process.env.OASIS_MODEL_12B || '',
  },
  customVariants: process.env.LEYLINE_CUSTOM_VARIANTS || '',
};
