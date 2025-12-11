export interface CompletionRequest {
    model: string;
    messages: Array<{
        role: string;
        content: string;
    }>;
    stream?: boolean;
}
export interface CompletionResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: {
            role: string;
            content: string;
        };
        finish_reason: string;
    }>;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}
export interface StreamChunk {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<{
        index: number;
        delta: {
            role?: string;
            content?: string;
        };
        finish_reason: string | null;
    }>;
}
export interface Provider {
    name: string;
    isAvailable(): Promise<boolean>;
    complete(request: CompletionRequest): Promise<CompletionResponse>;
    completeStream(request: CompletionRequest): Promise<AsyncGenerator<StreamChunk, void, unknown>>;
}
export interface Quota {
    requestsPerMinute: number;
    requestsPerDay: number;
}
//# sourceMappingURL=types.d.ts.map