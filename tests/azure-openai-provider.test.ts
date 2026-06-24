import axios from 'axios';
import { AzureOpenAIProvider } from '../src/providers/azure-openai';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

async function* streamChunks(chunks: string[]) {
  for (const chunk of chunks) {
    yield Buffer.from(chunk);
  }
}

describe('AzureOpenAIProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should report unavailable without required configuration', async () => {
    const provider = new AzureOpenAIProvider('', '', '');

    await expect(provider.isAvailable()).resolves.toBe(false);
  });

  it('should report available with api key, endpoint, and deployment', async () => {
    const provider = new AzureOpenAIProvider('key', 'https://example.openai.azure.com', 'chat-deployment');

    await expect(provider.isAvailable()).resolves.toBe(true);
  });

  it('forwards passthrough OpenAI fields to Azure', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { id: 'ok' } });
    const provider = new AzureOpenAIProvider(
      'key',
      'https://example.services.ai.azure.com/openai/v1',
      'gpt-5.5',
    );

    await provider.complete({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'test' } }],
      max_completion_tokens: 1024,
      stream_options: { include_usage: true },
      store: true,
    });

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://example.services.ai.azure.com/openai/v1/chat/completions',
      expect.objectContaining({
        model: 'gpt-5.5',
        tools: [{ type: 'function', function: { name: 'test', parameters: { type: 'object', properties: {} } } }],
        max_completion_tokens: 1024,
        stream: false,
      }),
      expect.any(Object),
    );

    const payload = mockedAxios.post.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.stream_options).toBeUndefined();
    expect(payload.store).toBeUndefined();
  });

  it('should call OpenAI-compatible Azure v1 chat completions with model in payload', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        id: 'azure-v1-response',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-5.5',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      },
    });
    const provider = new AzureOpenAIProvider(
      'key',
      'https://otlrs-dev-agents-resource.services.ai.azure.com/openai/v1',
      'gpt-5.5',
    );

    const response = await provider.complete({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'solve 8x + 31 = 2' }],
    });

    expect(response.id).toBe('azure-v1-response');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://otlrs-dev-agents-resource.services.ai.azure.com/openai/v1/chat/completions',
      {
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'solve 8x + 31 = 2' }],
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

  it('should call Azure deployment chat completions for non-streaming requests', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        id: 'azure-response',
        object: 'chat.completion',
        created: 1,
        model: 'chat-deployment',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      },
    });
    const provider = new AzureOpenAIProvider(
      'key',
      'https://example.openai.azure.com/',
      'chat-deployment',
      '2024-10-21',
    );

    const response = await provider.complete({
      model: 'override-deployment',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.id).toBe('azure-response');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://example.openai.azure.com/openai/deployments/override-deployment/chat/completions?api-version=2024-10-21',
      {
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      },
      {
        headers: {
          'api-key': 'key',
          'Content-Type': 'application/json',
        },
        timeout: 300000,
      },
    );
  });

  it('should parse Azure streaming SSE chunks', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: streamChunks([
        'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"chat-deployment","choices":[{"index":0,"delta":{"content":"hel"},"finish_reason":null}]}\n\n',
        'data: {"id":"2","object":"chat.completion.chunk","created":1,"model":"chat-deployment","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    });
    const provider = new AzureOpenAIProvider('key', 'https://example.openai.azure.com', 'chat-deployment');

    const chunks: Array<string | undefined> = [];
    for await (const chunk of provider.completeStream({
      model: 'chat-deployment',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(chunk.choices[0].delta.content);
    }

    expect(chunks.join('')).toBe('hello');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://example.openai.azure.com/openai/deployments/chat-deployment/chat/completions?api-version=2024-10-21',
      {
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
      {
        headers: {
          'api-key': 'key',
          'Content-Type': 'application/json',
        },
        responseType: 'stream',
        timeout: 300000,
        validateStatus: expect.any(Function),
      },
    );
  });
});
