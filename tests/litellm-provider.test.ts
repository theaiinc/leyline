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

  it('forwards Cursor/OpenAI params without Azure-specific stripping', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { id: 'ok', choices: [] } });
    const provider = new LiteLLMProvider('http://127.0.0.1:4000/v1', 'gpt-5.5', 'key');

    await provider.complete({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      include: ['reasoning.encrypted_content'],
      store: true,
      tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'grammar' } }],
    });

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://127.0.0.1:4000/v1/chat/completions',
      {
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hello' }],
        include: ['reasoning.encrypted_content'],
        store: true,
        tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'grammar' } }],
        stream: false,
      },
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer key' }),
      }),
    );
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
  });
});
