

export type ModelCategory = 'chat' | 'image' | 'video' | 'audio' | 'embeddings' | '3d';
export type ModelCapability = 'vision' | 'tools' | 'free-tier';

export type SchemaField = {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'file';
  description?: string;
  required?: boolean;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
};

export type ServableModel = {
  id: string;
  provider: string;
  name: string;
  category: ModelCategory;
  description: string;
  capabilities: ModelCapability[];
  freeTier: boolean;
  configured: boolean;
  comingSoon?: boolean;
  pricing: {
    input?: number;
    output?: number;
    run?: number;
    unit: string;
  };
  schema: {
    fields: SchemaField[];
  };
};

export const servableModels: ServableModel[] = [
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    name: 'GPT-4o mini',
    category: 'chat',
    description: 'A fast, affordable model for everyday conversations and structured tasks.',
    capabilities: ['vision', 'tools', 'free-tier'],
    freeTier: true,
    configured: true,
    pricing: { input: 0.15, output: 0.6, unit: 'per 1M tokens' },
    schema: {
      fields: [
        { name: 'system', label: 'System prompt', type: 'string', description: 'Set the assistant behaviour.' },
        { name: 'prompt', label: 'Message', type: 'string', required: true, description: 'What should the model do?' },
        { name: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 2, step: 0.1, default: 0.7 },
        { name: 'max_tokens', label: 'Max tokens', type: 'number', min: 1, max: 8192, step: 1, default: 1024 }
      ]
    }
  },
  {
    id: 'claude-3-5-haiku',
    provider: 'anthropic',
    name: 'Claude 3.5 Haiku',
    category: 'chat',
    description: 'A responsive model for analysis, writing, and fast agentic workflows.',
    capabilities: ['vision', 'tools'],
    freeTier: false,
    configured: true,
    pricing: { input: 0.8, output: 4, unit: 'per 1M tokens' },
    schema: {
      fields: [
        { name: 'system', label: 'System prompt', type: 'string' },
        { name: 'prompt', label: 'Message', type: 'string', required: true },
        { name: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 1, step: 0.1, default: 0.7 },
        { name: 'max_tokens', label: 'Max tokens', type: 'number', min: 1, max: 8192, default: 1024 }
      ]
    }
  },
  {
    id: 'text-embedding-3-small',
    provider: 'openai',
    name: 'Text Embedding 3 Small',
    category: 'embeddings',
    description: 'Compact embeddings for search, recommendations, and retrieval.',
    capabilities: ['free-tier'],
    freeTier: true,
    configured: true,
    pricing: { input: 0.02, unit: 'per 1M tokens' },
    schema: {
      fields: [
        { name: 'input', label: 'Text', type: 'string', required: true }
      ]
    }
  }
];

export function getServableModel(id: string): ServableModel | undefined {
  return servableModels.find((model) => model.id === id);
}

export function filterServableModels(models: ServableModel[], query: string): ServableModel[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return models;
  return models.filter((model) =>
    [model.id, model.name, model.provider, model.category, model.description]
      .some((value) => value.toLowerCase().includes(normalized))
  );
}