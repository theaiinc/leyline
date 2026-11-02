import axios from 'axios';
import { BytePlusProvider } from '../src/providers/byteplus';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('BytePlusProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('serves the configured ModelArk model through the OpenAI-compatible chat endpoint', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        id: 'modelark-response',
        object: 'chat.completion',
        created: 1,
        model: 'deepseek-v4-1-flash-261017',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      },
    });

    const provider = new BytePlusProvider(
      'ark-key',
      'deepseek-v4-1-flash-261017',
      'https://ark.example.com/api/v3',
    );
    const response = await provider.complete({
      model: 'deepseek-v4-1-flash-261017',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.model).toBe('deepseek-v4-1-flash-261017');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://ark.example.com/api/v3/chat/completions',
      {
        model: 'deepseek-v4-1-flash-261017',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      },
      {
        headers: {
          Authorization: 'Bearer ark-key',
          'Content-Type': 'application/json',
        },
        timeout: 300000,
      },
    );
  });

  it('only serves configured ModelArk model IDs', () => {
    const provider = new BytePlusProvider('ark-key');

    expect(provider.servesModel('chat', 'deepseek-v4-1-flash-261017')).toBe(true);
    expect(provider.servesModel('chat', 'deepseek-v4-1-flash-260910')).toBe(false);
    expect(provider.servesModel('chat', 'gpt-5.6-luna-2026-07-09')).toBe(false);
    expect(provider.servesModel('chat', 'claude-sonnet-5-5')).toBe(false);
  });

  it('reports only the configured ModelArk model when listing fails', async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error('unavailable'));

    const provider = new BytePlusProvider('ark-key', 'deepseek-v4-1-flash-261017');
    await expect(provider.getModels()).resolves.toEqual([
      { id: 'deepseek-v4-1-flash-261017', name: 'deepseek-v4-1-flash-261017' },
    ]);
  });
});