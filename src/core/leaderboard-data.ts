export const LEADERBOARD_SCORES: Record<string, number> = {
    // OpenAI
    'gpt-4o': 1287,
    'gpt-4-turbo': 1261,
    'gpt-4-1106-preview': 1258,
    'gpt-4-0125-preview': 1255,
    'gpt-4': 1250,
    'gpt-4o-mini': 1220,
    'gpt-3.5-turbo': 1100,

    // Google
    'gemini-1.5-pro': 1260,
    'gemini-1.5-flash': 1230,
    'gemini-1.0-pro': 1180,

    // Anthropic
    'claude-3-5-sonnet': 1300,
    'claude-3-opus': 1260,
    'claude-3-sonnet': 1200,
    'claude-3-haiku': 1180,

    // Meta
    'llama-3-70b-instruct': 1200,
    'llama-3-8b-instruct': 1150,
    'llama-2-70b-chat': 1050,
    'llama-2-13b-chat': 1000,
    'llama-2-7b-chat': 950,

    // Mistral
    'mistral-large-2407': 1250,
    'mistral-large': 1230,
    'mistral-medium': 1190,
    'mixtral-8x22b': 1180,
    'mixtral-8x7b': 1150,
    'mistral-7b-instruct': 1100,

    // Microsoft
    'phi-3-mini': 1100,
    'phi-3-medium': 1150,

    // Others
    'command-r-plus': 1190,
    'qwen1.5-72b-chat': 1180
};

// Helper to fuzzy match model IDs to scores
export function getModelScore(modelId: string): number | undefined {
    const lowerId = modelId.toLowerCase();
    
    // Direct match
    for (const [key, score] of Object.entries(LEADERBOARD_SCORES)) {
        if (lowerId.includes(key)) return score;
    }
    
    return undefined;
}
