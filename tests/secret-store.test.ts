import { execFile } from 'child_process';
import axios from 'axios';
import {
  ArcanaCloudFallbackSecretStore,
  ArcanaCloudSecretStore,
  FallbackSecretStore,
  KeychainSecretStore,
  MemorySecretStore,
  apiKeyAccount,
  createDefaultSecretStore,
  parseRuntimeConfig,
  runtimeConfigAccount,
  serializeRuntimeConfig,
} from '../src/core/secret-store';

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));
jest.mock('axios');

const mockedExecFile = execFile as unknown as jest.Mock;
const mockedAxios = axios as jest.Mocked<typeof axios>;
const originalPlatform = process.platform;

const arcanaCloudConfig = {
  baseUrl: 'https://arcana-cloud.theaiinc.com',
  aegisUrl: 'https://id.theaiinc.com',
  workspaceId: 'ws-1',
  clientId: 'client-1',
  clientSecret: 'secret-1',
  timeoutMs: 5000,
};

type MockSecurityError = Error & {
  code?: string | number;
};

function securityError(message: string, code?: string | number): MockSecurityError {
  const error = new Error(message) as MockSecurityError;
  error.code = code;
  return error;
}

function mockSecurity(handler: (args: string[]) => { stdout?: string; stderr?: string; error?: MockSecurityError }) {
  mockedExecFile.mockImplementation((_command: string, args: string[], callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    const result = handler(args);
    callback(result.error || null, result.stdout || '', result.stderr || '');
  });
}

describe('secret store', () => {
  beforeEach(() => {
    mockedExecFile.mockReset();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    delete process.env.LEYLINE_KEYCHAIN_ENABLED;
    delete process.env.LEYLINE_KEYCHAIN_SERVICE;
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('builds stable provider API key accounts', () => {
    expect(apiKeyAccount('AzureOpenAI')).toBe('api-key:AzureOpenAI');
    expect(runtimeConfigAccount('AzureOpenAI')).toBe('runtime-config:AzureOpenAI');
  });

  it('serializes and parses runtime config payloads', () => {
    const payload = serializeRuntimeConfig({
      baseUrl: 'https://example.services.ai.azure.com/openai/v1',
      model: 'gpt-5.5',
    });

    expect(parseRuntimeConfig(payload)).toEqual({
      baseUrl: 'https://example.services.ai.azure.com/openai/v1',
      model: 'gpt-5.5',
    });
    expect(parseRuntimeConfig('not-json')).toBeUndefined();
  });

  it('reads keys from Apple Keychain through the security CLI', async () => {
    mockSecurity(() => ({ stdout: 'stored-key\n' }));

    const store = new KeychainSecretStore('@theaiinc/leyline', true);
    await expect(store.get('api-key:OpenAI')).resolves.toBe('stored-key');
    expect(mockedExecFile).toHaveBeenCalledWith(
      'security',
      [
        'find-generic-password',
        '-s',
        '@theaiinc/leyline',
        '-a',
        'api-key:OpenAI',
        '-w',
      ],
      expect.any(Function),
    );
  });

  it('treats a missing Keychain item as an unconfigured key, not Keychain failure', async () => {
    mockSecurity(() => ({
      error: securityError('The specified item could not be found in the keychain.', 44),
      stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.',
    }));

    const store = new KeychainSecretStore('@theaiinc/leyline', true);

    await expect(store.get('api-key:OpenAI')).resolves.toBeUndefined();
    expect(store.status()).toMatchObject({
      mode: 'keychain',
      available: true,
      warning: undefined,
    });
  });

  it('reports security CLI lookup failures clearly without exposing secrets', async () => {
    mockSecurity(() => ({
      error: securityError('spawn security ENOENT', 'ENOENT'),
    }));

    const store = new FallbackSecretStore(new KeychainSecretStore('@theaiinc/leyline', true));

    await expect(store.get('api-key:OpenAI')).resolves.toBeUndefined();
    expect(store.status()).toMatchObject({
      mode: 'memory',
      available: true,
      warning: expect.stringContaining('macOS security CLI was not found'),
    });
    expect(store.status().warning).not.toContain('sk-');
  });

  it('reports Keychain permission errors clearly without exposing saved keys', async () => {
    mockSecurity(args => {
      if (args[0] === 'add-generic-password') {
        return {
          error: securityError('Command failed: security add-generic-password', 51),
          stderr: 'security: SecKeychainItemCreateFromContent: User interaction is not allowed.',
        };
      }
      return { stdout: '' };
    });

    const store = new FallbackSecretStore(new KeychainSecretStore('@theaiinc/leyline', true));
    await store.set('api-key:OpenAI', 'sk-secret');

    expect(store.status()).toMatchObject({
      mode: 'memory',
      available: true,
      warning: expect.stringContaining('Keychain access was denied or requires permission'),
    });
    expect(store.status().warning).not.toContain('sk-secret');
    await expect(store.get('api-key:OpenAI')).resolves.toBe('sk-secret');
  });

  it('saves keys by replacing the Keychain item without returning the secret', async () => {
    mockSecurity(() => ({ stdout: '' }));

    const store = new KeychainSecretStore('@theaiinc/leyline', true);
    await store.set('api-key:OpenAI', 'sk-secret');

    expect(mockedExecFile).toHaveBeenCalledWith(
      'security',
      expect.arrayContaining(['delete-generic-password', '-a', 'api-key:OpenAI']),
      expect.any(Function),
    );
    expect(mockedExecFile).toHaveBeenCalledWith(
      'security',
      expect.arrayContaining(['add-generic-password', '-a', 'api-key:OpenAI', '-w', 'sk-secret']),
      expect.any(Function),
    );
  });

  it('falls back to memory when Keychain save fails', async () => {
    mockSecurity(args => {
      if (args[0] === 'add-generic-password') {
        return { error: new Error('denied') };
      }
      return { stdout: '' };
    });

    const store = new FallbackSecretStore(new KeychainSecretStore('@theaiinc/leyline', true));
    await store.set('api-key:OpenAI', 'memory-secret');

    expect(store.status().mode).toBe('memory');
    await expect(store.get('api-key:OpenAI')).resolves.toBe('memory-secret');
  });

  it('can be explicitly configured as memory-only', () => {
    process.env.LEYLINE_KEYCHAIN_ENABLED = 'false';
    const store = createDefaultSecretStore();

    expect(store).toBeInstanceOf(MemorySecretStore);
    expect(store.status()).toMatchObject({
      mode: 'memory',
      available: true,
    });
  });

  describe('ArcanaCloudSecretStore', () => {
    beforeEach(() => {
      mockedAxios.get.mockReset();
      mockedAxios.post.mockReset();
    });

    it('mints an Aegis token then pulls the secret from arcana-cloud', async () => {
      mockedAxios.post.mockResolvedValue({ data: { access_token: 'jwt-1', expires_in: 300 } });
      mockedAxios.get.mockResolvedValue({ data: { value: 'sk-from-cloud', version: 1 } });

      const store = new ArcanaCloudSecretStore(
        { 'api-key:OpenAI': 'arcana-cloud://leyline/openai-api-key' },
        arcanaCloudConfig,
      );

      await expect(store.get('api-key:OpenAI')).resolves.toBe('sk-from-cloud');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://id.theaiinc.com/token',
        expect.stringContaining('grant_type=client_credentials'),
        expect.objectContaining({ headers: expect.objectContaining({ 'Content-Type': 'application/x-www-form-urlencoded' }) }),
      );
      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://arcana-cloud.theaiinc.com/v1/workspaces/ws-1/projects/leyline/secrets/openai-api-key',
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer jwt-1' }) }),
      );
    });

    it('reuses a cached Aegis token instead of minting one per pull', async () => {
      mockedAxios.post.mockResolvedValue({ data: { access_token: 'jwt-1', expires_in: 300 } });
      mockedAxios.get.mockResolvedValue({ data: { value: 'sk-from-cloud' } });

      const store = new ArcanaCloudSecretStore(
        { 'api-key:OpenAI': 'arcana-cloud://leyline/openai-api-key' },
        arcanaCloudConfig,
      );

      await store.get('api-key:OpenAI');
      await store.get('api-key:OpenAI');

      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });

    it('sends Cloudflare Access service token headers when configured', async () => {
      mockedAxios.post.mockResolvedValue({ data: { access_token: 'jwt-1', expires_in: 300 } });
      mockedAxios.get.mockResolvedValue({ data: { value: 'sk-from-cloud' } });

      const store = new ArcanaCloudSecretStore(
        { 'api-key:OpenAI': 'arcana-cloud://leyline/openai-api-key' },
        { ...arcanaCloudConfig, accessClientId: 'cf-id', accessClientSecret: 'cf-secret' },
      );

      await store.get('api-key:OpenAI');

      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'CF-Access-Client-Id': 'cf-id',
            'CF-Access-Client-Secret': 'cf-secret',
          }),
        }),
      );
    });

    it('resolves undefined without throwing when arcana-cloud is unreachable', async () => {
      mockedAxios.post.mockRejectedValue(new Error('network error'));

      const store = new ArcanaCloudSecretStore(
        { 'api-key:OpenAI': 'arcana-cloud://leyline/openai-api-key' },
        arcanaCloudConfig,
      );

      await expect(store.get('api-key:OpenAI')).resolves.toBeUndefined();
    });

    it('rejects a reference that is not arcana-cloud://<project>/<secret>', () => {
      const store = new ArcanaCloudSecretStore({}, arcanaCloudConfig);
      expect(() => store.setArcanaReference('api-key:OpenAI', 'arcana://openai/api-key')).toThrow(
        'arcana-cloud://<project>/<secretName>',
      );
    });

    it('falls back to the persistent store when arcana-cloud has no value', async () => {
      mockedAxios.post.mockResolvedValue({ data: { access_token: 'jwt-1', expires_in: 300 } });
      mockedAxios.get.mockResolvedValue({ data: {} });

      const persistent = new MemorySecretStore();
      await persistent.set('api-key:OpenAI', 'local-fallback-key');

      const store = new ArcanaCloudFallbackSecretStore(
        new ArcanaCloudSecretStore({ 'api-key:OpenAI': 'arcana-cloud://leyline/openai-api-key' }, arcanaCloudConfig),
        persistent,
      );

      await expect(store.get('api-key:OpenAI')).resolves.toBe('local-fallback-key');
    });
  });

  describe('createDefaultSecretStore with Arcana Cloud env', () => {
    const cloudEnvKeys = [
      'LEYLINE_ARCANA_CLOUD_WORKSPACE_ID',
      'LEYLINE_ARCANA_CLOUD_CLIENT_ID',
      'LEYLINE_ARCANA_CLOUD_CLIENT_SECRET',
      'LEYLINE_ARCANA_CLOUD_OPENAI_REF',
    ];

    afterEach(() => {
      for (const key of cloudEnvKeys) delete process.env[key];
    });

    it('picks Arcana Cloud over the local Arcana CLI bridge when fully configured', () => {
      process.env.LEYLINE_ARCANA_CLOUD_WORKSPACE_ID = 'ws-1';
      process.env.LEYLINE_ARCANA_CLOUD_CLIENT_ID = 'client-1';
      process.env.LEYLINE_ARCANA_CLOUD_CLIENT_SECRET = 'secret-1';
      process.env.LEYLINE_ARCANA_CLOUD_OPENAI_REF = 'arcana-cloud://leyline/openai-api-key';

      const store = createDefaultSecretStore();

      expect(store).toBeInstanceOf(ArcanaCloudFallbackSecretStore);
    });

    it('ignores Arcana Cloud config with no references configured', () => {
      process.env.LEYLINE_ARCANA_CLOUD_WORKSPACE_ID = 'ws-1';
      process.env.LEYLINE_ARCANA_CLOUD_CLIENT_ID = 'client-1';
      process.env.LEYLINE_ARCANA_CLOUD_CLIENT_SECRET = 'secret-1';

      const store = createDefaultSecretStore();

      expect(store).not.toBeInstanceOf(ArcanaCloudFallbackSecretStore);
    });
  });
});
