import { Provider, CompletionRequest, CompletionResponse, StreamChunk } from '../core/types';
export declare class OllamaProvider implements Provider {
    name: string;
    private baseUrl;
    private model;
    constructor(baseUrl?: string, model?: string);
    isAvailable(): Promise<boolean>;
    complete(request: CompletionRequest): Promise<CompletionResponse>;
    completeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown>;
}
//# sourceMappingURL=ollama.d.ts.map