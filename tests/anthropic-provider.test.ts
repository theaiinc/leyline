import { AnthropicProvider, fromAnthropicResponse, toAnthropicRequest } from '../src/providers/anthropic';

const realFetch = global.fetch;
function mockFetch(response: Response): jest.Mock {
  const mock = jest.fn().mockResolvedValue(response);
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

describe('Anthropic provider', () => {
  afterEach(() => { global.fetch = realFetch; });

  it('turns a chat request into a Messages request: system, images, tools and tool results', () => {
    const body = toAnthropicRequest({
      model: 'claude-x',
      max_tokens: 100,
      temperature: 0.2,
      stop: 'END',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'look', arguments: '{"q":1}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'a cat' },
        { role: 'tool', tool_call_id: 't2', content: 'more' },
      ],
      tools: [{ type: 'function', function: { name: 'look', description: 'Looks', parameters: { type: 'object', properties: { q: { type: 'number' } } } } }],
      tool_choice: 'required',
    }, 'claude-x');
    expect(body).toEqual({
      model: 'claude-x',
      max_tokens: 100,
      temperature: 0.2,
      stop_sequences: ['END'],
      system: 'Be brief.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'look', input: { q: 1 } }] },
        // Consecutive tool results merge into one user turn.
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a cat' }, { type: 'tool_result', tool_use_id: 't2', content: 'more' }] },
      ],
      tools: [{ name: 'look', description: 'Looks', input_schema: { type: 'object', properties: { q: { type: 'number' } } } }],
      tool_choice: { type: 'any' },
    });
  });

  it('always sends max_tokens, which Messages requires', () => {
    expect(toAnthropicRequest({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, 'm').max_tokens).toBe(4096);
    expect(toAnthropicRequest({ model: 'm', max_completion_tokens: 7, messages: [{ role: 'user', content: 'hi' }] }, 'm').max_tokens).toBe(7);
  });

  it('turns a Messages answer into a chat completion with tool calls and usage', () => {
    const res = fromAnthropicResponse({
      id: 'msg_1', model: 'claude-x', stop_reason: 'tool_use',
      content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'look', input: { q: 1 } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(res.choices[0]).toEqual({
      index: 0,
      finish_reason: 'tool_calls',
      message: { role: 'assistant', content: 'Looking.', tool_calls: [{ id: 't1', type: 'function', function: { name: 'look', arguments: '{"q":1}' } }] },
    });
    expect(res.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('streams text and tool calls as chat completion chunks', async () => {
    const events = [
      { type: 'message_start', message: { id: 'msg_2', usage: { input_tokens: 3 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'look' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '1}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
    ];
    const sse = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
    mockFetch(new Response(sse, { status: 200 }));
    const provider = new AnthropicProvider('k', 'claude-x');
    const chunks = [];
    for await (const c of provider.completeStream({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] })) chunks.push(c);
    const text = chunks.map(c => c.choices[0].delta.content || '').join('');
    expect(text).toBe('Hello');
    const args = chunks.flatMap(c => ((c.choices[0].delta as any).tool_calls || []).map((t: any) => t.function?.arguments || '')).join('');
    expect(args).toBe('{"q":1}');
    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe('tool_calls');
    expect(last.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
  });

  it('reports Anthropic errors with their status, and sends the key the Anthropic way', async () => {
    const fetchMock = mockFetch(new Response('{"error":{"message":"bad"}}', { status: 400 }));
    const provider = new AnthropicProvider('secret-key', 'claude-x');
    await expect(provider.complete({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({ status: 400 });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('secret-key');
    expect((init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
  });

  it('is unavailable without a key', async () => {
    expect(await new AnthropicProvider('', 'm').isAvailable()).toBe(false);
  });
});
