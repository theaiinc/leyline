import express from 'express';
import request from 'supertest';
import { installWaveSpeedRoutes, type WaveSpeedRouteDeps } from '../src/routes/wavespeed';
import { WAVESPEED_CATALOG, type WaveSpeedProvider } from '../src/providers/wavespeed';

describe('WaveSpeed routes', () => {
  const makeApp = (overrides: Partial<WaveSpeedRouteDeps> = {}) => {
    const provider = {
      predict: jest.fn().mockResolvedValue({
        id: 'prediction-1',
        status: 'processing',
        outputs: [],
      }),
      poll: jest.fn().mockResolvedValue({
        id: 'prediction-1',
        status: 'completed',
        outputs: ['https://wavespeed.test/result.png'],
        cost: 0.025,
      }),
    } as unknown as WaveSpeedProvider;
    const deps: WaveSpeedRouteDeps = {
      provider,
      authenticateIssuedKey: jest.fn().mockResolvedValue({ id: 'key-1', caps: {} }),
      recordUsage: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
    const app = express();
    app.use(express.json());
    installWaveSpeedRoutes(app, deps);
    return { app, deps, provider };
  };

  it('requires an issued key', async () => {
    const { app } = makeApp({
      authenticateIssuedKey: jest.fn().mockResolvedValue(null),
    });
    const response = await request(app).post('/v1/predictions').send({
      model: 'bfl/flux-dev',
      input: { prompt: 'test' },
    });
    expect(response.status).toBe(401);
  });

  it('submits predictions and records completed usage once, storing outputs', async () => {
    const storeOutput = jest.fn().mockResolvedValue('stored://result.png');
    const { app, deps, provider } = makeApp({ storeOutput });
    const created = await request(app).post('/v1/images/generations').send({
      model: 'bfl/flux-dev',
      prompt: 'test',
    });
    expect(created.status).toBe(202);
    expect(provider.predict).toHaveBeenCalledWith('bfl', 'flux-dev', { model: 'bfl/flux-dev', prompt: 'test' });

    const completed = await request(app).get('/v1/predictions/prediction-1');
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ id: 'prediction-1', status: 'completed', cost: 0.025 });
    expect(storeOutput).toHaveBeenCalledWith('key-1', 'https://wavespeed.test/result.png');
    expect(deps.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      keyId: 'key-1',
      model: 'wavespeed/bfl/flux-dev',
      outputs: ['stored://result.png'],
      computedCost: 0.025,
      reportedCost: 0.025,
    }));
    await request(app).get('/v1/predictions/prediction-1');
    expect(deps.recordUsage).toHaveBeenCalledTimes(1);
  });

  it('enforces model, request and monthly budget limits', async () => {
    const { app: modelApp } = makeApp({
      authenticateIssuedKey: jest.fn().mockResolvedValue({ id: 'key-1', caps: { models: ['wavespeed/bytedance/*'] } }),
    });
    expect((await request(modelApp).post('/v1/predictions').send({ model: 'bfl/flux-dev' })).status).toBe(403);

    const { app: rateApp } = makeApp({
      authenticateIssuedKey: jest.fn().mockResolvedValue({ id: 'key-1', caps: { requestsPerMinute: 0 } }),
    });
    expect((await request(rateApp).post('/v1/predictions').send({ model: 'bfl/flux-dev' })).status).toBe(429);

    const { app: budgetApp } = makeApp({
      authenticateIssuedKey: jest.fn().mockResolvedValue({ id: 'key-1', caps: { usdPerMonth: 1 } }),
      getMonthlySpend: jest.fn().mockResolvedValue(1),
    });
    expect((await request(budgetApp).post('/v1/predictions').send({ model: 'bfl/flux-dev' })).status).toBe(429);
  });

  it('publishes offered model and pricing metadata', async () => {
    const { app } = makeApp();
    const models = await request(app).get('/v1/models');
    const pricing = await request(app).get('/v1/pricing');
    expect(models.status).toBe(200);
    expect(pricing.status).toBe(200);
    expect(models.body.data).toHaveLength(WAVESPEED_CATALOG.length);
    expect(pricing.body.data).toHaveLength(WAVESPEED_CATALOG.length);
    expect(pricing.body.data.find((entry: { model: string }) => entry.model.endsWith('latentsync'))).toMatchObject({
      rule: { unit: 'audio_5_seconds', minimum_seconds: 3, maximum_seconds: 600, rounding: 'ceil' },
    });
  });
});