import { Provider, CompletionRequest, CompletionResponse, StreamChunk } from './types';
import { QuotaManager } from './quota-manager';
export declare class Router {
    private providers;
    private quotaManager;
    constructor(quotaManager: QuotaManager);
    addProvider(provider: Provider): void;
    route(request: CompletionRequest): Promise<CompletionResponse>;
    routeStream(request: CompletionRequest): Promise<AsyncGenerator<StreamChunk, void, unknown>>;
}
//# sourceMappingURL=router.d.ts.map