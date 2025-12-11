import express from 'express';
import cors from 'cors';
import path from 'path';
import { Router } from './core/router';
import { CompletionRequest } from './core/types';
import { logger } from './core/logger';
import { QuotaManager } from './core/quota-manager';
import { getModelScore } from './core/leaderboard-data';

export const createServer = (router: Router, quotaManager: QuotaManager) => {
  const app = express();

  app.use(cors());
  app.use(express.json());
  
  // Serve dashboard static files
  app.use('/dashboard', express.static(path.join(__dirname, '../public')));

  // Simple in-memory cache for models
  const modelCache: Record<string, { models: any[], timestamp: number }> = {}; // Types relaxed to 'any' for quick server update, essentially ModelDetail[]
  const CACHE_TTL = 3600 * 1000; // 1 hour

  // Dashboard Stats API
  app.get('/dashboard/stats', async (req, res) => {
    const stats = quotaManager.getStats();
    
    // Fetch models in parallel
    const providers = await Promise.all(router.getProviders().map(async p => {
        const pStats = stats[p.name];
        
        let models: any[] = [];
        const cached = modelCache[p.name];
        
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
            models = cached.models;
        } else {
            // Fetch fresh
            try {
                models = await p.getModels();
                // Inject scores
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
            models, // List of available models
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

  return app;
};
