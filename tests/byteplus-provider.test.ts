import { BytePlusProvider } from '../src/providers/byteplus';

describe('BytePlusProvider', () => {
  const request = {
    model: 'doubao-seed-1-6-251015',
    messages: [{ role: 'user' as const, content: 'hello' }],
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is disabled when the API key is absent', async () => {
    expect(await new BytePlusProvider('').isAvailable()).toBe(false);
  });

  it('only claims BytePlus ModelArk model ids', () => {
    const provider = new BytePlusProvider('test-key');
    expect(provider.servesModel('chat', 'deepseek-v4-1-flash-260910')).toBe(true);
    expect(provider.servesModel('chat', 'gpt-5.6-luna')).toBe(false);
    expect(provider.servesModel('chat', 'claude-sonnet-5-5')).toBe(false);
    expect(provider.servesModel('embeddings', 'seed-1-6-250915')).toBe(false);
  });

  it('disables ModelArk thinking by default and enables it with reasoning_effort', async () => {
    const response = {
      id: 'ark-1',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello back' }, finish_reason: 'stop' }],
    };
    const axios = await import('axios');
    const postMock = jest.spyOn(axios.default, 'post').mockResolvedValue({ data: response });
    const provider = new BytePlusProvider('test-key');

    await provider.complete({ ...request, model: 'deepseek-v4-flash-ga-260731' });
    expect(postMock.mock.calls[0][1]).toEqual(expect.objectContaining({
      model: 'deepseek-v4-flash-ga-260731',
      thinking: { type: 'disabled' },
    }));

    await provider.complete({
      ...request,
      model: 'deepseek-v4-flash-ga-260731',
      reasoning_effort: 'medium',
    });
    expect(postMock.mock.calls[1][1]).toEqual(expect.objectContaining({
      model: 'deepseek-v4-flash-ga-260731',
      thinking: { type: 'enabled' },
    }));
  });

  it('preserves reasoning_content instead of promoting it to content', async () => {
    const response = {
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          reasoning_content: 'private reasoning',
        },
        finish_reason: 'length',
      }],
    };
    const axios = await import('axios');
    jest.spyOn(axios.default, 'post').mockResolvedValue({ data: response });
    const result = await new BytePlusProvider('test-key').complete(request);
    expect(result).toEqual(response);
    expect(result.choices[0].message.content).toBe('');
    expect(result.choices[0].message.reasoning_content).toBe('private reasoning');
  });

  it('preserves reasoning_content in streamed deltas', async () => {
    const stream = 'data: {"choices":[{"delta":{"reasoning_content":"private reasoning","content":""},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n';
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const chunks: unknown[] = [];
    for await (const chunk of new BytePlusProvider('test-key').completeStream(request)) chunks.push(chunk);
    expect(chunks).toEqual([{ choices: [{ delta: { reasoning_content: 'private reasoning', content: '' }, finish_reason: 'length' }] }]);
  });

  it('supports OpenAI-format tool calls', async () => {
    const response = {
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"q":"hello"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    };
    const axios = await import('axios');
    jest.spyOn(axios.default, 'post').mockResolvedValue({ data: response });
    const result = await new BytePlusProvider('test-key').complete({
      ...request,
      tools: [{ type: 'function', function: { name: 'lookup', description: 'Look up a value', parameters: { type: 'object' } } }],
    });
    expect(result).toEqual(response);
  });
});