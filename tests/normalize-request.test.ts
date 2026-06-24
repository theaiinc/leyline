import { ensureMessageArray, normalizeCompletionRequest } from '../src/core/normalize-request';

describe('normalizeCompletionRequest', () => {
  it('normalizes multimodal Cursor-style message content', () => {
    const request = normalizeCompletionRequest({
      model: 'gpt-5.5',
      stream: true,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hello Leyline' }],
        },
      ],
    });

    expect(request.messages).toEqual([
      { role: 'user', content: 'Hello Leyline' },
    ]);
  });

  it('wraps a single message object when messages is not an array', () => {
    const request = normalizeCompletionRequest({
      model: 'auto',
      messages: { role: 'user', content: 'ping' },
    });

    expect(request.messages).toEqual([
      { role: 'user', content: 'ping' },
    ]);
  });

  it('returns an empty array when messages is missing', () => {
    expect(normalizeCompletionRequest({ model: 'auto' }).messages).toEqual([]);
  });

  it('preserves tool calls and passthrough request fields from Cursor', () => {
    const request = normalizeCompletionRequest({
      model: 'gpt-5.5',
      stream: true,
      tools: [{ type: 'function', function: { name: 'read_file' } }],
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: 'file contents',
        },
      ],
    });

    expect(request.tools).toHaveLength(1);
    expect(request.messages[0]).toMatchObject({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function' }],
    });
    expect(request.messages[1]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'file contents',
    });
  });

  it('maps developer role to system', () => {
    const request = normalizeCompletionRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'developer', content: 'Be concise' }],
    });

    expect(request.messages[0].role).toBe('system');
  });

  it('accepts OpenAI Responses-style input arrays when messages is absent', () => {
    const request = normalizeCompletionRequest({
      model: 'gpt-5.5',
      stream: true,
      input: [{ role: 'user', content: 'Hello from input' }],
    });

    expect(request.messages).toEqual([
      { role: 'user', content: 'Hello from input' },
    ]);
  });

  it('accepts a plain string input field', () => {
    const request = normalizeCompletionRequest({
      model: 'gpt-5.5',
      input: 'Hello from string input',
    });

    expect(request.messages).toEqual([
      { role: 'user', content: 'Hello from string input' },
    ]);
  });
});

describe('ensureMessageArray', () => {
  it('accepts compressed output that returns a single message object', () => {
    expect(ensureMessageArray({ role: 'user', content: 'compressed' })).toEqual([
      { role: 'user', content: 'compressed' },
    ]);
  });
});
