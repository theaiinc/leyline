// ── Existing request/response types ──────────────────────────────────

export interface CompletionRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
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
