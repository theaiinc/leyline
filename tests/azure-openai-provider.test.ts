import OpenAI from 'openai';
import { AzureOpenAIProvider } from '../src/providers/azure-openai';

const mockCreate = jest.fn();

jest.mock('openai', () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: mockCreate,
      },
    };
  }

  return {
    __esModule: true,
    default: MockOpenAI,
  };
});

jest.mock('openai/azure', () => ({
  AzureOpenAI: jest.requireMock('openai').default,
}));

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

  it('passes chat-completions fields and strips Responses-only params via the SDK', async () => {
    mockCreate.mockResolvedValueOnce({ id: 'ok' });
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
      include: ['reasoning.encrypted_content'],
      store: true,
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.5',
        tools: [{ type: 'function', function: { name: 'test', parameters: { type: 'object', properties: {} } } }],
        max_completion_tokens: 1024,
        stream_options: { include_usage: true },
        stream: false,
      }),
    );
    expect(mockCreate.mock.calls[0][0].store).toBeUndefined();
    expect(mockCreate.mock.calls[0][0].include).toBeUndefined();
  });

  it('should call OpenAI-compatible Azure v1 chat completions with model in payload', async () => {
    mockCreate.mockResolvedValueOnce({
      id: 'azure-v1-response',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-5.5',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
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
    expect(mockCreate).toHaveBeenCalledWith({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'solve 8x + 31 = 2' }],
      stream: false,
    });
    expect(new OpenAI({ baseURL: 'https://otlrs-dev-agents-resource.services.ai.azure.com/openai/v1', apiKey: 'key' }))
      .toBeDefined();
  });

  it('should call Azure deployment chat completions for non-streaming requests', async () => {
    mockCreate.mockResolvedValueOnce({
      id: 'azure-response',
      object: 'chat.completion',
      created: 1,
      model: 'chat-deployment',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
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
    expect(mockCreate).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
  });

  it('should stream chat completion chunks via the official SDK', async () => {
    async function* streamChunks() {
      yield {
        id: '1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'chat-deployment',
        choices: [{ index: 0, delta: { content: 'hel' }, finish_reason: null }],
      };
      yield {
        id: '2',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'chat-deployment',
        choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }],
      };
    }

    mockCreate.mockResolvedValueOnce(streamChunks());
    const provider = new AzureOpenAIProvider('key', 'https://example.openai.azure.com', 'chat-deployment');

    const chunks: Array<string | undefined> = [];
    for await (const chunk of provider.completeStream({
      model: 'chat-deployment',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      chunks.push(chunk.choices[0].delta.content);
    }

    expect(chunks.join('')).toBe('hello');
    expect(mockCreate).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
  });
});
