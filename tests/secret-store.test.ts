import { execFile } from 'child_process';
import axios from 'axios';
import {
  ArcanaCloudFallbackSecretStore,
  ArcanaCloudSecretStore,
  ArcanaFallbackSecretStore,
  ArcanaSecretStore,
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

  afterEach(() => {
    // Jest reuses worker processes (and their `process.env`) across test
    // files, so a var set mid-test here can otherwise leak into whichever
    // file Jest schedules next in the same worker — beforeEach only resets
    // this before each test IN this file, not after the last one.
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
        { 'api-key:OpenAI': 'arcana://leyline/openai-api-key' },
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
        { 'api-key:OpenAI': 'arcana://leyline/openai-api-key' },
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
        { 'api-key:OpenAI': 'arcana://leyline/openai-api-key' },
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
        { 'api-key:OpenAI': 'arcana://leyline/openai-api-key' },
        arcanaCloudConfig,
      );

      await expect(store.get('api-key:OpenAI')).resolves.toBeUndefined();
    });

    it('rejects a reference that is not arcana://<project>/<secretName>', () => {
      const store = new ArcanaCloudSecretStore({}, arcanaCloudConfig);
      expect(() => store.setArcanaReference('api-key:OpenAI', 'arcana://openai-api-key')).toThrow(
        'arcana://<project>/<secretName>',
      );
    });

    it('falls back to the persistent store when arcana-cloud has no value', async () => {
      mockedAxios.post.mockResolvedValue({ data: { access_token: 'jwt-1', expires_in: 300 } });
      mockedAxios.get.mockResolvedValue({ data: {} });

      const persistent = new MemorySecretStore();
      await persistent.set('api-key:OpenAI', 'local-fallback-key');

      const store = new ArcanaCloudFallbackSecretStore(
        new ArcanaCloudSecretStore({ 'api-key:OpenAI': 'arcana://leyline/openai-api-key' }, arcanaCloudConfig),
        persistent,
      );

      await expect(store.get('api-key:OpenAI')).resolves.toBe('local-fallback-key');
    });
  });

  describe('ArcanaSecretStore', () => {
    const account = 'api-key:OpenAI';
    const reference = 'arcana://llmapi/openai-api-key';
    type ArcanaCallback = (error: Error | null, stdout: string, stderr: string) => void;
    let pending: Array<{ args: string[]; options: { timeout?: number }; callback: ArcanaCallback }>;
    let clock: number;

    const store = (overrides: Partial<ConstructorParameters<typeof ArcanaSecretStore>[1]> = {}) =>
      new ArcanaSecretStore({ [account]: reference }, {
        command: 'arcana',
        runner: 'python3',
        timeoutMs: 300_000,
        waitMs: 1_000,
        failureCooldownMs: 600_000,
        now: () => clock,
        ...overrides,
      });
    const succeed = (index: number, stdout: string) => pending[index].callback(null, stdout, '');
    const fail = (index: number) => pending[index].callback(Object.assign(new Error('killed'), { killed: true }), '', '');
    const flush = () => new Promise(resolve => setImmediate(resolve));

    beforeEach(() => {
      pending = [];
      clock = 1_000_000;
      mockedExecFile.mockImplementation(
        (_command: string, args: string[], options: { timeout?: number }, callback: ArcanaCallback) => {
          pending.push({ args, options, callback });
        },
      );
    });

    it('spawns arcana run once and serves later gets from the cache', async () => {
      const arcana = store();
      const first = arcana.get(account);
      expect(pending).toHaveLength(1);
      expect(pending[0].args.slice(0, 5)).toEqual(['run', '--secret', reference, '--env', 'OPENAI_API_KEY']);
      expect(pending[0].options.timeout).toBe(300_000);
      succeed(0, 'sk-cached\n');

      await expect(first).resolves.toBe('sk-cached');
      await expect(arcana.get(account)).resolves.toBe('sk-cached');
      expect(mockedExecFile).toHaveBeenCalledTimes(1);
    });

    it('coalesces concurrent gets for one account into a single spawn', async () => {
      const arcana = store();
      const results = Promise.all([arcana.get(account), arcana.get(account), arcana.getSource(account)]);
      expect(mockedExecFile).toHaveBeenCalledTimes(1);
      succeed(0, 'sk-shared');

      await expect(results).resolves.toEqual(['sk-shared', 'sk-shared', 'arcana']);
      expect(mockedExecFile).toHaveBeenCalledTimes(1);
    });

    it('getSource does not spawn a second arcana run after get', async () => {
      const arcana = new ArcanaFallbackSecretStore(store(), new MemorySecretStore());
      const value = arcana.get(account);
      succeed(0, 'sk-source');
      await expect(value).resolves.toBe('sk-source');

      await expect(arcana.getSource(account)).resolves.toBe('arcana');
      expect(mockedExecFile).toHaveBeenCalledTimes(1);
    });

    it('backs off after a failure and retries once the cooldown passes', async () => {
      const arcana = store();
      const first = arcana.get(account);
      fail(0);
      await expect(first).resolves.toBeUndefined();

      await expect(arcana.get(account)).resolves.toBeUndefined();
      await expect(arcana.getSource(account)).resolves.toBe('none');
      expect(mockedExecFile).toHaveBeenCalledTimes(1);

      clock += 600_000;
      const retried = arcana.get(account);
      expect(mockedExecFile).toHaveBeenCalledTimes(2);
      succeed(1, 'sk-after-cooldown');
      await expect(retried).resolves.toBe('sk-after-cooldown');
    });

    it('treats empty output as a failure', async () => {
      const arcana = store();
      const first = arcana.get(account);
      succeed(0, '   ');
      await expect(first).resolves.toBeUndefined();
      await expect(arcana.get(account)).resolves.toBeUndefined();
      expect(mockedExecFile).toHaveBeenCalledTimes(1);
    });

    it('retries immediately when the user reconfigures or re-selects the reference', async () => {
      const arcana = new ArcanaFallbackSecretStore(store(), new MemorySecretStore());
      const first = arcana.get(account);
      fail(0);
      await first;
      await arcana.get(account);
      expect(mockedExecFile).toHaveBeenCalledTimes(1);

      arcana.setArcanaReference(account, reference);
      const second = arcana.get(account);
      expect(mockedExecFile).toHaveBeenCalledTimes(2);
      fail(1);
      await second;

      arcana.retryArcana(account);
      const third = arcana.get(account);
      expect(mockedExecFile).toHaveBeenCalledTimes(3);
      succeed(2, 'sk-retried');
      await expect(third).resolves.toBe('sk-retried');
    });

    it('drops the cached value when the reference changes', async () => {
      const arcana = store();
      const first = arcana.get(account);
      succeed(0, 'sk-old');
      await first;

      arcana.setArcanaReference(account, 'arcana://llmapi/rotated-key');
      const second = arcana.get(account);
      expect(mockedExecFile).toHaveBeenCalledTimes(2);
      expect(pending[1].args[2]).toBe('arcana://llmapi/rotated-key');
      succeed(1, 'sk-new');
      await expect(second).resolves.toBe('sk-new');
    });

    it('stops blocking callers after waitMs but keeps the approval alive and announces a late value', async () => {
      const arcana = store({ waitMs: 5 });
      const resolved: Array<[string, string]> = [];
      arcana.onArcanaResolved((resolvedAccount, secret) => resolved.push([resolvedAccount, secret]));

      const waiting = arcana.get(account);
      await expect(waiting).resolves.toBeUndefined();
      expect(arcana.isArcanaPending(account)).toBe(true);

      // A second caller joins the still-running child instead of queueing another approval.
      const joined = arcana.get(account);
      expect(mockedExecFile).toHaveBeenCalledTimes(1);

      succeed(0, 'sk-late');
      await expect(joined).resolves.toBe('sk-late');
      expect(resolved).toEqual([[account, 'sk-late']]);
      expect(arcana.isArcanaPending(account)).toBe(false);
      await expect(arcana.get(account)).resolves.toBe('sk-late');
      expect(mockedExecFile).toHaveBeenCalledTimes(1);
    });

    it('does not announce values that callers received directly', async () => {
      const arcana = store();
      const listener = jest.fn();
      arcana.onArcanaResolved(listener);
      const value = arcana.get(account);
      succeed(0, 'sk-direct');
      await value;
      await flush();
      expect(listener).not.toHaveBeenCalled();
    });

    it('does not spawn for accounts without a reference', async () => {
      await expect(store().get('api-key:Gemini')).resolves.toBeUndefined();
      expect(mockedExecFile).not.toHaveBeenCalled();
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
      process.env.LEYLINE_ARCANA_CLOUD_OPENAI_REF = 'arcana://leyline/openai-api-key';

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
