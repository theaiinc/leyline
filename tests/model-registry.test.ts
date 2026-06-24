import { ModelRegistry } from '../src/core/model-registry';
import { ModelVariant } from '../src/core/types';

// ── Reusable test variants ──────────────────────────────────────────

const TEST_VARIANTS: ModelVariant[] = [
  {
    id: 'google/gemma-4-12b',
    name: 'Gemma 4 12B Q4_K_M',
    family: 'gemma-4',
    provider: 'openai',
    source: 'lmstudio',
    parameter_size_b: 12,
    quantization: 'Q4_K_M',
    context_length: 262_144,
    capabilities: { tools: true, thinking: true, vision: true, code: true, embedding: false },
    billing_class: 'free_local',
    resource_class: 'standard',
  },
  {
    id: 'google/gemma-4-e2b',
    name: 'Gemma 4 e2B',
    family: 'gemma-4',
    provider: 'openai',
    source: 'lmstudio',
    parameter_size_b: 2,
    quantization: 'fp16',
    context_length: 262_144,
    capabilities: { tools: true, thinking: true, vision: false, code: false, embedding: false },
    billing_class: 'free_local',
    resource_class: 'standard',
  },
  {
    id: 'qwen3:8b',
    name: 'Qwen 3 8B Q4_K_M',
    family: 'qwen3',
    provider: 'ollama',
    source: 'ollama',
    parameter_size_b: 8,
    quantization: 'Q4_K_M',
    context_length: 40_960,
    capabilities: { tools: true, thinking: true, vision: false, code: true, embedding: false },
    billing_class: 'free_local',
    resource_class: 'standard',
  },
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    family: 'deepseek-v4',
    provider: 'deepseek',
    source: 'deepseek',
    parameter_size_b: 0, // proprietary
    quantization: 'unknown',
    context_length: 128_000,
    capabilities: { tools: true, thinking: true, vision: false, code: true, embedding: false },
    billing_class: 'paid_api',
    resource_class: 'standard',
  },
  {
    id: 'arch-router-1.5b.gguf',
    name: 'Arch Router 1.5B',
    family: 'qwen2',
    provider: 'openai',
    source: 'lmstudio',
    parameter_size_b: 1.5,
    quantization: 'Q4_K_M',
    context_length: 32_768,
    capabilities: { tools: false, thinking: false, vision: false, code: false, embedding: false },
    billing_class: 'free_local',
    resource_class: 'light',
  },
];

describe('ModelRegistry', () => {
  let registry: ModelRegistry;

  beforeEach(() => {
    registry = new ModelRegistry(TEST_VARIANTS);
  });

  // ── Construction ─────────────────────────────────────────────────

  it('should accept custom variants at construction', () => {
    expect(registry.listVariants()).toHaveLength(TEST_VARIANTS.length);
  });

  it('should use default variants when none provided', () => {
    const defaultRegistry = new ModelRegistry();
    expect(defaultRegistry.listVariants().length).toBeGreaterThan(0);
    // Defaults should include the built-in cloud provider variants
    const variants = defaultRegistry.listVariants();
    expect(variants.some(v => v.provider === 'gemini')).toBe(true);
    expect(variants.some(v => v.provider === 'huggingface')).toBe(true);
    expect(variants.some(v => v.provider === 'openai')).toBe(true);
    expect(variants.some(v => v.provider === 'openrouter')).toBe(true);
    expect(variants.some(v => v.provider === 'azureopenai')).toBe(true);
    expect(variants.some(v => v.provider === 'ollama')).toBe(true);
  });

  it('should include gpt-5.5 as a default OpenAI variant', () => {
    const defaultRegistry = new ModelRegistry();
    const variant = defaultRegistry.lookupVariant('openai', 'gpt-5.5');

    expect(variant).not.toBeNull();
    expect(variant!.provider).toBe('openai');
    expect(variant!.billing_class).toBe('paid_api');
    expect(defaultRegistry.resolveCapabilities('openai', 'gpt-5.5').tier).toBe('cognitive');
  });

  it('should replace variants at runtime via setVariants', () => {
    const smaller: ModelVariant[] = [TEST_VARIANTS[0]!];
    registry.setVariants(smaller);
    expect(registry.listVariants()).toHaveLength(1);
  });

  // ── lookupVariant ────────────────────────────────────────────────

  it('should return null for null/undefined model', () => {
    expect(registry.lookupVariant('openai', null)).toBeNull();
    expect(registry.lookupVariant('openai', undefined)).toBeNull();
  });

  it('should find exact (provider, id) match', () => {
    const v = registry.lookupVariant('openai', 'google/gemma-4-12b');
    expect(v).not.toBeNull();
    expect(v!.id).toBe('google/gemma-4-12b');
    expect(v!.parameter_size_b).toBe(12);
  });

  it('should find prefix match — provider matches, model starts with id', () => {
    // "google/gemma-4-12b" is a prefix of "google/gemma-4-12b-something"
    const v = registry.lookupVariant('openai', 'google/gemma-4-12b-fine-tuned-v2');
    expect(v).not.toBeNull();
    expect(v!.id).toBe('google/gemma-4-12b');
  });

  it('should find bare exact match (ignoring provider)', () => {
    const v = registry.lookupVariant('unknown', 'google/gemma-4-12b');
    expect(v).not.toBeNull();
    expect(v!.id).toBe('google/gemma-4-12b');
  });

  it('should find bare prefix match (longest wins)', () => {
    // Both "google/gemma-4" and "google/gemma-4-12b" are prefixes,
    // but "google/gemma-4-12b" is longer so it should win
    const v = registry.lookupVariant(null, 'google/gemma-4-12b-super-fine-tuned');
    expect(v).not.toBeNull();
    expect(v!.id).toBe('google/gemma-4-12b');
  });

  it('should return null for completely unknown model', () => {
    const v = registry.lookupVariant('openai', 'nonexistent-model-9000');
    expect(v).toBeNull();
  });

  it('should be case-sensitive for provider matching', () => {
    const v = registry.lookupVariant('OpenAI', 'google/gemma-4-12b');
    expect(v).not.toBeNull(); // provider is lowercased internally
  });

  // ── inferBillingClass ────────────────────────────────────────────

  it('should return correct billing class for known variants', () => {
    expect(registry.inferBillingClass('openai', 'google/gemma-4-12b')).toBe('free_local');
    expect(registry.inferBillingClass('deepseek', 'deepseek-v4-flash')).toBe('paid_api');
  });

  it('should return uncertain for unknown variants', () => {
    expect(registry.inferBillingClass('openai', 'unknown-model')).toBe('uncertain');
  });

  // ── inferResourceClass ───────────────────────────────────────────

  it('should return correct resource class', () => {
    expect(registry.inferResourceClass('openai', 'arch-router-1.5b.gguf')).toBe('light');
    expect(registry.inferResourceClass('openai', 'google/gemma-4-12b')).toBe('standard');
  });

  it('should return standard as default for unknown', () => {
    expect(registry.inferResourceClass(null, 'bogus')).toBe('standard');
  });

  // ── getContextLength ─────────────────────────────────────────────

  it('should return context length from variant', () => {
    expect(registry.getContextLength('openai', 'google/gemma-4-12b')).toBe(262_144);
    expect(registry.getContextLength('ollama', 'qwen3:8b')).toBe(40_960);
  });

  it('should return 128_000 as default for unknown', () => {
    expect(registry.getContextLength(null, 'bogus')).toBe(128_000);
  });

  // ── validateModelProvider ────────────────────────────────────────

  it('should return null for valid provider+model pairs', () => {
    expect(registry.validateModelProvider('openai', 'google/gemma-4-12b')).toBeNull();
    expect(registry.validateModelProvider('ollama', 'qwen3:8b')).toBeNull();
  });

  it('should return error for mismatched provider+model pairs', () => {
    const err = registry.validateModelProvider('ollama', 'google/gemma-4-12b');
    expect(err).toContain('expects provider "openai"');
  });

  it('should return null when no model is provided', () => {
    expect(registry.validateModelProvider('openai', null)).toBeNull();
  });

  // ── resolveCapabilities ──────────────────────────────────────────

  it('should return utility tier for ≤3B models', () => {
    const caps = registry.resolveCapabilities('openai', 'arch-router-1.5b.gguf');
    expect(caps.tier).toBe('utility');
    expect(caps.canDelegate).toBe(false);
    expect(caps.maxOutputTokens).toBe(128);
  });

  it('should return operational tier for >3B and ≤6B models', () => {
    // No variant in this range in our test set; create one inline
    const custom = new ModelRegistry([
      { ...TEST_VARIANTS[1]!, parameter_size_b: 4, id: 'custom-4b' },
    ]);
    const caps = custom.resolveCapabilities('openai', 'custom-4b');
    expect(caps.tier).toBe('operational');
    expect(caps.canDelegate).toBe(true);
    expect(caps.maxOutputTokens).toBe(384);
  });

  it('should return cognitive tier for >6B models', () => {
    const caps = registry.resolveCapabilities('openai', 'google/gemma-4-12b');
    expect(caps.tier).toBe('cognitive');
    expect(caps.canDelegate).toBe(true);
    expect(caps.maxOutputTokens).toBe(1024);
  });

  it('should return cognitive tier for proprietary (0 param_size) models', () => {
    const caps = registry.resolveCapabilities('deepseek', 'deepseek-v4-flash');
    expect(caps.tier).toBe('cognitive');
  });

  it('should return cognitive tier for unknown variants (safest default)', () => {
    const caps = registry.resolveCapabilities('openai', 'some-unknown-model');
    expect(caps.tier).toBe('cognitive');
  });

  // ── resolveExecutionMode ─────────────────────────────────────────

  it('should return reactive for ≤3B models', () => {
    expect(registry.resolveExecutionMode('openai', 'arch-router-1.5b.gguf')).toBe('reactive');
  });

  it('should return guided for >3B and ≤6B models', () => {
    const custom = new ModelRegistry([
      { ...TEST_VARIANTS[1]!, parameter_size_b: 4, id: 'custom-4b' },
    ]);
    expect(custom.resolveExecutionMode('openai', 'custom-4b')).toBe('guided');
  });

  it('should return deliberative for >6B models', () => {
    expect(registry.resolveExecutionMode('openai', 'google/gemma-4-12b')).toBe('deliberative');
  });

  it('should return deliberative for unknown (safest default)', () => {
    expect(registry.resolveExecutionMode(null, 'bogus')).toBe('deliberative');
  });

  it('should return deliberative for proprietary models', () => {
    expect(registry.resolveExecutionMode('deepseek', 'deepseek-v4-flash')).toBe('deliberative');
  });
});
