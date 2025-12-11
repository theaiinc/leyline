import { Provider, CompletionRequest, CompletionResponse, StreamChunk } from '../core/types';
export declare class HuggingFaceProvider implements Provider {
    name: string;
    private client;
    private model;
    constructor(apiKey?: string, model?: string);
    isAvailable(): Promise<boolean>;
    complete(request: CompletionRequest): Promise<CompletionResponse>;
    completeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown>;
}
//# sourceMappingURL=huggingface.d.ts.map