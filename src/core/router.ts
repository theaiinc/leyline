import { Provider, CompletionRequest, CompletionResponse, StreamChunk } from './types';
import { QuotaManager } from './quota-manager';

import { logger } from './logger';

export class Router {
  private providers: Provider[] = [];
  private quotaManager: QuotaManager;

  constructor(quotaManager: QuotaManager) {
    this.quotaManager = quotaManager;
  }

  addProvider(provider: Provider) {
    this.providers.push(provider);
  }

  async route(request: CompletionRequest): Promise<CompletionResponse> {
    const start = Date.now();
    const requestId = Math.random().toString(36).substring(7);

    for (const provider of this.providers) {
      if (!this.quotaManager.checkQuota(provider.name)) {
        logger.log({ requestId, provider: provider.name, model: request.model, status: 'rate_limited', error: 'Quota exceeded' });
        console.warn(`[Router] Skipping ${provider.name} due to quota limit.`);
        continue;
      }

      console.log(`[Router] Attempting to route to ${provider.name}...`);
      try {
        const isAvailable = await provider.isAvailable();
        if (!isAvailable) {
            console.warn(`[Router] ${provider.name} reported unavailable.`);
            continue;
        }

        const effectiveModel = request.model === 'auto' ? provider.defaultModel : request.model;
        console.log(`[Router] Routing to ${provider.name} with model: ${effectiveModel}`);
        
        const response = await provider.complete({ ...request, model: effectiveModel });
        this.quotaManager.incrementUsage(provider.name);
        logger.log({ 
            requestId,
            provider: provider.name, 
            model: effectiveModel, 
            status: 'success', 
            duration: Date.now() - start 
        });
        console.log(`[Router] Successfully routed to ${provider.name}.`);
        return response;
      } catch (error: any) {
        logger.log({ requestId, provider: provider.name, model: request.model, status: 'error', error: error.message, duration: Date.now() - start });
        console.error(`[Router] Error with ${provider.name}:`, error.message);
        // Fallback to next provider
      }
    }
    throw new Error('All providers failed or are rate-limited.');
  }

  async *routeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
    const start = Date.now();
    const requestId = Math.random().toString(36).substring(7); // Grouping ID for this user request
    let accumulatedContent = '';
    const originalMessages = [...request.messages];

    for (const provider of this.providers) {
        if (!this.quotaManager.checkQuota(provider.name)) {
          logger.log({ requestId, provider: provider.name, model: request.model, status: 'rate_limited', error: 'Quota exceeded' });
          console.warn(`[Router] Skipping ${provider.name} due to quota limit.`);
          continue;
        }
  
        console.log(`[Router] Attempting to route stream to ${provider.name}...`);
        
        // Prepare messages for this attempt (potentially with stitched history)
        const currentMessages = [...originalMessages];
        if (accumulatedContent) {
             // If we have content from a previous failed provider, append it as a pre-fill assistant message
             // This encourages the next model to continue completion
             currentMessages.push({ role: 'assistant', content: accumulatedContent });
             console.log(`[Router] Stitching content for ${provider.name}. Length: ${accumulatedContent.length}`);
        }

        let providerChars = 0;
        try {
            const isAvailable = await provider.isAvailable();
            if (!isAvailable) {
                console.warn(`[Router] ${provider.name} reported unavailable.`);
                continue;
            }

          const effectiveModel = request.model === 'auto' ? provider.defaultModel : request.model;
          console.log(`[Router] Routing stream to ${provider.name} with model: ${effectiveModel}`);

          const stream = provider.completeStream({ ...request, messages: currentMessages, model: effectiveModel });
          this.quotaManager.incrementUsage(provider.name); 

          for await (const chunk of stream) {
              const content = chunk.choices[0]?.delta?.content || '';
              accumulatedContent += content;
              providerChars += content.length;
              yield chunk; 
          }
          
          logger.log({ 
              requestId, 
              provider: provider.name, 
              model: effectiveModel, 
              status: 'success', 
              duration: Date.now() - start,
              usage: { chars: providerChars }
            });
          return;
        } catch (error: any) {
          logger.log({ 
              requestId, 
              provider: provider.name, 
              model: request.model, 
              status: 'error', 
              error: error.message, 
              duration: Date.now() - start,
              usage: { chars: providerChars } 
          });
          console.error(`[Router] Stream Error with ${provider.name}:`, error); // Log full error
        }
      }
      throw new Error('All providers failed or are rate-limited.');
  }

  getProviders(): Provider[] {
      return this.providers;
  }
}
