import axios from 'axios';
import { LiteLLMProvider } from '../src/providers/litellm';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

async function* streamChunks(chunks: string[]) {
  for (const chunk of chunks) {
    yield Buffer.from(chunk);
  }
}

describe('LiteLLMProvider', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('reports available when LiteLLM /models responds', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [] } });
    const provider = new LiteLLMProvider('http://127.0.0.1:4000/v1', 'gpt-5.5', 'key');

    await expect(provider.isAvailable()).resolves.toBe(true);
  });

  it('forwards Cursor/OpenAI params while normalizing tools for LiteLLM', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { id: 'ok', choices: [] } });
    const provider = new LiteLLMProvider('http://127.0.0.1:4000/v1', 'gpt-5.5', 'key');

    await provider.complete({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      include: ['reasoning.encrypted_content'],
      store: true,
      tools: [
        { type: 'function', name: 'read_file' },
        { type: 'custom', name: 'apply_patch', format: { type: 'grammar' } },
      ],
    });

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://127.0.0.1:4000/v1/chat/completions',
      {
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hello' }],
        include: ['reasoning.encrypted_content'],
        store: true,
        tools: [
          { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } },
          { type: 'custom', name: 'apply_patch', format: { type: 'text' } },
        ],
        stream: false,
      },
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer key' }),
      }),
    );
  });

  it('drops invalid function tools that crash LiteLLM Responses translation', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { id: 'ok', choices: [] } });
    const provider = new LiteLLMProvider('http://127.0.0.1:4000/v1', 'gpt-5.5', 'key');

    await provider.complete({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function' }],
      tool_choice: 'auto',
    });

    const payload = mockedAxios.post.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    });
    expect(payload.tools).toBeUndefined();
    expect(payload.tool_choice).toBeUndefined();
  });

  it('uses configured default model for auto requests', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { id: 'ok', choices: [] } });
    const provider = new LiteLLMProvider('http://127.0.0.1:4000/v1', 'gpt-5.5', 'key');

    await provider.complete({
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(mockedAxios.post.mock.calls[0][1]).toMatchObject({
      model: 'gpt-5.5',
      stream: false,
    });
  });

  it('fails fast when full Cursor payload exceeds configured input budget', async () => {
    const provider = new LiteLLMProvider('http://127.0.0.1:4000/v1', 'gpt-5.5', 'key', 10, true);

    await expect(provider.complete({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'x'.repeat(500) }],
      tools: [{ type: 'function', name: 'large_tool', parameters: { type: 'object', properties: { content: { type: 'string' } } } }],
    })).rejects.toMatchObject({
      response: {
        status: 400,
        data: {
          error: {
            code: 'context_length_exceeded',
          },
        },
      },
    });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('parses streaming SSE chunks from LiteLLM', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: streamChunks([
        'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"gpt-5.5","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    });
    const provider = new LiteLLMProvider('http://127.0.0.1:4000/v1', 'gpt-5.5', 'key');

    const chunks: string[] = [];
    for await (const chunk of provider.completeStream({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
    })) {
      chunks.push(chunk.choices[0]?.delta?.content || '');
    }

    expect(chunks.join('')).toBe('hi');
    expect(mockedAxios.post.mock.calls[0][1]).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('preserves SSE events split across transport chunks', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: streamChunks([
        'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"gpt-5.5","choices":[{"index":0,"delta":{"content":"he',
        'llo"},"finish_reason":null}]}\n\n',
        'data: {"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{}"}}]},"finish_reason":null}]}\n',
        '\n',
        'data: [DONE]\n\n',
      ]),
    });
    const provider = new LiteLLMProvider('http://127.0.0.1:4000/v1', 'gpt-5.5', 'key');

    const chunks = [];
    for await (const chunk of provider.completeStream({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0].choices[0]?.delta?.content).toBe('hello');
    expect((chunks[1].choices[0]?.delta as any)?.tool_calls?.[0]?.function?.name).toBe('read_file');
  });

  it('preserves caller stream options while requesting stream usage', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: streamChunks(['data: [DONE]\n\n']) });
    const provider = new LiteLLMProvider('http://127.0.0.1:4000/v1', 'gpt-5.5', 'key');

    for await (const _chunk of provider.completeStream({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      stream_options: { include_usage: false, custom: true },
    })) {
      // drain stream
    }

    expect(mockedAxios.post.mock.calls[0][1]).toMatchObject({
      stream_options: { include_usage: true, custom: true },
    });
  });
});
