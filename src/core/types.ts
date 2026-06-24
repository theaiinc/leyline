// ── Existing request/response types ──────────────────────────────────

export interface ChatMessage {
  role: string;
  content?: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: unknown;
  tool_choice?: unknown;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  response_format?: unknown;
  seed?: number;
  stop?: string | string[];
  user?: string;
  parallel_tool_calls?: boolean;
  reasoning_effort?: string;
  [key: string]: unknown;
}

export interface CompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface ModelDetail {
  id: string;
  name?: string;
  description?: string;
  score?: number;
}

export interface Provider {
  name: string;
  defaultModel: string;
  isAvailable(): Promise<boolean>;
  getModels(): Promise<ModelDetail[]>;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  completeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown>;
}

export interface ApiKeyConfigurableProvider extends Provider {
  setApiKey(apiKey: string): void;
  hasApiKey(): boolean;
}

export interface RuntimeConfigurableProvider extends Provider {
  getRuntimeConfig(): Record<string, string | boolean | undefined>;
  setRuntimeConfig(config: Record<string, string | undefined>): void;
}

export interface Quota {
  requestsPerMinute: number;
  requestsPerDay: number;
}

// ── NEW: Model registry types ─────────────────────────────────────────

export type BillingClass =
  | 'free_local'
  | 'paid_api'
  | 'subscription_external'
  | 'uncertain';

export type ResourceClass = 'light' | 'standard' | 'gpu';

export interface ModelVariant {
  /** The exact model string the LLM API expects. */
  id: string;
  /** Human‑readable display name. */
  name: string;
  /** Model family, e.g. "gemma-4", "qwen3", "deepseek-v4". */
  family: string;
  /** Which provider family this model belongs to. */
  provider: string;
  /** Provider sub‑type for pricing/display. */
  source: string;
  /** Total parameters in billions. */
  parameter_size_b: number;
  /** For MoE models, active params in billions. */
  active_params_b?: number;
  quantization: string;
  context_length: number;
  capabilities: {
    tools: boolean;
    thinking: boolean;
    vision: boolean;
    code: boolean;
    embedding: boolean;
  };
  billing_class: BillingClass;
  resource_class: ResourceClass;
}

// ── NEW: Router classification types ─────────────────────────────────

export interface RouterClassification {
  complexity: 'simple' | 'medium' | 'complex';
  domain: 'chat' | 'coding' | 'planning' | 'workflow' | 'memory' | 'extraction';
  reasoning: boolean;
}

export interface ClassifyRequest {
  userMessage: string;
  chatHistory?: Array<{ role: string; content: string }>;
}

export interface RouteResult {
  classification: RouterClassification | null;
  selectedTier: string;
  selectedModel: string | null;
  selectedProvider: string | null;
}

/** Tier key → model name mapping. Example: { '2b': 'gemma-4-2b', '4b': 'qwen3:8b', '12b': 'gemma-4-12b' } */
export interface TierConfig {
  [tier: string]: string | undefined;
}
