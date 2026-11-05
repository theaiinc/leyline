export type MediaKind = 'image' | 'video' | 'audio';

export type ParameterSchema = {
  type: 'string' | 'number' | 'boolean' | 'file';
  title?: string;
  description?: string;
  required?: boolean;
  default?: string | number | boolean;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  accept?: string;
};

export type MediaModel = {
  id: string;
  name?: string;
  provider?: string;
  kind: MediaKind;
  served: boolean;
  comingSoon?: boolean;
  parameters: Record<string, ParameterSchema>;
  price?: { input?: number; output?: number };
};

export const defaultMediaParameters = (kind: MediaKind): Record<string, ParameterSchema> => {
  if (kind === 'audio') {
    return {
      input: { type: 'string', title: 'Text', description: 'Text to synthesize.', required: true },
      voice: { type: 'string', title: 'Voice', enum: ['alloy', 'nova', 'shimmer'], default: 'alloy' },
      response_format: { type: 'string', title: 'Format', enum: ['mp3', 'wav', 'opus'], default: 'mp3' },
    };
  }
  return {
    prompt: { type: 'string', title: 'Prompt', description: 'Describe the result.', required: true },
    input: { type: 'file', title: 'Reference file', accept: kind === 'image' ? 'image/*' : 'video/*' },
    size: { type: 'string', title: 'Size', enum: ['1024x1024', '1792x1024'], default: '1024x1024' },
  };
};

export const parameterDefaults = (parameters: Record<string, ParameterSchema>): Record<string, string | number | boolean> =>
  Object.fromEntries(Object.entries(parameters).map(([name, schema]) => {
    if (schema.default !== undefined) return [name, schema.default];
    if (schema.enum?.length) return [name, schema.enum[0]];
    if (schema.type === 'number') return [name, schema.minimum ?? 0];
    if (schema.type === 'boolean') return [name, false];
    return [name, ''];
  }));

export function estimateMediaCost(model: MediaModel, units = 1): number | undefined {
  const rate = model.price?.input;
  if (!model.served || typeof rate !== 'number' || !Number.isFinite(rate)) return undefined;
  return Math.max(0, units) * rate / 1_000_000;
}

export function mediaRunLabel(model: MediaModel, cost: number | undefined): string {
  if (model.comingSoon || !model.served) return 'Coming soon';
  if (cost === undefined) return 'Run · no price set';
  return `Run · $${cost.toFixed(6)}`;
}

export function mediaModels(models: MediaModel[], query = ''): MediaModel[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return models;
  return models.filter(model => `${model.name ?? ''} ${model.id} ${model.provider ?? ''} ${model.kind}`.toLowerCase().includes(normalized));
}