import { Provider, CompletionRequest, CompletionResponse, StreamChunk } from '../core/types';
export declare class OpenRouterProvider implements Provider {
    name: string;
    private apiKey;
    private model;
    constructor(apiKey?: string, model?: string);
    isAvailable(): Promise<boolean>;
    complete(request: CompletionRequest): Promise<CompletionResponse>;
    completeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown>;
}
//# sourceMappingURL=openrouter.d.ts.map