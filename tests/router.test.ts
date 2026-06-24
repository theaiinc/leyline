import { Router } from '../src/core/router';
import { QuotaManager } from '../src/core/quota-manager';
import { Provider, CompletionRequest, CompletionResponse, StreamChunk, ModelDetail } from '../src/core/types';

// Mock Provider
class MockProvider implements Provider {
    name: string;
    shouldFail: boolean = false;
    shouldThrow: boolean = false;
    defaultModel: string;
    
    constructor(name: string) {
        this.name = name;
        this.defaultModel = `default-${name}`;
    }

    async isAvailable(): Promise<boolean> {
        return !this.shouldFail;
    }

    async getModels(): Promise<ModelDetail[]> {
        return [
            { id: 'model-a', name: 'Model A' },
            { id: 'model-b', name: 'Model B' }
        ];
    }

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
        if (this.shouldThrow) throw new Error('Simulated failure');
        return {
            id: 'mock',
            object: 'mock',
            created: Date.now(),
            model: 'mock',
            choices: [{
                index: 0,
                message: { role: 'assistant', content: `Response from ${this.name}` },
                finish_reason: 'stop'
            }]
        };
    }

    async *completeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
         if (this.shouldThrow) throw new Error('Simulated failure');
         yield {
             id: 'mock',
             object: 'mock',
             created: Date.now(),
             model: 'mock',
             choices: [{
                 index: 0,
                 delta: { content: `Response from ${this.name}` },
                 finish_reason: null
             }]
         };
    }
}

describe('Router', () => {
    let router: Router;
    let quotaManager: QuotaManager;
    let p1: MockProvider;
    let p2: MockProvider;

    beforeEach(() => {
        quotaManager = new QuotaManager();
        router = new Router(quotaManager);
        p1 = new MockProvider('p1');
        p2 = new MockProvider('p2');
        router.addProvider(p1);
        router.addProvider(p2);
    });

    it('should route to first available provider', async () => {
        const response = await router.route({ model: 'test', messages: [] });
        expect(response.choices[0].message.content).toContain('p1');
    });

    it('should failover to second provider if first fails availability check', async () => {
        p1.shouldFail = true;
        const response = await router.route({ model: 'test', messages: [] });
        expect(response.choices[0].message.content).toContain('p2');
    });

    it('should failover to second provider if first throws error', async () => {
        p1.shouldThrow = true;
        const response = await router.route({ model: 'test', messages: [] });
        expect(response.choices[0].message.content).toContain('p2');
    });

    it('should throw if all providers fail', async () => {
        p1.shouldFail = true;
        p2.shouldFail = true;
        await expect(router.route({ model: 'test', messages: [] }))
            .rejects.toThrow('All providers failed or are rate-limited');
    });

    it('should route only to the configured fixed provider and model', async () => {
        router = new Router({
            quotaManager,
            singleModel: { enabled: true, provider: 'p2', model: 'fixed-model' },
        });
        router.addProvider(p1);
        router.addProvider(p2);
        const p1Spy = jest.spyOn(p1, 'complete');
        const p2Spy = jest.spyOn(p2, 'complete');

        const response = await router.route({ model: 'ignored-model', messages: [] });

        expect(response.choices[0].message.content).toContain('p2');
        expect(p1Spy).not.toHaveBeenCalled();
        expect(p2Spy).toHaveBeenCalledWith({ model: 'fixed-model', messages: [] });
    });

    it('should not fail over when fixed provider fails', async () => {
        router = new Router({
            quotaManager,
            singleModel: { enabled: true, provider: 'p1', model: 'fixed-model' },
        });
        p1.shouldThrow = true;
        router.addProvider(p1);
        router.addProvider(p2);
        const p2Spy = jest.spyOn(p2, 'complete');

        await expect(router.route({ model: 'ignored-model', messages: [] }))
            .rejects.toThrow('Simulated failure');
        expect(p2Spy).not.toHaveBeenCalled();
    });

    it('should Seamlessly failover mid-stream', async () => {
        // P1 yields "Hello" then failed
        p1.completeStream = async function* (req) {
             yield {
                 id: 'p1', object: 'chunk', created: 1, model: 'test',
                 choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }]
             };
             throw new Error('Mid-stream failure');
        };

        // P2 receives "Hello" in history and continues " World"
        const p2Spy = jest.spyOn(p2, 'completeStream');
        p2Spy.mockImplementation(async function* (req) {
            // Verify P2 received the partial content
            const lastMsg = req.messages[req.messages.length - 1];
            if (lastMsg.role === 'assistant' && lastMsg.content === 'Hello') {
                 yield {
                    id: 'p2', object: 'chunk', created: 2, model: 'test',
                    choices: [{ index: 0, delta: { content: ' World' }, finish_reason: 'stop' }]
                };
            } else {
                yield {
                    id: 'p2', object: 'chunk', created: 2, model: 'test',
                    choices: [{ index: 0, delta: { content: 'WRONG CONTEXT' }, finish_reason: 'stop' }]
                };
            }
        });

        const stream = router.routeStream({ model: 'test', messages: [] });
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk.choices[0].delta.content);
        }

        expect(chunks.join('')).toBe('Hello World');
        expect(p2Spy).toHaveBeenCalled();
    });

    it('should stream only from the configured fixed provider and model', async () => {
        router = new Router({
            quotaManager,
            singleModel: { enabled: true, provider: 'p2', model: 'fixed-stream-model' },
        });
        router.addProvider(p1);
        router.addProvider(p2);
        const p1Spy = jest.spyOn(p1, 'completeStream');
        const p2Spy = jest.spyOn(p2, 'completeStream');

        const chunks = [];
        for await (const chunk of router.routeStream({ model: 'ignored-model', messages: [] })) {
            chunks.push(chunk.choices[0].delta.content);
        }

        expect(chunks.join('')).toContain('p2');
        expect(p1Spy).not.toHaveBeenCalled();
        expect(p2Spy).toHaveBeenCalledWith({ model: 'fixed-stream-model', messages: [] });
    });
});
