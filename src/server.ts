import express from 'express';
import cors from 'cors';
import path from 'path';
import { Router } from './core/router';
import { CompletionRequest, ClassifyRequest } from './core/types';
import { logger } from './core/logger';
import { QuotaManager } from './core/quota-manager';
import { getModelScore } from './core/leaderboard-data';

export const createServer = (router: Router, quotaManager: QuotaManager) => {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Serve dashboard static files
  app.use('/dashboard', express.static(path.join(__dirname, '../public')));

  // Serve logo at root level
  app.get('/logo.png', (_req, res) => {
    res.sendFile(path.join(__dirname, '../public/logo.png'));
  });

  // Simple in-memory cache for models
  const modelCache: Record<string, { models: any[], timestamp: number }> = {};
  const CACHE_TTL = 3600 * 1000; // 1 hour

  // Dashboard Stats API
  app.get('/dashboard/stats', async (req, res) => {
    const stats = quotaManager.getStats();

    const providers = await Promise.all(router.getProviders().map(async p => {
        const pStats = stats[p.name];

        let models: any[] = [];
        const cached = modelCache[p.name];

        if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
            models = cached.models;
        } else {
            try {
                models = await p.getModels();
                models = models.map(m => ({
                    ...m,
                    score: getModelScore(m.id)
                }));
                modelCache[p.name] = { models, timestamp: Date.now() };
            } catch (e) {
                console.error(`Failed to fetch models for ${p.name}`, e);
                models = [];
            }
        }

        return {
            name: p.name,
            defaultModel: p.defaultModel,
            models,
            quota: pStats?.quota,
            usage: {
                minute: pStats?.minute || 0,
                day: pStats?.day || 0
            }
        };
    }));

    res.json({
        providers,
        logs: logger.getLogs()
    });
  });

  // Existing: chat completions endpoint (with provider failover)
  app.post('/v1/chat/completions', async (req, res) => {
    const request: CompletionRequest = req.body;

    try {
      if (request.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const stream = await router.routeStream(request);

        for await (const chunk of stream) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();

      } else {
        const response = await router.route(request);
        res.json(response);
      }
    } catch (error: any) {
      console.error('API Error:', error.message);
      res.status(503).json({
        error: {
          message: 'Service Unavailable: ' + error.message,
          type: 'service_unavailable',
          code: 503
        }
      });
    }
  });

  // ── NEW: Routing decision endpoint ───────────────────────────────────
  // Returns a full routing decision (tier, model, provider, classification)
  // for a user message. Used by agent pipelines to decide which model to
  // use before dispatching a request.
  app.post('/v1/route', async (req, res) => {
    const { user_message, chat_history } = req.body || {};
    if (!user_message) {
      return res.status(400).json({ error: 'user_message is required' });
    }

    try {
      const classifyReq: ClassifyRequest = {
        userMessage: user_message,
        chatHistory: chat_history,
      };
      const result = await router.resolveRoute(classifyReq);
      return res.json(result);
    } catch (error: any) {
      console.error('/v1/route Error:', error.message);
      return res.status(500).json({
        error: 'Routing failed: ' + error.message,
      });
    }
  });

  return app;
};
