import { sanitizeAzureMessages, sanitizeAzureRequestFields, sanitizeAzureTools } from '../src/providers/azure-request';

describe('azure-request sanitization', () => {
  it('drops unsupported Cursor fields before forwarding to Azure', () => {
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
    ]);
  });

  it('drops tool_choice when Cursor tools are all unsupported custom types', () => {
    const sanitized = sanitizeAzureRequestFields({
      tools: [{ type: 'custom', name: 'apply_patch' }],
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
