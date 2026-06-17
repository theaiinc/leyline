import { Classifier, ClassifyFn, ROUTER_PROMPT } from '../src/core/classifier';
import { RouterClassification, ClassifyRequest } from '../src/core/types';

describe('Classifier', () => {
  // ── ROUTER_PROMPT assertion ───────────────────────────────────────

  it('ROUTER_PROMPT should contain the required output format', () => {
    expect(ROUTER_PROMPT).toContain('COMPLEXITY: simple | medium | complex');
    expect(ROUTER_PROMPT).toContain('DOMAIN: chat | coding | planning | workflow | memory | extraction');
    expect(ROUTER_PROMPT).toContain('REASONING: true | false');
  });

  // ── _parseOutput (tested indirectly via classifyRequest with mock) ─

  it('should parse a valid 3-line router response', async () => {
    const mockFn: ClassifyFn = async () =>
      'COMPLEXITY: complex\nDOMAIN: coding\nREASONING: true';
    const classifier = new Classifier(mockFn);
    const result = await classifier.classifyRequest({ userMessage: 'build a todo app' });
    expect(result).toEqual<RouterClassification>({
      complexity: 'complex',
      domain: 'coding',
      reasoning: true,
    });
  });

  it('should parse a simple chat request', async () => {
    const mockFn: ClassifyFn = async () =>
      'COMPLEXITY: simple\nDOMAIN: chat\nREASONING: false';
    const classifier = new Classifier(mockFn);
    const result = await classifier.classifyRequest({ userMessage: 'hello' });
    expect(result).toEqual<RouterClassification>({
      complexity: 'simple',
      domain: 'chat',
      reasoning: false,
    });
  });

  it('should parse a medium planning request', async () => {
    const mockFn: ClassifyFn = async () =>
      'COMPLEXITY: medium\nDOMAIN: planning\nREASONING: true';
    const classifier = new Classifier(mockFn);
    const result = await classifier.classifyRequest({ userMessage: 'design the architecture' });
    expect(result).toEqual<RouterClassification>({
      complexity: 'medium',
      domain: 'planning',
      reasoning: true,
    });
  });

  it('should handle extra whitespace and partial lines gracefully', async () => {
    const mockFn: ClassifyFn = async () => `
COMPLEXITY:   medium
DOMAIN: memory
REASONING:  false
`;
    const classifier = new Classifier(mockFn);
    const result = await classifier.classifyRequest({ userMessage: 'remember my preferences' });
    expect(result).toEqual<RouterClassification>({
      complexity: 'medium',
      domain: 'memory',
      reasoning: false,
    });
  });

  it('should default to simple/chat on invalid output', async () => {
    const mockFn: ClassifyFn = async () => 'this is not valid router output';
    const classifier = new Classifier(mockFn);
    const result = await classifier.classifyRequest({ userMessage: 'test' });
    expect(result).toEqual<RouterClassification>({
      complexity: 'simple',
      domain: 'chat',
      reasoning: false,
    });
  });

  it('should fallback to simple/chat on LLM error', async () => {
    const mockFn: ClassifyFn = async () => { throw new Error('LLM unavailable'); };
    const classifier = new Classifier(mockFn);
    const result = await classifier.classifyRequest({ userMessage: 'test' });
    expect(result).toEqual<RouterClassification>({
      complexity: 'simple',
      domain: 'chat',
      reasoning: false,
    });
  });

  it('should include chat history in the context sent to the classify function', async () => {
    let capturedUserMessage = '';
    const mockFn: ClassifyFn = async (_system, userMessage) => {
      capturedUserMessage = userMessage;
      return 'COMPLEXITY: simple\nDOMAIN: chat\nREASONING: false';
    };
    const classifier = new Classifier(mockFn);
    await classifier.classifyRequest({
      userMessage: 'fix that too',
      chatHistory: [
        { role: 'user', content: 'build a todo app' },
        { role: 'assistant', content: 'sure, here is the code' },
      ],
    });
    expect(capturedUserMessage).toContain('fix that too');
    expect(capturedUserMessage).toContain('USER: build a todo app');
    expect(capturedUserMessage).toContain('ASSISTANT: sure, here is the code');
  });

  it('should ignore invalid complexity values', async () => {
    const mockFn: ClassifyFn = async () =>
      'COMPLEXITY: ultra\nDOMAIN: coding\nREASONING: true';
    const classifier = new Classifier(mockFn);
    const result = await classifier.classifyRequest({ userMessage: 'test' });
    // Should default to 'simple' since 'ultra' is not valid
    expect(result.complexity).toBe('simple');
    expect(result.domain).toBe('coding');
    expect(result.reasoning).toBe(true);
  });

  it('should ignore invalid domain values', async () => {
    const mockFn: ClassifyFn = async () =>
      'COMPLEXITY: complex\nDOMAIN: gaming\nREASONING: false';
    const classifier = new Classifier(mockFn);
    const result = await classifier.classifyRequest({ userMessage: 'test' });
    expect(result.complexity).toBe('complex');
    // Should default to 'chat' since 'gaming' is not valid
    expect(result.domain).toBe('chat');
    expect(result.reasoning).toBe(false);
  });

  it('should handle empty response from LLM', async () => {
    const mockFn: ClassifyFn = async () => '';
    const classifier = new Classifier(mockFn);
    const result = await classifier.classifyRequest({ userMessage: 'test' });
    expect(result).toEqual<RouterClassification>({
      complexity: 'simple',
      domain: 'chat',
      reasoning: false,
    });
  });

  it('should expose setClassifyFn for runtime replacement', async () => {
    let callCount = 0;
    const fn1: ClassifyFn = async () => {
      callCount++;
      return 'COMPLEXITY: simple\nDOMAIN: chat\nREASONING: false';
    };
    const fn2: ClassifyFn = async () => {
      callCount++;
      return 'COMPLEXITY: complex\nDOMAIN: coding\nREASONING: true';
    };
    const classifier = new Classifier(fn1);
    await classifier.classifyRequest({ userMessage: 'hi' });
    expect(callCount).toBe(1);

    classifier.setClassifyFn(fn2);
    const result = await classifier.classifyRequest({ userMessage: 'build an app' });
    expect(callCount).toBe(2);
    expect(result).toEqual<RouterClassification>({
      complexity: 'complex',
      domain: 'coding',
      reasoning: true,
    });
  });
});
