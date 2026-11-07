import { WaveSpeedProvider } from '../src/providers/wavespeed';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('WaveSpeed image provider', () => {
  it('submits to the model path (size w*h, num_images, sync mode) and returns the outputs', async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(json({ code: 200, data: { id: 'p1', status: 'completed', outputs: ['https://cdn.example/a.jpeg'] } }));
    const p = new WaveSpeedProvider('k', 'https://wavespeed.test/api/v3', { fetchImpl, sleep: async () => {} });
    await expect(p.generateImage({ model: 'wavespeed-ai/flux-dev', prompt: 'a leaf', size: '1024x768' })).resolves.toEqual({ model: 'wavespeed-ai/flux-dev', data: [{ url: 'https://cdn.example/a.jpeg' }], taskId: 'p1' });
    expect(fetchImpl).toHaveBeenCalledWith('https://wavespeed.test/api/v3/wavespeed-ai/flux-dev', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ prompt: 'a leaf', size: '1024*768', num_images: 1, enable_sync_mode: true, enable_base64_output: false });
  });

  it('polls predictions/{id}/result when the submit comes back unfinished; a failed task throws', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(json({ data: { id: 'p2', status: 'processing', outputs: [] } }))
      .mockResolvedValueOnce(json({ data: { id: 'p2', status: 'completed', outputs: ['https://cdn.example/b.jpeg'] } }));
    const p = new WaveSpeedProvider('k', 'https://wavespeed.test/api/v3', { fetchImpl, sleep: async () => {} });
    await expect(p.generateImage({ model: 'wavespeed-ai/flux-dev', prompt: 'x' })).resolves.toMatchObject({ data: [{ url: 'https://cdn.example/b.jpeg' }] });
    expect(fetchImpl.mock.calls[1][0]).toBe('https://wavespeed.test/api/v3/predictions/p2/result');
    const failing = new WaveSpeedProvider('k', 'https://wavespeed.test/api/v3', { fetchImpl: jest.fn().mockResolvedValueOnce(json({ data: { id: 'p3', status: 'failed', error: 'nsfw', outputs: [] } })), sleep: async () => {} });
    await expect(failing.generateImage({ model: 'wavespeed-ai/flux-dev', prompt: 'x' })).rejects.toThrow(/failed: nsfw/);
  });

  it('serves only its priced image models, and only with a key', () => {
    expect(new WaveSpeedProvider('k').servesModel('image', 'wavespeed-ai/flux-dev')).toBe(true);
    expect(new WaveSpeedProvider('k').servesModel('image', 'wavespeed-ai/unknown')).toBe(false);
    expect(new WaveSpeedProvider('').servesModel('image', 'wavespeed-ai/flux-dev')).toBe(false);
  });
});
