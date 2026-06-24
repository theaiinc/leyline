import { DEFAULT_LEYLINE_CLIENT_API_KEY, resolveClientApiKey } from '../src/config';

describe('client auth config', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('uses an explicit client API key when configured', () => {
    process.env.LEYLINE_CLIENT_API_KEY = 'explicit-key';
    process.env.LEYLINE_TUNNEL_ENABLED = 'true';

    expect(resolveClientApiKey()).toBe('explicit-key');
  });

  it('generates a random session key when tunnel is enabled and no explicit key is set', () => {
    delete process.env.LEYLINE_CLIENT_API_KEY;
    process.env.LEYLINE_TUNNEL_ENABLED = 'true';

    const first = resolveClientApiKey();
    const second = resolveClientApiKey();

    expect(first).toMatch(/^ll-[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^ll-[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
  });

  it('keeps the local default when tunnel is disabled and no explicit key is set', () => {
    delete process.env.LEYLINE_CLIENT_API_KEY;
    process.env.LEYLINE_TUNNEL_ENABLED = 'false';

    expect(resolveClientApiKey()).toBe(DEFAULT_LEYLINE_CLIENT_API_KEY);
  });

  it('can disable client auth explicitly', () => {
    process.env.LEYLINE_CLIENT_AUTH_ENABLED = 'false';
    process.env.LEYLINE_CLIENT_API_KEY = 'ignored';

    expect(resolveClientApiKey()).toBe('');
  });
});
