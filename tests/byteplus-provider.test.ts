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

  it('does not claim unrelated OpenAI or Anthropic model ids', () => {
    const provider = new BytePlusProvider('test-key');
    expect(provider.servesModel('chat', 'gpt-5.6-luna')).toBe(false);
    expect(provider.servesModel('chat', 'claude-sonnet-5-5')).toBe(false);
    expect(provider.servesModel('chat', 'doubao-seed-1-6-251015')).toBe(true);
  });

  it('supports normal OpenAI-compatible replies', async () => {
    const response = {
      id: 'ark-1',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello back' }, finish_reason: 'stop' }],
    };
    const axios = await import('axios');
    const postMock = jest.spyOn(axios.default, 'post').mockResolvedValue({ data: response });
    const result = await new BytePlusProvider('test-key').complete(request);
    expect(result).toEqual(response);
    expect(postMock).toHaveBeenCalledWith(
      'https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions',
      expect.objectContaining({ model: request.model, messages: request.messages, stream: false }),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    );
  });

  it('supports streamed replies', async () => {
    const stream = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n';
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const chunks = [];
    for await (const chunk of new BytePlusProvider('test-key').completeStream(request)) chunks.push(chunk);
    expect(chunks).toEqual([{ choices: [{ delta: { content: 'hello' } }] }]);
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