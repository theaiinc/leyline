import { sanitizeAzureMessages, sanitizeAzureRequestFields, sanitizeAzureTools, prepareAzureChatParams } from '../src/providers/azure-request';

describe('azure-request sanitization', () => {
  it('passes chat-completions fields and drops Responses-only Cursor params', () => {
    const sanitized = prepareAzureChatParams({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'read_file' } }],
      tool_choice: 'auto',
      stream_options: { include_usage: true },
      include: ['reasoning.encrypted_content'],
      store: true,
      metadata: { client: 'cursor' },
      temperature: 0.2,
    }, false, 'gpt-5.5', true);

    expect(sanitized).toEqual({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'auto',
      stream_options: { include_usage: true },
      temperature: 0.2,
      stream: false,
    });
  });

  it('drops unsupported Cursor fields before forwarding to Azure (legacy whitelist helper)', () => {
    const sanitized = sanitizeAzureRequestFields({
      tools: [{ type: 'function', function: { name: 'read_file' } }],
      tool_choice: 'auto',
      stream_options: { include_usage: true },
      store: true,
      metadata: { client: 'cursor' },
      temperature: 0.2,
    });

    expect(sanitized).toEqual({
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'auto',
      stream_options: { include_usage: true },
      temperature: 0.2,
    });
  });

  it('rewrites Cursor flat function tools into Chat Completions shape for Azure', () => {
    expect(sanitizeAzureTools([
      {
        type: 'function',
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
      { type: 'custom', name: 'apply_patch', description: 'Apply a patch' },
    ])).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
      {
        type: 'custom',
        custom: {
          name: 'apply_patch',
          description: 'Apply a patch',
        },
      },
    ]);
  });

  it('preserves tool_choice when Cursor only sends apply_patch as a custom tool', () => {
    const sanitized = sanitizeAzureRequestFields({
      tools: [{ type: 'custom', name: 'apply_patch' }],
      tool_choice: 'auto',
    });

    expect(sanitized).toEqual({
      tools: [{ type: 'custom', custom: { name: 'apply_patch' } }],
      tool_choice: 'auto',
    });
  });

  it('rewrites incomplete grammar custom formats to text for Azure', () => {
    expect(sanitizeAzureTools([
      { type: 'custom', name: 'apply_patch', format: { type: 'grammar' } },
    ])).toEqual([
      {
        type: 'custom',
        custom: {
          name: 'apply_patch',
          format: { type: 'text' },
        },
      },
    ]);
  });

  it('preserves complete grammar custom formats for Azure', () => {
    const grammar = { syntax: 'lark', definition: 'start: "x"' };
    expect(sanitizeAzureTools([
      { type: 'custom', custom: { name: 'apply_patch', format: { type: 'grammar', grammar } } },
    ])).toEqual([
      {
        type: 'custom',
        custom: {
          name: 'apply_patch',
          format: { type: 'grammar', grammar },
        },
      },
    ]);
  });

  it('drops tool_choice when Cursor tools are all unsupported types', () => {
    const sanitized = sanitizeAzureRequestFields({
      tools: [{ type: 'web_search_preview' }],
      tool_choice: 'auto',
    });

    expect(sanitized).toEqual({});
  });

  it('preserves assistant tool call messages for Azure', () => {
    const messages = sanitizeAzureMessages([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'ok',
      },
    ]);

    expect(messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'ok',
      },
    ]);
  });

  it('does not drop all messages when assistant content is null without tool calls', () => {
    const messages = sanitizeAzureMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: null },
    ]);

    expect(messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '' },
    ]);
  });
});

describe('token limit on Azure', () => {
  it('sends max_completion_tokens (newer models reject max_tokens)', () => {
    const p = prepareAzureChatParams({ model: 'x', messages: [{ role: 'user', content: 'hi' }], max_tokens: 512 } as never, false, 'gpt-5.6-luna', true);
    expect(p.max_completion_tokens).toBe(512);
    expect(p.max_tokens).toBeUndefined();
  });
  it('keeps a max_completion_tokens the client chose', () => {
    const p = prepareAzureChatParams({ model: 'x', messages: [], max_tokens: 512, max_completion_tokens: 100 } as never, false, 'gpt-6-astra', true);
    expect(p.max_completion_tokens).toBe(100);
    expect(p.max_tokens).toBeUndefined();
  });
});

describe('tool schemas some providers reject', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { stripUnsupportedPatterns } = require('../src/providers/tool-schema') as typeof import('../src/providers/tool-schema');
  it('drops regex patterns with lookaround, keeps the rest (and properties named "pattern")', () => {
    const schema = {
      type: 'object',
      properties: {
        email: { type: 'string', pattern: '^(?!.*\\.\\.)[^@]+@[^@]+$' },
        code: { type: 'string', pattern: '^[A-Z]{3}$' },
        pattern: { type: 'string', description: 'a glob' },
        nested: { type: 'array', items: { type: 'string', pattern: '(?<=x)y' } },
      },
    };
    expect(stripUnsupportedPatterns(schema)).toEqual({
      type: 'object',
      properties: {
        email: { type: 'string' },
        code: { type: 'string', pattern: '^[A-Z]{3}$' },
        pattern: { type: 'string', description: 'a glob' },
        nested: { type: 'array', items: { type: 'string' } },
      },
    });
  });
});

describe('Azure: reasoning with tools', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { withToolReasoningFallback } = require('../src/providers/azure-openai') as typeof import('../src/providers/azure-openai');
  it('retries once with reasoning off when the deployment refuses reasoning with tools', async () => {
    const params: Record<string, unknown> = { model: 'gpt-5.6-luna', tools: [{}], reasoning_effort: 'medium' };
    const seen: unknown[] = [];
    const out = await withToolReasoningFallback(params, async () => {
      seen.push(params.reasoning_effort);
      if (params.reasoning_effort !== 'none') {
        throw Object.assign(new Error("400 Function tools with reasoning_effort are not supported for gpt-5.6-luna. Set reasoning_effort to 'none'."), { status: 400 });
      }
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(seen).toEqual(['medium', 'none']);
  });
  it('other errors pass through untouched', async () => {
    const params: Record<string, unknown> = { model: 'm', tools: [{}], reasoning_effort: 'medium' };
    await expect(withToolReasoningFallback(params, async () => { throw Object.assign(new Error('429 slow down'), { status: 429 }); })).rejects.toThrow('429');
    expect(params.reasoning_effort).toBe('medium');
  });
});
