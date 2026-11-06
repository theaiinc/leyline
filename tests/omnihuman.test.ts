import request from 'supertest';
import { createHash } from 'crypto';
import { hostedBilling } from './helpers/hosted-billing';
import { workspace } from './helpers/billing-fixture';
import { BytePlusVisionProvider, mp4DurationSeconds, signVisionRequest } from '../src/providers/byteplus-vision';
import { avatarCostUsd, mediaModel } from '../src/core/media-catalog';

const IMAGE = 'https://cdn.example/portrait.jpg';
const AUDIO = 'https://cdn.example/speech.mp3';
const VIDEO = 'https://vision.example/out.mp4';

/** A minimal MP4: ftyp, mdat, then moov (at the end, as a non-"faststart" file) with an mvhd of `units` / `timescale`. */
function mp4(units: number, timescale = 1000, mdatBytes = 5000): Uint8Array {
  const box = (type: string, payload: Uint8Array) => {
    const out = new Uint8Array(8 + payload.length);
    new DataView(out.buffer).setUint32(0, out.length);
    out.set([...type].map((c) => c.charCodeAt(0)), 4);
    out.set(payload, 8);
    return out;
  };
  const ftyp = box('ftyp', new Uint8Array([...'isom'].map((c) => c.charCodeAt(0)).concat([0, 0, 2, 0], [...'isom'].map((c) => c.charCodeAt(0)))));
  const mvhd = new Uint8Array(100);
  const dv = new DataView(mvhd.buffer);
  dv.setUint32(12, timescale);
  dv.setUint32(16, units);
  const moov = box('moov', box('mvhd', mvhd));
  const mdat = box('mdat', new Uint8Array(mdatBytes));
  const file = new Uint8Array(ftyp.length + mdat.length + moov.length);
  file.set(ftyp, 0); file.set(mdat, ftyp.length); file.set(moov, ftyp.length + mdat.length);
  return file;
}

/** Serves bytes with Range support (206), or the whole file (200) when `ranges` is false. */
function serveFile(bytes: Uint8Array, init: RequestInit = {}, ranges = true): Response {
  const range = new Headers(init.headers).get('range');
  const m = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
  if (!ranges || !m) return new Response(bytes.slice().buffer as ArrayBuffer, { status: 200, headers: { 'content-length': String(bytes.length) } });
  const from = Number(m[1]);
  if (from >= bytes.length) return new Response(null, { status: 416 });
  return new Response(bytes.slice(from, Math.min(bytes.length, Number(m[2]) + 1)).buffer as ArrayBuffer, { status: 206 });
}

/** A fake BytePlus Vision API (cv.byteplusapi.com) and the CDN its videos come from. */
function fakeVision() {
  const calls: Array<{ url: string; action: string | null; headers: Headers; body: any; raw: string }> = [];
  const tasks = new Map<string, { status: string; code?: number; message?: string; video_url?: string }>();
  let file = mp4(12_345);
  let videoStatus = 200;
  let queryReply: ((taskId: string) => object) | null = null;
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url === VIDEO) return videoStatus === 200 ? serveFile(file, init) : new Response('gone', { status: videoStatus });
    const action = new URL(url).searchParams.get('Action');
    const raw = String(init.body ?? '');
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ url, action, headers: new Headers(init.headers), body, raw });
    if (action === 'CVSync2AsyncSubmitTask') {
      const id = `73926163365196104${String(9 + tasks.size).padStart(2, '0')}`;
      tasks.set(id, { status: 'in_queue' });
      return new Response(JSON.stringify({ code: 10000, data: { task_id: id }, message: 'Success', request_id: 'r1', status: 10000 }));
    }
    if (action === 'CVSync2AsyncGetResult') {
      if (queryReply) return new Response(JSON.stringify(queryReply(body.task_id)));
      const t = tasks.get(body.task_id);
      if (!t) return new Response(JSON.stringify({ code: 10000, data: { status: 'not_found' }, message: 'Success' }));
      return new Response(JSON.stringify({ code: t.code ?? 10000, message: t.message ?? 'Success', data: { status: t.status, ...(t.video_url ? { video_url: t.video_url } : {}) }, request_id: 'r2' }));
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return {
    calls, tasks, impl,
    setFile: (f: Uint8Array) => { file = f; },
    setVideoStatus: (s: number) => { videoStatus = s; },
    setQueryReply: (f: ((taskId: string) => object) | null) => { queryReply = f; },
  };
}

async function setup() {
  const up = fakeVision();
  const h = hostedBilling();
  h.router.addProvider(new BytePlusVisionProvider('AKTEST', 'test-secret==', { fetchImpl: up.impl, now: () => new Date('2026-11-06T10:15:00Z') }));
  const ws = await workspace(h.store);
  const { key } = await h.keys.create({ name: 'k', by: ws.email, workspaceId: ws.id });
  await h.store.addAdjustment(ws.id, 1000, 'test credit', `test:omni-${Math.random()}`);
  return { ...h, up, ws, auth: { Authorization: `Bearer ${key}` } };
}

const start = (h: Awaited<ReturnType<typeof setup>>, body: object = { model: 'omnihuman-2.0', image: IMAGE, audio: AUDIO, prompt: 'She smiles and nods' }) =>
  request(h.app).post('/v1/videos').set(h.auth).send(body);

afterEach(() => jest.restoreAllMocks());

describe('BytePlus Vision signature', () => {
  it('matches BytePlus\'s own HTTP sample algorithm for a fixed request (vector computed with its Python sample)', () => {
    // https://docs.byteplus.com/en/docs/byteplus-vision/http_request_sample (Python), with the clock fixed at
    // 20261106T101500Z, AK "AKTESTEXAMPLE", SK "c2VjcmV0LWV4YW1wbGU=" and this exact body.
    const body = '{"req_key":"realman_avatar_picture_omni20_cv","task_id":"7392616336519610409"}';
    const headers = signVisionRequest({
      accessKeyId: 'AKTESTEXAMPLE', secretAccessKey: 'c2VjcmV0LWV4YW1wbGU=', body, now: new Date('2026-11-06T10:15:00Z'),
      query: { Version: '2024-06-06', Action: 'CVSync2AsyncGetResult' },
    });
    expect(headers).toEqual({
      'Content-Type': 'application/json',
      'X-Date': '20261106T101500Z',
      'X-Content-Sha256': 'd6497f55d5350aacfea8ce69d8de79e8cd8c8fcd214b5e1b10f1fcf99d12fd33',
      Authorization: 'HMAC-SHA256 Credential=AKTESTEXAMPLE/20261106/ap-singapore-1/cv/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=37e547a331861d22f0afa0b80099b21ce6247175adca0de957d527ad00283b88',
    });
  });
});

describe('MP4 duration', () => {
  it('reads mvhd with ranged reads, moov at the end; and from a whole file when Range is ignored', async () => {
    const file = mp4(12_345, 1000, 200_000);
    const seen: string[] = [];
    const ranged = (async (_u: string | URL, init: RequestInit = {}) => { seen.push(new Headers(init.headers).get('range') ?? ''); return serveFile(file, init); }) as typeof fetch;
    expect(await mp4DurationSeconds(VIDEO, ranged)).toBeCloseTo(12.345, 9);
    expect(seen.length).toBeLessThanOrEqual(4); // ftyp, mdat, moov header, moov
    const whole = (async (_u: string | URL, init: RequestInit = {}) => serveFile(mp4(900, 90), init, false)) as typeof fetch;
    expect(await mp4DurationSeconds(VIDEO, whole)).toBe(10);
  });

  it('throws on something that is not an MP4', async () => {
    const junk = (async (_u: string | URL, init: RequestInit = {}) => serveFile(new Uint8Array(64), init)) as typeof fetch;
    await expect(mp4DurationSeconds(VIDEO, junk)).rejects.toThrow();
  });
});

describe('OmniHuman 2.0 on POST /v1/videos', () => {
  it('price: $0.07 per second of video, exact to the micro-dollar', () => {
    const m = mediaModel('omnihuman-2.0', 'video')!;
    expect(m.avatar).toMatchObject({ perSecondUsd: 0.07, reqKey: 'realman_avatar_picture_omni20_cv' });
    expect(avatarCostUsd(m, 12.345)).toBe(0.86415);
    expect(avatarCostUsd(m, 300)).toBe(21);
    expect(avatarCostUsd(m, 4)).toBe(0.28);
  });

  it('submits a signed CVSync2AsyncSubmitTask with the image, audio and prompt; 202 queued', async () => {
    const h = await setup();
    const res = await start(h);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ object: 'video', status: 'queued', model: 'omnihuman-2.0' });
    expect(h.up.calls).toHaveLength(1);
    const c = h.up.calls[0]!;
    expect(c.url).toBe('https://cv.byteplusapi.com/?Action=CVSync2AsyncSubmitTask&Version=2024-06-06');
    expect(c.body).toEqual({ req_key: 'realman_avatar_picture_omni20_cv', image_urls: [IMAGE], audio_url: AUDIO, prompt: 'She smiles and nods', enable_watermark: false });
    expect(c.headers.get('x-date')).toBe('20261106T101500Z');
    expect(c.headers.get('x-content-sha256')).toBe(createHash('sha256').update(c.raw).digest('hex'));
    expect(c.headers.get('authorization')).toMatch(/^HMAC-SHA256 Credential=AKTEST\/20261106\/ap-singapore-1\/cv\/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/);
    // The signature is the one BytePlus's algorithm gives for exactly what was sent.
    expect(c.headers.get('authorization')).toBe(signVisionRequest({ accessKeyId: 'AKTEST', secretAccessKey: 'test-secret==', body: c.raw, now: new Date('2026-11-06T10:15:00Z'), query: { Action: 'CVSync2AsyncSubmitTask', Version: '2024-06-06' } }).Authorization);
  });

  it('the prompt is optional', async () => {
    const h = await setup();
    const res = await start(h, { model: 'omnihuman-2.0', image: IMAGE, audio: AUDIO });
    expect(res.status).toBe(202);
    expect(h.up.calls[0]!.body).not.toHaveProperty('prompt');
  });

  it.each([
    [{ audio: AUDIO }, 'invalid_image'],
    [{ image: IMAGE }, 'invalid_audio'],
    [{ image: 'not a url', audio: AUDIO }, 'invalid_image'],
    [{ image: IMAGE, audio: 'ftp://x/a.mp3' }, 'invalid_audio'],
    [{ image: IMAGE, audio: AUDIO, prompt: 42 }, 'invalid_prompt'],
  ])('%j -> 400 %s, no provider call', async (fields, code) => {
    const h = await setup();
    const res = await start(h, { model: 'omnihuman-2.0', ...fields });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
    expect(h.up.calls).toHaveLength(0);
  });

  it('an OmniHuman model that isn\'t in the catalog is 404; one without a price is refused 400 (no provider call either way)', async () => {
    const h = await setup();
    expect((await start(h, { model: 'omnihuman-1.5', image: IMAGE, audio: AUDIO })).status).toBe(404);
    const m = mediaModel('omnihuman-2.0')!;
    const price = m.avatar!.perSecondUsd;
    m.avatar!.perSecondUsd = Number.NaN;
    try {
      const res = await start(h);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('model_not_priced');
    } finally {
      m.avatar!.perSecondUsd = price;
    }
    expect(h.up.calls).toHaveLength(0);
  });

  it('in_queue -> queued, generating -> running, done -> succeeded; charged once, by the video\'s seconds', async () => {
    const h = await setup();
    const id = (await start(h)).body.id as string;
    const task = [...h.up.tasks.values()][0]!;
    expect((await request(h.app).get(`/v1/videos/${id}`).set(h.auth)).body).toMatchObject({ status: 'queued' });
    task.status = 'generating';
    expect((await request(h.app).get(`/v1/videos/${id}`).set(h.auth)).body).toMatchObject({ status: 'running' });
    await h.settle();
    expect((await h.store.balance(h.ws.id)).availableMicros).toBe(10_000_000);

    Object.assign(task, { status: 'done', video_url: VIDEO });
    const done = await request(h.app).get(`/v1/videos/${id}`).set(h.auth);
    expect(done.body).toMatchObject({ status: 'succeeded', url: VIDEO, seconds: 12.345, cost: 0.86415 });
    const query = h.up.calls.find((c) => c.action === 'CVSync2AsyncGetResult')!;
    expect(query.url).toBe('https://cv.byteplusapi.com/?Action=CVSync2AsyncGetResult&Version=2024-06-06');
    expect(query.body).toEqual({ req_key: 'realman_avatar_picture_omni20_cv', task_id: '7392616336519610409' });
    expect((await request(h.app).get(`/v1/videos/${id}`).set(h.auth)).body).toMatchObject({ status: 'succeeded', cost: 0.86415 });
    await h.settle();
    // 12.345 s x $0.07 = $0.86415, charged once.
    expect((await h.store.balance(h.ws.id)).availableMicros).toBe(10_000_000 - 864_150);
  });

  it('charged its official price even when a campaign lists it (campaigns don\'t price by the second)', async () => {
    const h = await setup();
    await h.campaigns.create({ name: 'Avatar week', type: 'automatic', code: null, status: 'active', startsAt: 0, endsAt: Date.UTC(2100, 0), models: ['omnihuman-2.0'],
      discount: { kind: 'percent', percentBp: 5000 }, maxRedemptions: null, oncePerWorkspace: true }, 'owner');
    const id = (await start(h)).body.id as string;
    Object.assign([...h.up.tasks.values()][0]!, { status: 'done', video_url: VIDEO });
    h.up.setFile(mp4(10_000));
    await request(h.app).get(`/v1/videos/${id}`).set(h.auth);
    await h.settle();
    expect((await h.store.balance(h.ws.id)).availableMicros).toBe(10_000_000 - 700_000);
  });

  it('a failed task ("done" with an error code) costs nothing', async () => {
    const h = await setup();
    const id = (await start(h)).body.id as string;
    Object.assign([...h.up.tasks.values()][0]!, { status: 'done', code: 50510, message: 'Algovproxy Risk Error' });
    expect((await request(h.app).get(`/v1/videos/${id}`).set(h.auth)).body).toMatchObject({ status: 'failed', error: 'Algovproxy Risk Error' });
    await h.settle();
    expect((await h.store.balance(h.ws.id)).availableMicros).toBe(10_000_000);
  });

  it('a query that fails (rate limit, no task state) is an error to retry, not a failed video; nothing charged', async () => {
    const h = await setup();
    const id = (await start(h)).body.id as string;
    h.up.setQueryReply(() => ({ code: 50429, data: null, message: 'Request Has Reached API Limit, Please Try Later' }));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(h.app).get(`/v1/videos/${id}`).set(h.auth);
    expect(res.status).toBeGreaterThanOrEqual(500);
    await h.settle();
    expect((await h.store.balance(h.ws.id)).availableMicros).toBe(10_000_000);
  });

  it('expired / canceled tasks map to expired / cancelled, $0', async () => {
    const h = await setup();
    const id = (await start(h)).body.id as string;
    const task = [...h.up.tasks.values()][0]!;
    task.status = 'canceled';
    expect((await request(h.app).get(`/v1/videos/${id}`).set(h.auth)).body).toMatchObject({ status: 'cancelled' });
    task.status = 'expired';
    expect((await request(h.app).get(`/v1/videos/${id}`).set(h.auth)).body).toMatchObject({ status: 'expired' });
    await h.settle();
    expect((await h.store.balance(h.ws.id)).availableMicros).toBe(10_000_000);
  });

  it('when the video\'s length can\'t be read, it isn\'t handed over or charged yet (running); the next poll charges it', async () => {
    const h = await setup();
    const id = (await start(h)).body.id as string;
    Object.assign([...h.up.tasks.values()][0]!, { status: 'done', video_url: VIDEO });
    h.up.setVideoStatus(503);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await request(h.app).get(`/v1/videos/${id}`).set(h.auth);
    expect(res.body).toMatchObject({ status: 'running' });
    expect(res.body).not.toHaveProperty('url');
    await h.settle();
    expect((await h.store.balance(h.ws.id)).availableMicros).toBe(10_000_000);
    h.up.setVideoStatus(200);
    expect((await request(h.app).get(`/v1/videos/${id}`).set(h.auth)).body).toMatchObject({ status: 'succeeded', cost: 0.86415 });
    await h.settle();
    expect((await h.store.balance(h.ws.id)).availableMicros).toBe(10_000_000 - 864_150);
    jest.restoreAllMocks();
  });

  it('/v1/pricing lists it per second, with its official source', async () => {
    const h = await setup();
    const media = (await request(h.app).get('/v1/pricing')).body.media as Array<Record<string, unknown>>;
    expect(media.find((m) => m.id === 'omnihuman-2.0')).toEqual({
      id: 'omnihuman-2.0', name: 'OmniHuman 2.0', provider: 'BytePlusVision', kind: 'video', source: 'https://www.byteplus.com/en/product/OmniHuman',
      per_second: 0.07, inputs: ['image', 'audio'], audio_seconds: { min: 4, max: 300 },
    });
  });

  it('not served without an Access Key: 503, nothing sent', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = hostedBilling();
    h.router.addProvider(new BytePlusVisionProvider('', ''));
    const ws = await workspace(h.store);
    const { key } = await h.keys.create({ name: 'k', by: ws.email, workspaceId: ws.id });
    await h.store.addAdjustment(ws.id, 1000, 'test credit', 'test:omni-nokey');
    const res = await request(h.app).post('/v1/videos').set({ Authorization: `Bearer ${key}` }).send({ model: 'omnihuman-2.0', image: IMAGE, audio: AUDIO });
    expect(res.status).toBe(503);
    jest.restoreAllMocks();
  });
});
