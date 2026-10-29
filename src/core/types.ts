import type { ContentPart } from './content';

export type { ContentPart } from './content';

// ── Existing request/response types ──────────────────────────────────

export interface ChatMessage {
  role: string;
  /** A string, or OpenAI content parts (text, image_url, input_audio, file, …) passed through as sent. */
  content?: string | ContentPart[] | null;
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
    message: { role: string; content: string; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cached_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    cache_creation_input_tokens?: number;
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
    cached_tokens?: number;
  };
}

export interface ModelDetail {
  id: string;
  name?: string;
  description?: string;
  score?: number;
  /** The price the provider publishes for this model, in US dollars per million tokens. */
  pricing?: { input: number; output: number };
}

// ── Capabilities beyond chat (embeddings, speech-to-text, text-to-speech) ──

/** What a provider serves. Providers that don't say serve chat only. */
export type Capability = 'chat' | 'embeddings' | 'transcription' | 'speech';

export interface EmbeddingRequest {
  model: string;
  /** Always a list here (the server turns a single string into one). */
  input: string[];
  dimensions?: number;
  user?: string;
}

export interface EmbeddingResult {
  /** One vector per input, in input order. */
  embeddings: number[][];
  /** The model that made them (as the provider names it). */
  model: string;
  usage?: { prompt_tokens: number; total_tokens?: number };
}

export interface AudioFile {
  data: Uint8Array;
  filename: string;
  contentType: string;
}

export interface TranscriptSegment { id: number; start: number; end: number; text: string }
export interface TranscriptWord { word: string; start: number; end: number }

export interface TranscriptionRequest {
  model: string;
  file: AudioFile;
  language?: string;
  prompt?: string;
  temperature?: number;
  /** Timestamps the client wants back (verbose_json, srt, vtt or timestamp_granularities). */
  timestamps: { segment: boolean; word: boolean };
}

/** A transcript in one shape whatever the provider; the server formats it as the client asked (json, srt …). */
export interface TranscriptionResult {
  text: string;
  language?: string;
  /** Seconds of audio (billing uses it). */
  duration?: number;
  segments?: TranscriptSegment[];
  words?: TranscriptWord[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface SpeechRequest {
  model: string;
  input: string;
  voice?: string;
  response_format?: string;
  speed?: number;
  instructions?: string;
}

export interface SpeechResult {
  audio: Uint8Array;
  contentType: string;
}

export interface Provider {
  name: string;
  /** Provider family shared across instances, e.g. 'AzureOpenAI'. Unset for single-instance providers. */
  family?: string;
  /** Human-readable label for this instance, may differ from `name`. */
  label?: string;
  defaultModel: string;
  isAvailable(): Promise<boolean>;
  getModels(): Promise<ModelDetail[]>;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  completeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown>;
  /** What it serves; unset: chat only. Chat routing skips providers that don't list 'chat'. */
  capabilities?: Capability[];
  /** Whether it serves `model` for a non-chat capability (by name: text-embedding-*, whisper-1, @cf/…). */
  servesModel?(capability: Capability, model: string): boolean;
  /** Whether the models it lists (GET /models) can be asked for this capability (gateways such as llmapi.ai). */
  servesListedModels?(capability: Capability): boolean;
  /** The model it uses when a client asks for `auto` (undefined: it doesn't take part in auto). */
  defaultModelFor?(capability: Capability): string | undefined;
  embed?(request: EmbeddingRequest): Promise<EmbeddingResult>;
  transcribe?(request: TranscriptionRequest): Promise<TranscriptionResult>;
  speak?(request: SpeechRequest): Promise<SpeechResult>;
  /**
   * Whether it can take this request's non-text content (images, audio, files) for `request.model`. Unset: it
   * passes content parts through to an OpenAI-compatible upstream, which decides. Providers that would drop the
   * parts say false, and the router sends such requests elsewhere (or answers 400) rather than let a model
   * answer about an image it never saw.
   */
  acceptsNonTextContent?(request: CompletionRequest): boolean;
}

/** Whether a provider takes chat completions (every provider that doesn't declare capabilities does). */
export function servesChat(provider: Provider): boolean {
  return !provider.capabilities || provider.capabilities.includes('chat');
}

export interface RouteOptions {
  /** Bypass routing/candidate selection and force this exact provider name. */
  forceProvider?: string;
  /** Told which provider and model served the request (the last one tried, when an earlier one failed). */
  onServed?: (provider: string, model: string) => void;
  /** Providers not to use for this request (at their monthly spend limit, hosted.ts). */
  excludeProviders?: string[];
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
  chatHistory?: Array<{ role: string; content: string | ContentPart[] | null }>;
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
