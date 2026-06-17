import { Router, selectModelByRouter } from '../src/core/router';
import { QuotaManager } from '../src/core/quota-manager';
import { ModelRegistry } from '../src/core/model-registry';
import { Classifier } from '../src/core/classifier';
import {
  Provider, CompletionRequest, CompletionResponse, StreamChunk, ModelDetail,
  RouterClassification, ClassifyRequest, RouteResult, ModelVariant,
} from '../src/core/types';

// ── Test data ────────────────────────────────────────────────────────

const TEST_VARIANTS: ModelVariant[] = [
  { id: 'tiny-model', name: 'Tiny 2B', family: 'test', provider: 'openai', source: 'lmstudio', parameter_size_b: 2, quantization: 'Q4', context_length: 8192, capabilities: { tools: false, thinking: false, vision: false, code: false, embedding: false }, billing_class: 'free_local', resource_class: 'light' },
  { id: 'mid-model', name: 'Mid 4B', family: 'test', provider: 'openai', source: 'lmstudio', parameter_size_b: 4, quantization: 'Q4', context_length: 16384, capabilities: { tools: true, thinking: false, vision: false, code: true, embedding: false }, billing_class: 'free_local', resource_class: 'standard' },
  { id: 'big-model', name: 'Big 12B', family: 'test', provider: 'openai', source: 'lmstudio', parameter_size_b: 12, quantization: 'Q4', context_length: 32768, capabilities: { tools: true, thinking: true, vision: true, code: true, embedding: false }, billing_class: 'free_local', resource_class: 'standard' },
  { id: 'deepseek-v4', name: 'DeepSeek V4', family: 'deepseek', provider: 'deepseek', source: 'deepseek', parameter_size_b: 0, quantization: 'fp16', context_length: 128000, capabilities: { tools: true, thinking: true, vision: false, code: true, embedding: false }, billing_class: 'paid_api', resource_class: 'standard' },
];

const TIER_CONFIG = {
  '2b': 'tiny-model',
  '4b': 'mid-model',
  '12b': 'big-model',
};

// ── selectModelByRouter unit tests ──────────────────────────────────

describe('selectModelByRouter', () => {
  it('should return 4b when classification is null (router failure fallback)', () => {
    expect(selectModelByRouter(null)).toBe('4b');
  });

  it.each([
    ['memory domain → 2b', { complexity: 'simple', domain: 'memory', reasoning: false }, '2b'],
    ['extraction domain → 2b', { complexity: 'complex', domain: 'extraction', reasoning: false }, '2b'],
    ['workflow domain → 12b', { complexity: 'simple', domain: 'workflow', reasoning: false }, '12b'],
    ['planning domain → 12b', { complexity: 'simple', domain: 'planning', reasoning: false }, '12b'],
    ['coding + medium → 12b', { complexity: 'medium', domain: 'coding', reasoning: false }, '12b'],
    ['coding + complex → 12b', { complexity: 'complex', domain: 'coding', reasoning: false }, '12b'],
    ['coding + simple → 2b (complexity fallback)', { complexity: 'simple', domain: 'coding', reasoning: false }, '2b'],
    ['reasoning=true → 12b', { complexity: 'simple', domain: 'chat', reasoning: true }, '12b'],
    ['simple complexity → 2b', { complexity: 'simple', domain: 'chat', reasoning: false }, '2b'],
    ['medium complexity → 4b', { complexity: 'medium', domain: 'chat', reasoning: false }, '4b'],
    ['complex complexity → 12b', { complexity: 'complex', domain: 'chat', reasoning: false }, '12b'],
  ])('%s', (_label, input, expected) => {
    expect(selectModelByRouter(input as RouterClassification)).toBe(expected);
  });
});

// ── Mock provider ────────────────────────────────────────────────────

class MockProvider implements Provider {
  name: string;
  defaultModel: string;
  shouldFail = false;
  shouldThrow = false;

  constructor(name: string) {
    this.name = name;
    this.defaultModel = `default-${name}`;
  }

  async isAvailable(): Promise<boolean> { return !this.shouldFail; }
  async getModels(): Promise<ModelDetail[]> { return []; }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (this.shouldThrow) throw new Error('Simulated failure');
    return { id: 'mock', object: 'mock', created: Date.now(), model: 'mock', choices: [{ index: 0, message: { role: 'assistant', content: `Response from ${this.name}` }, finish_reason: 'stop' }] };
  }

  async *completeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
    if (this.shouldThrow) throw new Error('Simulated failure');
    yield { id: 'mock', object: 'mock', created: Date.now(), model: 'mock', choices: [{ index: 0, delta: { content: `Response from ${this.name}` }, finish_reason: null }] };
  }
}

// ── Router extended tests ────────────────────────────────────────────

describe('Router (extended methods)', () => {
  let registry: ModelRegistry;
  let router: Router;

  beforeEach(() => {
    registry = new ModelRegistry(TEST_VARIANTS);
    router = new Router({
      quotaManager: new QuotaManager(),
      modelRegistry: registry,
      tierConfig: TIER_CONFIG,
    });
  });

  // ── resolveRoute ────────────────────────────────────────────────

  it('should resolveRoute without classifier (no classification)', async () => {
    const result = await router.resolveRoute({ userMessage: 'hello' });
    expect(result).toMatchObject<Partial<RouteResult>>({
      classification: null,
      selectedTier: '4b', // default from codePolicy(null)
      selectedModel: 'mid-model',
      selectedProvider: 'openai',
    });
  });

  it('should resolveRoute with classifier', async () => {
    const mockClassify = jest.fn().mockResolvedValue('COMPLEXITY: complex\nDOMAIN: coding\nREASONING: true');
    const classifier = new Classifier(mockClassify);
    router.setClassifier(classifier);

    const result = await router.resolveRoute({ userMessage: 'build a todo app' });
    expect(mockClassify).toHaveBeenCalledTimes(1);
    expect(result.classification).toEqual<RouterClassification>({
      complexity: 'complex',
      domain: 'coding',
      reasoning: true,
    });
    expect(result.selectedTier).toBe('12b');
    expect(result.selectedModel).toBe('big-model');
    expect(result.selectedProvider).toBe('openai');
  });

  it('should resolveRoute with simple chat (2b tier)', async () => {
    const classifier = new Classifier(async () => 'COMPLEXITY: simple\nDOMAIN: chat\nREASONING: false');
    router.setClassifier(classifier);

    const result = await router.resolveRoute({ userMessage: 'hello' });
    expect(result.selectedTier).toBe('2b');
    expect(result.selectedModel).toBe('tiny-model');
  });

  it('should resolveRoute with deepseek provider', async () => {
    const router2 = new Router({
      modelRegistry: new ModelRegistry(TEST_VARIANTS),
      tierConfig: { '12b': 'deepseek-v4' },
    });
    const classifier = new Classifier(async () => 'COMPLEXITY: complex\nDOMAIN: coding\nREASONING: true');
    router2.setClassifier(classifier);

    const result = await router2.resolveRoute({ userMessage: 'complex task' });
    expect(result.selectedTier).toBe('12b');
    expect(result.selectedModel).toBe('deepseek-v4');
    expect(result.selectedProvider).toBe('deepseek');
  });

  it('should handle classifier failure gracefully in resolveRoute', async () => {
    const classifier = new Classifier(async () => { throw new Error('network error'); });
    router.setClassifier(classifier);

    const result = await router.resolveRoute({ userMessage: 'test' });
    // Should fallback to simple/chat and then 4b from codePolicy(null) logic... wait
    // classifyRequest returns safe fallback on error. Let me verify:
    expect(result.classification).toEqual<RouterClassification>({
      complexity: 'simple',
      domain: 'chat',
      reasoning: false,
    });
    expect(result.selectedTier).toBe('2b');
  });

  // ── resolveEffectiveModel ───────────────────────────────────────

  it('should resolve effective model for casual route (4b default)', () => {
    const result = router.resolveEffectiveModel('casual');
    expect(result.model).toBe('mid-model');
    expect(result.provider).toBe('openai');
    expect(result.routing).toContain('casual');
    expect(result.routing).toContain('4b');
  });

  it('should resolve effective model for tool_use route with classification override', () => {
    const classification: RouterClassification = { complexity: 'simple', domain: 'chat', reasoning: false };
    const result = router.resolveEffectiveModel('tool_use', classification);
    // tool_use forces minimum 12b regardless of classifier
    expect(result.model).toBe('big-model');
    expect(result.routing).toContain('tool_use');
    expect(result.routing).toContain('12b');
  });

  it('should resolve effective model for complex route (12b default)', () => {
    const result = router.resolveEffectiveModel('complex');
    expect(result.model).toBe('big-model');
    expect(result.routing).toContain('complex:12b');
  });

  it('should apply code policy override for complex+coding request', () => {
    const classification: RouterClassification = { complexity: 'complex', domain: 'coding', reasoning: true };
    const result = router.resolveEffectiveModel('complex', classification);
    // Policy says coding+complex → 12b, which is same as default for complex
    expect(result.model).toBe('big-model');
  });

  it('should apply code policy downgrade for simple chat on complex route', () => {
    const classification: RouterClassification = { complexity: 'simple', domain: 'chat', reasoning: false };
    const result = router.resolveEffectiveModel('complex', classification);
    // Code policy says simple → 2b, but complex route default is 12b
    // The policy overrides the default
    expect(result.model).toBe('tiny-model');
    expect(result.routing).toContain('policy override');
  });

  it('should handle null model from unresolved tier', () => {
    const badRouter = new Router({
      modelRegistry: new ModelRegistry(TEST_VARIANTS),
      tierConfig: { '2b': '', '4b': '', '12b': '' },
    });
    const result = badRouter.resolveEffectiveModel('casual');
    expect(result.model).toBeNull();
    expect(result.provider).toBeNull();
  });

  // ── Runtime configuration updates ────────────────────────────────

  it('should allow runtime tier config updates via setTierConfig', async () => {
    // Start with no classifier — returns default tier
    let result = await router.resolveRoute({ userMessage: 'test' });
    expect(result.selectedModel).toBe('mid-model'); // 4b default

    // Update tier config
    router.setTierConfig({ '4b': 'big-model' });
    result = await router.resolveRoute({ userMessage: 'test' });
    expect(result.selectedModel).toBe('big-model');
  });

  it('should allow runtime code policy replacement via setCodePolicy', async () => {
    const customPolicy = jest.fn().mockReturnValue('12b');
    router.setCodePolicy(customPolicy as any);

    const result = await router.resolveRoute({ userMessage: 'test' });
    expect(customPolicy).toHaveBeenCalled();
    expect(result.selectedTier).toBe('12b');
    expect(result.selectedModel).toBe('big-model');
  });

  it('should allow runtime service tier updates via setServiceTiers', () => {
    router.setServiceTiers({ casual: '12b', tool_use: '12b' });
    const result = router.resolveEffectiveModel('casual');
    expect(result.model).toBe('big-model');
  });

  it('should allow runtime classifier replacement via setClassifier', async () => {
    const classifier1 = new Classifier(async () => 'COMPLEXITY: simple\nDOMAIN: chat\nREASONING: false');
    const classifier2 = new Classifier(async () => 'COMPLEXITY: complex\nDOMAIN: coding\nREASONING: true');
    router.setClassifier(classifier1);

    let result = await router.resolveRoute({ userMessage: 'test' });
    expect(result.selectedTier).toBe('2b');

    router.setClassifier(classifier2);
    result = await router.resolveRoute({ userMessage: 'test' });
    expect(result.selectedTier).toBe('12b');
  });

  // ── Backward compatibility ──────────────────────────────────────

  it('should still work with old constructor (QuotaManager only)', async () => {
    const oldRouter = new Router(new QuotaManager());
    const p1 = new MockProvider('p1');
    oldRouter.addProvider(p1);

    const response = await oldRouter.route({ model: 'test', messages: [] });
    expect(response.choices[0].message.content).toContain('p1');
  });

  // ── Edge cases ─────────────────────────────────────────────────

  it('should handle empty classifier (unset) in resolveRoute', async () => {
    router.setClassifier(undefined);
    const result = await router.resolveRoute({ userMessage: 'hi' });
    expect(result.classification).toBeNull();
    expect(result.selectedTier).toBe('4b');
  });

  it('should handle empty chat history in resolveRoute', async () => {
    const classifier = new Classifier(async () => 'COMPLEXITY: simple\nDOMAIN: chat\nREASONING: false');
    router.setClassifier(classifier);

    const result = await router.resolveRoute({
      userMessage: 'hi',
      chatHistory: [],
    });
    expect(result.selectedTier).toBe('2b');
  });
});
