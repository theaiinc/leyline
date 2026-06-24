import axios from 'axios';
import { OpenAIProvider } from '../src/providers/openai';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

async function* streamChunks(chunks: string[]) {
  for (const chunk of chunks) {
    yield Buffer.from(chunk);
  }
}

describe('OpenAIProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should default to gpt-5.5', () => {
    const provider = new OpenAIProvider('key');

    expect(provider.defaultModel).toBe('gpt-5.5');
  });

  it('should report unavailable without an API key', async () => {
    const provider = new OpenAIProvider('');

    await expect(provider.isAvailable()).resolves.toBe(false);
  });

  it('should call OpenAI chat completions for non-streaming requests', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        id: 'openai-response',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-5.5',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      },
    });
    const provider = new OpenAIProvider('key');

    const response = await provider.complete({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.id).toBe('openai-response');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      },
      {
        headers: {
          'Authorization': 'Bearer key',
          'Content-Type': 'application/json',
        },
        timeout: 300000,
      },
    );
  });

  it('should parse OpenAI streaming SSE chunks', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: streamChunks([
        'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"gpt-5.5","choices":[{"index":0,"delta":{"content":"hel"},"finish_reason":null}]}\n\n',
        'data: {"id":"2","object":"chat.completion.chunk","created":1,"model":"gpt-5.5","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    });
    const provider = new OpenAIProvider('key');

    const chunks = [];
    for await (const chunk of provider.completeStream({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(chunk.choices[0].delta.content);
    }

    expect(chunks.join('')).toBe('hello');
  });
});
