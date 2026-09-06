import { deterministicInstanceId, generateInstanceId, slugify } from '../src/core/instance-naming';

describe('instance-naming', () => {
  describe('slugify', () => {
    it('strips protocol and path, lowercases, and dash-joins', () => {
      expect(slugify('https://Contoso.openai.azure.com/openai/v1')).toBe('contoso-openai-azure-com');
    });

    it('falls back to "instance" for empty input', () => {
      expect(slugify('')).toBe('instance');
      expect(slugify('***')).toBe('instance');
    });
  });

  describe('deterministicInstanceId', () => {
    it('derives an id from the endpoint', () => {
      const id = deterministicInstanceId({ endpoint: 'https://contoso.openai.azure.com', deployment: 'gpt-4o' }, new Set());
      expect(id).toContain('contoso');
    });

    it('falls back to the deployment when the endpoint has no usable slug', () => {
      const id = deterministicInstanceId({ endpoint: '', deployment: 'gpt-4o' }, new Set());
      expect(id).toBe('gpt-4o');
    });

    it('dedupes against existing ids by appending a numeric suffix', () => {
      const existing = new Set(['contoso']);
      const id = deterministicInstanceId({ endpoint: 'https://contoso', deployment: 'gpt-4o' }, existing);
      expect(id).toBe('contoso-2');
    });
  });

  describe('generateInstanceId', () => {
    const input = { endpoint: 'https://contoso.openai.azure.com', deployment: 'gpt-4o' };

    it('falls back to the deterministic id when no LLM adapter is given', async () => {
      const id = await generateInstanceId(input, new Set());
      expect(id).toBe(deterministicInstanceId(input, new Set()));
    });

    it('uses a valid LLM-generated slug', async () => {
      const llm = { complete: jest.fn().mockResolvedValue('contoso-eastus2') };
      const id = await generateInstanceId(input, new Set(), llm);
      expect(id).toBe('contoso-eastus2');
    });

    it('falls back when the LLM output is not a usable slug', async () => {
      const llm = { complete: jest.fn().mockResolvedValue('') };
      const id = await generateInstanceId(input, new Set(), llm);
      expect(id).toBe(deterministicInstanceId(input, new Set()));
    });

    it('falls back when the LLM call rejects', async () => {
      const llm = { complete: jest.fn().mockRejectedValue(new Error('boom')) };
      const id = await generateInstanceId(input, new Set(), llm);
      expect(id).toBe(deterministicInstanceId(input, new Set()));
    });

    it('falls back when the LLM call exceeds the timeout', async () => {
      const llm = { complete: () => new Promise<string>(() => {}) };
      const id = await generateInstanceId(input, new Set(), llm, 20);
      expect(id).toBe(deterministicInstanceId(input, new Set()));
    });

    it('dedupes a valid LLM-generated slug against existing ids', async () => {
      const llm = { complete: jest.fn().mockResolvedValue('contoso-eastus2') };
      const id = await generateInstanceId(input, new Set(['contoso-eastus2']), llm);
      expect(id).toBe('contoso-eastus2-2');
    });
  });
});
