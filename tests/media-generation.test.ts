import request from 'supertest';
import { hostedBilling } from './helpers/hosted-billing';
import { workspace } from './helpers/billing-fixture';
import { BytePlusProvider } from '../src/providers/byteplus';
import { WaveSpeedProvider } from '../src/providers/wavespeed';
import { imageCostUsd, mediaModel, videoCostUsd } from '../src/core/media-catalog';

/** A fake upstream for both providers: records every call; answers like WaveSpeed / BytePlus ModelArk. */
function fakeUpstream() {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  const tasks = new Map<string, any>();
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? 'GET', url, body });
    if (url.endsWith('/wavespeed-ai/flux-dev')) {
      return new Response(JSON.stringify({ code: 200, data: { id: 'ws-1', status: 'completed', outputs: Array.from({ length: body.num_images }, (_, i) => `https://cdn.wavespeed.ai/out-${i}.jpeg`) } }));
    }
    if (url.endsWith('/images/generations')) {
      return new Response(JSON.stringify({ model: body.model, data: [{ url: `https://ark.example/${calls.length}.jpeg`, size: '2048x2048' }] }));
    }
    if (url.endsWith('/contents/generations/tasks') && init.method === 'POST') {
      const id = `cgt-${tasks.size + 1}`;
      tasks.set(id, { id, model: body.model, status: 'queued', resolution: body.resolution, duration: body.duration });
      return new Response(JSON.stringify({ id }));
    }
    const m = /\/contents\/generations\/tasks\/([^/]+)$/.exec(url);
    if (m) return new Response(JSON.stringify(tasks.get(m[1]!) ?? {}), { status: tasks.has(m[1]!) ? 200 : 404 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { calls, tasks, impl };
}

async function setup() {
  const up = fakeUpstream();
  jest.spyOn(global, 'fetch').mockImplementation(up.impl);
  const h = hostedBilling();
  h.router.addProvider(new BytePlusProvider('ark-key'));
  h.router.addProvider(new WaveSpeedProvider('ws-key', 'https://api.wavespeed.ai/api/v3', { fetchImpl: up.impl, sleep: async () => {} }));
  const ws = await workspace(h.store);
  const { key } = await h.keys.create({ name: 'k', by: ws.email, workspaceId: ws.id });
  const auth = { Authorization: `Bearer ${key}` };
  return { ...h, up, ws, key, auth };
}

afterEach(() => jest.restoreAllMocks());

describe('media prices', () => {
  it('per image (Seedream 5.0 Pro dearer above 2.61M pixels); per 1M video tokens by resolution', () => {
    expect(imageCostUsd(mediaModel('seedream-4-0-250828')!, 2)).toBe(0.06);
    expect(imageCostUsd(mediaModel('dola-seedream-5-0-pro-260628')!, 1, '1536x1536')).toBe(0.045);
    expect(imageCostUsd(mediaModel('dola-seedream-5-0-pro-260628')!, 1, '2048x2048')).toBe(0.09);
    expect(imageCostUsd(mediaModel('wavespeed-ai/flux-dev')!, 3)).toBe(0.036);
    expect(videoCostUsd(mediaModel('seedance-1-0-pro-fast-251015')!, 246_000)).toBe(0.246);
    expect(videoCostUsd(mediaModel('dreamina-seedance-2-0-260128')!, 100_000, '1080p')).toBe(0.77);
    expect(videoCostUsd(mediaModel('dreamina-seedance-2-0-260128')!, 100_000, '720p')).toBe(0.7);
  });
});

describe('POST /v1/images/generations', () => {
  it('no credit: 402 and no provider is called', async () => {
    const h = await setup();
    const res = await request(h.app).post('/v1/images/generations').set(h.auth).send({ model: 'seedream-4-0-250828', prompt: 'a leaf' });
    expect(res.status).toBe(402);
    expect(h.up.calls).toHaveLength(0);
  });

  it('an unknown model is 404 with no provider call', async () => {
    const h = await setup();
    await h.store.addAdjustment(h.ws.id, 1000, 'test credit', 'test:media1');
    const res = await request(h.app).post('/v1/images/generations').set(h.auth).send({ model: 'made-up-image-model', prompt: 'a leaf' });
    expect(res.status).toBe(404);
    expect(h.up.calls).toHaveLength(0);
  });

  it('Seedream, n=2: two BytePlus calls, charged 2 x $0.03 from credit', async () => {
    const h = await setup();
    await h.store.addAdjustment(h.ws.id, 1000, 'test credit', 'test:media2');
    const res = await request(h.app).post('/v1/images/generations').set(h.auth).send({ model: 'seedream-4-0-250828', prompt: 'a leaf', n: 2 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ model: 'seedream-4-0-250828', provider: 'BytePlus', cost: 0.06 });
    expect(res.body.data).toHaveLength(2);
    expect(h.up.calls.filter((c) => c.url.endsWith('/images/generations'))).toHaveLength(2);
    expect(h.up.calls[0]!.body).toMatchObject({ model: 'seedream-4-0-250828', watermark: false, response_format: 'url' });
    await h.settle();
    expect((await h.store.balance(h.ws.id)).availableMicros).toBe(10_000_000 - 60_000);
  });

  it('FLUX on WaveSpeed: one call with num_images and size w*h, charged 3 x $0.012', async () => {
    const h = await setup();
    await h.store.addAdjustment(h.ws.id, 1000, 'test credit', 'test:media3');
    const res = await request(h.app).post('/v1/images/generations').set(h.auth).send({ model: 'wavespeed-ai/flux-dev', prompt: 'a leaf', n: 3, size: '512x512' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ provider: 'WaveSpeed', cost: 0.036 });
    expect(res.body.data).toHaveLength(3);
    expect(h.up.calls).toHaveLength(1);
    expect(h.up.calls[0]).toMatchObject({ url: 'https://api.wavespeed.ai/api/v3/wavespeed-ai/flux-dev', body: { prompt: 'a leaf', size: '512*512', num_images: 3, enable_sync_mode: true } });
    await h.settle();
    expect((await h.store.balance(h.ws.id)).availableMicros).toBe(10_000_000 - 36_000);
  });
});

describe('videos', () => {
  it('queued -> running -> succeeded; charged once, by its tokens, only when it succeeded; only its own key may read it', async () => {
    const h = await setup();
    await h.store.addAdjustment(h.ws.id, 1000, 'test credit', 'test:media4');
    const created = await request(h.app).post('/v1/videos').set(h.auth).send({ model: 'seedance-1-0-pro-fast-251015', prompt: 'waves', duration: 30 });
    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({ object: 'video', status: 'queued', model: 'seedance-1-0-pro-fast-251015', duration: 12, resolution: '720p' });
    const sent = h.up.calls.find((c) => c.url.endsWith('/contents/generations/tasks'))!;
    expect(sent.body).toMatchObject({ duration: 12, resolution: '720p', watermark: false, content: [{ type: 'text', text: 'waves' }] });
    const id = created.body.id as string;
    expect(id).toMatch(/^video_[0-9a-f]{24}$/);

    h.up.tasks.get('cgt-1').status = 'running';
    expect((await request(h.app).get(`/v1/videos/${id}`).set(h.auth)).body).toMatchObject({ status: 'running' });
    await h.settle();
    expect((await h.store.balance(h.ws.id)).availableMicros).toBe(10_000_000);

    Object.assign(h.up.tasks.get('cgt-1'), { status: 'succeeded', content: { video_url: 'https://ark.example/v.mp4' }, usage: { completion_tokens: 246_000, total_tokens: 246_000 } });
    const done = await request(h.app).get(`/v1/videos/${id}`).set(h.auth);
    expect(done.body).toMatchObject({ status: 'succeeded', url: 'https://ark.example/v.mp4', cost: 0.246 });
    await request(h.app).get(`/v1/videos/${id}`).set(h.auth);
    await h.settle();
    expect((await h.store.balance(h.ws.id)).availableMicros).toBe(10_000_000 - 246_000);

    const other = await h.keys.create({ name: 'other', by: h.ws.email, workspaceId: h.ws.id });
    expect((await request(h.app).get(`/v1/videos/${id}`).set('Authorization', `Bearer ${other.key}`)).status).toBe(404);
  });

  it('a failed video costs nothing', async () => {
    const h = await setup();
    await h.store.addAdjustment(h.ws.id, 1000, 'test credit', 'test:media5');
    const created = await request(h.app).post('/v1/videos').set(h.auth).send({ model: 'seedance-1-0-pro-fast-251015', prompt: 'waves' });
    Object.assign(h.up.tasks.get('cgt-1'), { status: 'failed', error: { code: 'OutputVideoSensitiveContentDetected', message: 'moderated' } });
    expect((await request(h.app).get(`/v1/videos/${created.body.id}`).set(h.auth)).body).toMatchObject({ status: 'failed', error: 'moderated' });
    await h.settle();
    expect((await h.store.balance(h.ws.id)).availableMicros).toBe(10_000_000);
  });

  it('/v1/pricing lists media prices', async () => {
    const h = await setup();
    const res = await request(h.app).get('/v1/pricing');
    const media = res.body.media as Array<{ id: string; per_image?: number; per_1m_video_tokens?: number }>;
    expect(media.find((m) => m.id === 'wavespeed-ai/flux-dev')).toMatchObject({ per_image: 0.012 });
    expect(media.find((m) => m.id === 'seedance-1-0-pro-fast-251015')).toMatchObject({ per_1m_video_tokens: 1 });
  });
});
