import { parseCloudflaredPublicUrl } from '../src/core/cloudflared-tunnel';

describe('parseCloudflaredPublicUrl', () => {
  it('extracts trycloudflare.com URLs from cloudflared log lines', () => {
    const line = '2026-06-24T04:06:47Z INF |  https://lifetime-vegas-considering-due.trycloudflare.com                                  |';
    expect(parseCloudflaredPublicUrl(line)).toBe('https://lifetime-vegas-considering-due.trycloudflare.com');
  });

  it('returns undefined when no public URL is present', () => {
    expect(parseCloudflaredPublicUrl('Starting metrics server on 127.0.0.1:20241/metrics')).toBeUndefined();
  });
});
