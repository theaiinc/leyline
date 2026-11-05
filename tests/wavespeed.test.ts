import { WaveSpeedProvider } from '../src/providers/wavespeed';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('WaveSpeed media provider', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('generates an image with the requested model and prompt', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ data: [{ url: 'https://cdn.example/image.png' }], model: 'wavespeed-ai/flux-dev' }),
    );
    const provider = new WaveSpeedProvider('wavespeed-key', 'https://wavespeed.test/api/v3');

    await expect(provider.generateImage({
      model: 'wavespeed-ai/flux-dev',
      prompt: 'a test image',
      n: 1,
    })).resolves.toEqual({
      data: [{ url: 'https://cdn.example/image.png' }],
      model: 'wavespeed-ai/flux-dev',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://wavespeed.test/api/v3/image/generations',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'wavespeed-ai/flux-dev', prompt: 'a test image', n: 1 }),
      }),
    );
  });

  it('polls an asynchronous video until it succeeds', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ id: 'video-1', status: 'processing' }))
      .mockResolvedValueOnce(json({ id: 'video-1', status: 'succeeded', url: 'https://cdn.example/video.mp4', model: 'wavespeed-ai/seedance-1.5-pro' }));
    const provider = new WaveSpeedProvider('wavespeed-key', 'https://wavespeed.test/api/v3');

    await expect(provider.generateVideo({ model: 'wavespeed-ai/seedance-1.5-pro', prompt: 'a test video' }))
      .resolves.toMatchObject({ id: 'video-1', status: 'succeeded', url: 'https://cdn.example/video.mp4' });
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://wavespeed.test/api/v3/video/generations/video-1', expect.objectContaining({ headers: expect.any(Object) }));
  });
});