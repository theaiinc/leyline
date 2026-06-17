import { ModelVariant, BillingClass, ResourceClass } from './types';

/**
 * Configurable model variant registry.
 *
 * Callers provide their own variant list at construction time so model
 * definitions live in the *consumer's* config, not
 * inside leyline itself.
 *
 * Leyline provides a small set of sensible defaults for the built-in
 * cloud providers so the standalone `npx @theaiinc/leyline` server
 * works out of the box.  Custom variants *replace* the defaults when
 * provided by the consumer (no automatic merge — the consumer owns the
 * full set).
 */
export class ModelRegistry {
  private variants: ModelVariant[];

  constructor(variants?: ModelVariant[]) {
    this.variants = variants ?? getDefaultVariants();
  }

  /** Replace the entire variant set at runtime. */
  setVariants(variants: ModelVariant[]) {
    this.variants = variants;
  }

  /** Get all registered variants. */
  listVariants(): ModelVariant[] {
    return [...this.variants];
  }

  /**
   * Find the best‑matching ModelVariant for a (provider, model) pair.
   *
   * Resolution order:
   *   1. Exact match on (provider, id)
   *   2. Prefix match — provider matches, model starts with entry's id
   *   3. Exact match on bare id (ignoring provider)
   *   4. Prefix match on bare id
   *   5. `null` (unknown)
   */
  lookupVariant(
    provider: string | null | undefined,
    model: string | null | undefined,
  ): ModelVariant | null {
    if (!model) return null;

    const normProvider = (provider || '').toLowerCase();
    const normModel = model.trim();

    // 1. Exact (provider, id)
    for (const v of this.variants) {
      if (v.provider === normProvider && v.id === normModel) return v;
    }

    // 2. Prefix — provider matches, model starts with entry's id
    for (const v of this.variants) {
      if (v.provider === normProvider && normModel.startsWith(v.id)) return v;
    }

    // 3. Bare exact
    for (const v of this.variants) {
      if (v.id === normModel) return v;
    }

    // 4. Bare prefix (pick longest match)
    let best: ModelVariant | null = null;
    let bestLen = 0;
    for (const v of this.variants) {
      if (normModel.startsWith(v.id) && v.id.length > bestLen) {
        best = v;
        bestLen = v.id.length;
      }
    }
    return best;
  }

  /** Infer billing class from (provider, model). Returns 'uncertain' if unknown. */
  inferBillingClass(
    provider: string | null | undefined,
    model: string | null | undefined,
  ): BillingClass {
    return this.lookupVariant(provider, model)?.billing_class ?? 'uncertain';
  }

  /** Infer resource class. Returns 'standard' if unknown. */
  inferResourceClass(
    provider: string | null | undefined,
    model: string | null | undefined,
  ): ResourceClass {
    return this.lookupVariant(provider, model)?.resource_class ?? 'standard';
  }

  /** Get context length. Returns 128_000 as default. */
  getContextLength(
    provider: string | null | undefined,
    model: string | null | undefined,
  ): number {
    return this.lookupVariant(provider, model)?.context_length ?? 128_000;
  }

  /**
   * Validate that a (provider, model) pair is consistent.
   * Returns `null` if valid, or an error message if the pair doesn't
   * match any known variant's provider assignment.
   */
  validateModelProvider(
    provider: string | null | undefined,
    model: string | null | undefined,
  ): string | null {
    if (!model) return null;
    const v = this.lookupVariant(null, model);
    if (!v) return null;
    if (!provider) return null;
    const normProvider = provider.toLowerCase();
    if (v.provider !== normProvider && v.provider !== normProvider.replace(/:.+$/, '')) {
      return `Model "${model}" expects provider "${v.provider}" but got "${provider}"`;
    }
    return null;
  }

  // ── Capability helpers ────────────────────────────────────────────

  /**
   * Resolve tool capabilities based on model parameter size.
   *
   * Tiering:
   *   ≤3B  → UTILITY: core only (no delegation, no complex tools)
   *   ≤6B  → OPERATIONAL: core + delegation
   *   >6B  → COGNITIVE: full
   *   0 (unknown/proprietary) → full (safest default)
   */
  resolveCapabilities(
    provider?: string | null,
    model?: string | null,
  ): { canGetRule: boolean; canDelegate: boolean; tier: 'utility' | 'operational' | 'cognitive'; maxOutputTokens: number } {
    const v = this.lookupVariant(provider, model);
    if (!v) return { canGetRule: true, canDelegate: true, tier: 'cognitive', maxOutputTokens: 4096 };
    const size = v.parameter_size_b;
    if (size <= 0) return { canGetRule: true, canDelegate: true, tier: 'cognitive', maxOutputTokens: 4096 };
    if (size <= 3) return { canGetRule: false, canDelegate: false, tier: 'utility', maxOutputTokens: 128 };
    if (size <= 6) return { canGetRule: true, canDelegate: true, tier: 'operational', maxOutputTokens: 384 };
    return { canGetRule: true, canDelegate: true, tier: 'cognitive', maxOutputTokens: 1024 };
  }

  /**
   * Resolve execution mode based on model size.
   *   reactive:    no thinking, act immediately (utility tier)
   *   guided:      minimal reasoning budget (operational tier)
   *   deliberative: full reasoning before each action (cognitive tier)
   */
  resolveExecutionMode(
    provider?: string | null,
    model?: string | null,
  ): 'reactive' | 'guided' | 'deliberative' {
    const v = this.lookupVariant(provider, model);
    if (!v) return 'deliberative';
    const size = v.parameter_size_b;
    if (size <= 0) return 'deliberative';
    if (size <= 3) return 'reactive';
    if (size <= 6) return 'guided';
    return 'deliberative';
  }
}

// ── Default variants (cloud providers only) ──────────────────────────
// These let the standalone server work out of the box.
// Consumers that need local models pass their own variants.

function getDefaultVariants(): ModelVariant[] {
  return [
    // Gemini (cloud)
    {
      id: 'gemini-2.0-flash',
      name: 'Gemini 2.0 Flash',
      family: 'gemini-2',
      provider: 'gemini',
      source: 'gemini',
      parameter_size_b: 0,
      quantization: 'unknown',
      context_length: 1_048_576,
      capabilities: { tools: true, thinking: true, vision: true, code: true, embedding: false },
      billing_class: 'paid_api',
      resource_class: 'standard',
    },
    // HuggingFace models
    {
      id: 'microsoft/Phi-3-mini-4k-instruct',
      name: 'Phi-3 Mini 4K',
      family: 'phi-3',
      provider: 'huggingface',
      source: 'huggingface',
      parameter_size_b: 3.8,
      quantization: 'unknown',
      context_length: 4_096,
      capabilities: { tools: false, thinking: false, vision: false, code: true, embedding: false },
      billing_class: 'paid_api',
      resource_class: 'standard',
    },
    {
      id: 'mistralai/Mistral-7B-Instruct-v0.3',
      name: 'Mistral 7B v0.3',
      family: 'mistral',
      provider: 'huggingface',
      source: 'huggingface',
      parameter_size_b: 7,
      quantization: 'unknown',
      context_length: 32_768,
      capabilities: { tools: false, thinking: false, vision: false, code: true, embedding: false },
      billing_class: 'paid_api',
      resource_class: 'standard',
    },
    // OpenRouter generic
    {
      id: 'mistralai/mistral-7b-instruct:free',
      name: 'Mistral 7B (free)',
      family: 'mistral',
      provider: 'openrouter',
      source: 'openrouter',
      parameter_size_b: 7,
      quantization: 'unknown',
      context_length: 32_768,
      capabilities: { tools: false, thinking: false, vision: false, code: true, embedding: false },
      billing_class: 'paid_api',
      resource_class: 'standard',
    },
    // Ollama default
    {
      id: 'llama2',
      name: 'Llama 2',
      family: 'llama',
      provider: 'ollama',
      source: 'ollama',
      parameter_size_b: 7,
      quantization: 'Q4_K_M',
      context_length: 4_096,
      capabilities: { tools: false, thinking: false, vision: false, code: false, embedding: false },
      billing_class: 'free_local',
      resource_class: 'standard',
    },
  ];
}
