import type { Express, Request, Response } from 'express';
import {
  computeWaveSpeedCost,
  WAVESPEED_CATALOG,
  type WaveSpeedPrediction,
  type WaveSpeedProvider,
} from '../providers/wavespeed';

export type WaveSpeedUsage = {
  keyId: string;
  model: string;
  outputs: string[];
  reportedCost: number | null;
  computedCost: number;
  completedAt: number;
};

export type WaveSpeedRouteDeps = {
  provider: WaveSpeedProvider;
  authenticateIssuedKey: (req: Request) => Promise<{ id: string; caps?: { models?: string[] | null; requestsPerMinute?: number | null; usdPerMonth?: number | null } } | null>;
  recordUsage: (usage: WaveSpeedUsage) => Promise<void>;
  storeOutput?: (owner: string, url: string) => Promise<string>;
  getMonthlySpend?: (keyId: string) => Promise<number>;
};

type PredictionRecord = {
  id: string;
  keyId: string;
  model: string;
  provider: string;
  modelName: string;
  input: Record<string, unknown>;
  submittedAt: number;
  prediction: WaveSpeedPrediction;
};

const predictions = new Map<string, PredictionRecord>();

function unauthorized(res: Response) {
  return res.status(401).json({ error: { message: 'issued API key required', type: 'authentication_error' } });
}

function catalogModel(id: string) {
  return WAVESPEED_CATALOG.find(model => model.id === id);
}

function allowedModel(model: string, caps?: { models?: string[] | null }) {
  const allowed = caps?.models;
  if (!allowed?.length) return true;
  return allowed.some(pattern => pattern === model || (pattern.endsWith('*') && model.startsWith(pattern.slice(0, -1))));
}

async function authenticate(req: Request, res: Response, deps: WaveSpeedRouteDeps) {
  const key = await deps.authenticateIssuedKey(req);
  if (!key) {
    unauthorized(res);
    return null;
  }
  return key;
}

function predictionResponse(record: PredictionRecord, outputs?: string[], cost?: number | null) {
  return {
    id: record.id,
    status: record.prediction.status,
    outputs: outputs ?? record.prediction.outputs ?? [],
    usage: record.prediction.usage ?? {},
    cost: cost ?? record.prediction.cost ?? null,
    model: record.model,
  };
}

export function installWaveSpeedRoutes(app: Express, deps: WaveSpeedRouteDeps) {
  const submit = async (req: Request, res: Response, imageOnly: boolean) => {
    const key = await authenticate(req, res, deps);
    if (!key) return;
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const requestedModel = typeof body.model === 'string' ? body.model : '';
    const modelId = requestedModel.startsWith('wavespeed/') ? requestedModel : `wavespeed/${requestedModel}`;
    const catalog = catalogModel(modelId);
    if (!catalog || (imageOnly && catalog.modality !== 'image')) {
      return res.status(400).json({ error: { message: `WaveSpeed model is not offered: ${requestedModel}`, type: 'invalid_request_error' } });
    }
    const caps: { models?: string[] | null; requestsPerMinute?: number | null; usdPerMonth?: number | null } = key.caps ?? {};
    if (!allowedModel(modelId, caps) || !allowedModel(requestedModel, caps)) {
      return res.status(403).json({ error: { message: 'model is not permitted for this key', type: 'permission_error' } });
    }
    if (caps.requestsPerMinute != null && caps.requestsPerMinute <= 0) {
      return res.status(429).json({ error: { message: 'request limit exceeded', type: 'rate_limit_error' } });
    }
    if (caps.usdPerMonth != null && deps.getMonthlySpend) {
      const spend = await deps.getMonthlySpend(key.id);
      if (spend >= caps.usdPerMonth) {
        return res.status(429).json({ error: { message: 'monthly budget exceeded', type: 'budget_exceeded' } });
      }
    }
    const input = (body.input && typeof body.input === 'object' && !Array.isArray(body.input) ? body.input : body) as Record<string, unknown>;
    const modelParts = modelId.split('/');
    const provider = modelParts[1] ?? '';
    const modelName = modelParts.slice(2).join('/');
    const prediction = await deps.provider.predict(provider, modelName, input);
    const record: PredictionRecord = {
      id: prediction.id,
      keyId: key.id,
      model: modelId,
      provider,
      modelName,
      input,
      submittedAt: Date.now(),
      prediction,
    };
    predictions.set(record.id, record);
    return res.status(202).json(predictionResponse(record));
  };

  app.post('/v1/images/generations', (req, res) => submit(req, res, true));
  app.post('/v1/predictions', (req, res) => submit(req, res, false));

  app.get('/v1/predictions/:id', async (req, res) => {
    const key = await authenticate(req, res, deps);
    if (!key) return;
    const record = predictions.get(req.params.id);
    if (!record || record.keyId !== key.id) return res.status(404).json({ error: { message: 'prediction not found', type: 'not_found_error' } });
    if (!['completed', 'failed', 'cancelled', 'canceled'].includes(record.prediction.status)) {
      record.prediction = await deps.provider.poll(record.id);
    }
    const outputs = (record.prediction.outputs ?? []).filter((output): output is string => typeof output === 'string');
    if (record.prediction.status === 'completed') {
      const cost = record.prediction.cost ?? computeWaveSpeedCost(catalogModel(record.model)!, record.input);
      const stored = deps.storeOutput ? await Promise.all(outputs.map(url => deps.storeOutput!(key.id, url))) : outputs;
      record.prediction.outputs = stored;
      if (!(record as PredictionRecord & { usageRecorded?: boolean }).usageRecorded) {
        (record as PredictionRecord & { usageRecorded?: boolean }).usageRecorded = true;
        await deps.recordUsage({
          keyId: key.id,
          model: record.model,
          outputs: stored,
          reportedCost: record.prediction.cost ?? null,
          computedCost: cost,
          completedAt: Date.now(),
        });
        (record as PredictionRecord & { usageRecorded?: boolean }).usageRecorded = true;
      }
      return res.json(predictionResponse(record, stored, cost));
    }
    return res.json(predictionResponse(record));
  });

  app.get('/v1/models', async (req, res) => {
    const key = await authenticate(req, res, deps);
    if (!key) return;
    const caps: { models?: string[] | null } = key.caps ?? {};
    return res.json({ object: 'list', data: WAVESPEED_CATALOG.filter(model => allowedModel(model.id, caps)).map(model => ({ id: model.id, object: 'model', modality: model.modality, input_schema: model.inputSchema, pricing: model.pricing, pricing_rule: model.pricingRule })) });
  });

  app.get('/v1/pricing', async (req, res) => {
    const key = await authenticate(req, res, deps);
    if (!key) return;
    const caps: { models?: string[] | null } = key.caps ?? {};
    return res.json({ data: WAVESPEED_CATALOG.filter(model => allowedModel(model.id, caps)).map(model => ({ model: model.id, pricing: model.pricing, rule: model.pricingRule })) });
  });
}