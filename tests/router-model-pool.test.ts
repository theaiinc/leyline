import { Router } from '../src/core/router';
import { QuotaManager } from '../src/core/quota-manager';
import { Provider, CompletionRequest, CompletionResponse, StreamChunk, ModelDetail } from '../src/core/types';
import { logger } from '../src/core/logger';

class MockProvider implements Provider {
    name: string;
    defaultModel: string;
    models: string[];
    lastRequest?: CompletionRequest;

    constructor(name: string, defaultModel: string, models: string[]) {
        this.name = name;
        this.defaultModel = defaultModel;
        this.models = models;
    }

    async isAvailable(): Promise<boolean> {
        return true;
    }

    async getModels(): Promise<ModelDetail[]> {
        return this.models.map(id => ({ id }));
    }

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
        this.lastRequest = request;
        return {
            id: 'mock',
            object: 'chat.completion',
            created: Date.now(),
            model: request.model,
            choices: [{
                index: 0,
                message: { role: 'assistant', content: `Response from ${this.name}` },
                finish_reason: 'stop',
            }],
        };
    }

    async *completeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
        this.lastRequest = request;
        yield {
            id: 'mock',
            object: 'chat.completion.chunk',
            created: Date.now(),
            model: request.model,
            choices: [{
                index: 0,
                delta: { content: `Response from ${this.name}` },
                finish_reason: null,
            }],
        };
    }
}

describe('Router model pool', () => {
    let router: Router;
    let alpha: MockProvider;
    let beta: MockProvider;

    beforeEach(() => {
        logger.clear();
        router = new Router({ quotaManager: new QuotaManager() });
        alpha = new MockProvider('Alpha', 'alpha-default', ['alpha-default', 'alpha-small']);
        beta = new MockProvider('Beta', 'beta-default', ['beta-default', 'beta-large']);
        router.addProvider(alpha);
        router.addProvider(beta);
    });

    it('routes auto requests across all models when no pool is configured', async () => {
        const response = await router.route({ model: 'auto', messages: [] });
        expect(response.choices[0].message.content).toContain('Alpha');
        expect(alpha.lastRequest?.model).toBe('alpha-default');
    });

    it('skips providers with no enabled models in auto mode', async () => {
        router.setEnabledModels({ Beta: ['beta-large'] });
        const response = await router.route({ model: 'auto', messages: [] });
        expect(response.choices[0].message.content).toContain('Beta');
        expect(beta.lastRequest?.model).toBe('beta-large');
        expect(alpha.lastRequest).toBeUndefined();
    });

    it('prefers the default model when it is enabled', async () => {
        router.setEnabledModels({ Alpha: ['alpha-small', 'alpha-default'] });
        await router.route({ model: 'auto', messages: [] });
        expect(alpha.lastRequest?.model).toBe('alpha-default');
    });

    it('uses the first enabled model when the default is toggled off', async () => {
        router.setEnabledModels({ Alpha: ['alpha-small'] });
        await router.route({ model: 'auto', messages: [] });
        expect(alpha.lastRequest?.model).toBe('alpha-small');
    });

    it('matches provider names case-insensitively', async () => {
        router.setEnabledModels({ 'alpha': ['alpha-small'] });
        await router.route({ model: 'auto', messages: [] });
        expect(alpha.lastRequest?.model).toBe('alpha-small');
    });

    it('treats a pool with only empty lists as unconfigured', async () => {
        router.setEnabledModels({ Alpha: [], Beta: [] });
        const response = await router.route({ model: 'auto', messages: [] });
        expect(response.choices[0].message.content).toContain('Alpha');
    });

    it('applies the pool to streamed auto requests', async () => {
        router.setEnabledModels({ Beta: ['beta-large'] });
        const chunks: StreamChunk[] = [];
        for await (const chunk of router.routeStream({ model: 'auto', messages: [] })) {
            chunks.push(chunk);
        }
        expect(chunks[0].choices[0].delta.content).toContain('Beta');
        expect(beta.lastRequest?.model).toBe('beta-large');
    });

    it('routes explicit model ids to the provider that lists them', async () => {
        const response = await router.route({ model: 'beta-large', messages: [] });
        expect(response.choices[0].message.content).toContain('Beta');
        expect(beta.lastRequest?.model).toBe('beta-large');
        expect(alpha.lastRequest).toBeUndefined();
    });

    it('lets explicit model ids bypass the enabled pool', async () => {
        router.setEnabledModels({ Alpha: ['alpha-default'] });
        const response = await router.route({ model: 'beta-large', messages: [] });
        expect(response.choices[0].message.content).toContain('Beta');
    });

    it('falls back to priority order for unknown explicit models', async () => {
        const response = await router.route({ model: 'mystery-model', messages: [] });
        expect(response.choices[0].message.content).toContain('Alpha');
        expect(alpha.lastRequest?.model).toBe('mystery-model');
    });

    it('routes explicit streamed requests to the matching provider', async () => {
        const chunks: StreamChunk[] = [];
        for await (const chunk of router.routeStream({ model: 'beta-large', messages: [] })) {
            chunks.push(chunk);
        }
        expect(chunks[0].choices[0].delta.content).toContain('Beta');
    });

    it('reports the pool through getEnabledModels', () => {
        expect(router.getEnabledModels()).toBeUndefined();
        router.setEnabledModels({ Alpha: ['alpha-default'] });
        expect(router.getEnabledModels()).toEqual({ Alpha: ['alpha-default'] });
        router.setEnabledModels(undefined);
        expect(router.getEnabledModels()).toBeUndefined();
    });
});
