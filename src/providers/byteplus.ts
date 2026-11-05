import { OpenAIProvider, upstreamBody } from './openai';
import { CompletionRequest } from '../core/types';
import { config } from '../config';

/**
 * BytePlus ModelArk's OpenAI-compatible chat provider.
 * Model and pricing references: BytePlus ModelArk pricing and model documentation
 * (https://ai.byteplus.com/ark/region:ap-southeast-1/docs/model-pricing), checked 2026-10-21.
 */
export class BytePlusProvider extends OpenAIProvider {
  name = 'BytePlus';
  family = 'BytePlus';
  capabilities: import('../core/types').Capability[] = ['chat'];

  constructor(
    apiKey: string = process.env.BYTEPLUS_ARK_API_KEY || '',
    model: string = config.DEFAULT_MODELS.BYTEPLUS_ARK,
    baseUrl: string = process.env.BYTEPLUS_ARK_BASE_URL || 'https://ark.ap-southeast.bytepluses.com/api/v3',
  ) {
    super(apiKey, model, baseUrl);
  }

  servesModel(capability: 'chat' | 'embeddings' | 'transcription' | 'speech', model: string): boolean {
    return capability === 'chat' && /^(doubao|seed|deepseek|kimi)-/i.test(model);
  }

  defaultModelFor(capability: 'chat' | 'embeddings' | 'transcription' | 'speech'): string | undefined {
    return capability === 'chat' ? this.defaultModel : undefined;
  }

  /** ModelArk reasoning is opt-in; keep private reasoning out of ordinary agent responses. */
  protected upstreamBody(request: CompletionRequest, model: string, stream: boolean): Record<string, unknown> {
    const requested = request as CompletionRequest & {
      thinking?: unknown;
      reasoning?: unknown;
      reasoning_effort?: 'low' | 'medium' | 'high' | string;
    };
    const thinkingModel = /-thinking$/i.test(model);
    const upstreamModel = model.replace(/-thinking$/i, '');
    const explicitlyRequested = requested.thinking !== undefined
      || requested.reasoning !== undefined
      || requested.reasoning_effort !== undefined;
    const enabled = thinkingModel || explicitlyRequested;
    const body = upstreamBody(request, upstreamModel, stream);
    body.thinking = { type: enabled ? 'enabled' : 'disabled' };
    delete body.reasoning;
    return body;
  }
}