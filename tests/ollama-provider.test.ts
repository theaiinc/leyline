import axios from 'axios';
import { OllamaProvider } from '../src/providers/ollama';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('OllamaProvider', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('does not handle registry cloud models even when a similarly named tag exists locally', async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        models: [{ name: 'gpt-5.5:latest' }],
      },
    });

    const provider = new OllamaProvider('http://localhost:11434', 'llama3.2:latest');
    await expect(provider.canHandle({ model: 'gpt-5.5', messages: [] })).resolves.toBe(false);
  });

  it('does not handle cloud model names that are not installed locally', async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        models: [{ name: 'llama3.2:latest' }],
      },
    });

    const provider = new OllamaProvider('http://localhost:11434', 'llama3.2:latest');
    await expect(provider.canHandle({ model: 'gpt-5.5', messages: [] })).resolves.toBe(false);
  });

  it('handles auto when the default model is installed', async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        models: [{ name: 'llama3.2:latest' }],
      },
    });

    const provider = new OllamaProvider('http://localhost:11434', 'llama3.2:latest');
    await expect(provider.canHandle({ model: 'auto', messages: [] })).resolves.toBe(true);
  });
});
