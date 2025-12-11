import { createServer } from './server';
import { Router } from './core/router';
import { QuotaManager } from './core/quota-manager';
import { GeminiProvider } from './providers/gemini';
import { HuggingFaceProvider } from './providers/huggingface';
import { OpenRouterProvider } from './providers/openrouter';
import { OllamaProvider } from './providers/ollama';
import { config } from './config';

async function bootstrap() {
  const quotaManager = new QuotaManager();
  
  // Configure Quotas
  quotaManager.setQuota('Gemini', config.quotas.gemini);
  quotaManager.setQuota('HuggingFace', config.quotas.huggingface);
  quotaManager.setQuota('OpenRouter', config.quotas.openrouter);
  quotaManager.setQuota('Ollama', config.quotas.ollama);

  const router = new Router(quotaManager);

  // Add providers in priority order
  router.addProvider(new GeminiProvider());
  router.addProvider(new HuggingFaceProvider());
  router.addProvider(new OpenRouterProvider());
  router.addProvider(new OllamaProvider());

  const app = createServer(router, quotaManager);

  app.listen(config.port, () => {
    console.log(`AI Router listening on port ${config.port}`);
  });
}

bootstrap();
