export type MediaKind = 'image' | 'video' | 'audio';
export type MediaMode = 'speech' | 'transcription' | 'image' | 'video';

export type ParameterSchema = {
  type?: 'string' | 'number' | 'boolean' | 'file';
  title?: string;
  description?: string;
  required?: boolean;
  default?: string | number | boolean;
  enum?: string[];
  minimum?: number;
  maximum?: number;
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

export function mediaModels(models: MediaModel[], query = ''): MediaModel[] {
  const normalized = query.trim().toLowerCase();
  return models.filter(model => (
    model.served || model.comingSoon
  ) && (!normalized || `${model.id} ${model.name ?? ''} ${model.provider ?? ''} ${model.kind}`.toLowerCase().includes(normalized)));
}

export function parameterDefaults(parameters: Record<string, ParameterSchema>): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(parameters).map(([name, schema]) => {
    if (schema.default !== undefined) return [name, schema.default];
    if (schema.enum?.[0] !== undefined) return [name, schema.enum[0]];
    if (schema.type === 'number') return [name, schema.minimum ?? 0];
    if (schema.type === 'boolean') return [name, false];
    return [name, ''];
  }));
}

export function defaultMediaParameters(kind: MediaKind): Record<string, ParameterSchema> {
  if (kind === 'audio') return {
    input: { type: 'string', title: 'Text', description: 'Text to convert to speech.', required: true },
    voice: { type: 'string', title: 'Voice', enum: ['alloy', 'nova', 'shimmer'], default: 'alloy' },
    response_format: { type: 'string', title: 'Format', enum: ['mp3', 'wav', 'opus'], default: 'mp3' },
    speed: { type: 'number', title: 'Speed', minimum: 0.25, maximum: 4, default: 1 },
  };
  if (kind === 'image') return {
    prompt: { type: 'string', title: 'Prompt', description: 'Describe the image to create.', required: true },
    size: { type: 'string', title: 'Size', enum: ['1024x1024', '1536x1024', '1024x1536'], default: '1024x1024' },
    quality: { type: 'string', title: 'Quality', enum: ['auto', 'standard', 'hd'], default: 'auto' },
  };
  return {
    prompt: { type: 'string', title: 'Prompt', description: 'Describe the video to create.', required: true },
    duration: { type: 'number', title: 'Duration (seconds)', minimum: 1, maximum: 30, default: 5 },
    aspect_ratio: { type: 'string', title: 'Aspect ratio', enum: ['16:9', '1:1', '9:16'], default: '16:9' },
  };
}

export function estimateMediaCost(model: MediaModel | undefined, inputUnits = 1): number | undefined {
  if (!model?.served || model.price?.input === undefined) return undefined;
  return model.price.input * inputUnits / 1_000_000;
}

export function mediaRunLabel(model: MediaModel | undefined, estimate: number | undefined): string {
  if (!model || model.comingSoon) return 'Coming soon';
  if (estimate === undefined) return 'Run · no price set';
  return `Run · $${estimate.toFixed(6)}`;
}

export function mediaEndpoint(mode: MediaMode): string {
  if (mode === 'speech') return '/v1/audio/speech';
  if (mode === 'transcription') return '/v1/audio/transcriptions';
  return mode === 'image' ? '/v1/images/generations' : '/v1/videos/generations';
}

export function mediaCurl(mode: MediaMode, model: string, parameters: Record<string, unknown>): string {
  const endpoint = `https://llm.valefront.com${mediaEndpoint(mode)}`;
  const body = JSON.stringify({ model, ...parameters });
  if (mode === 'transcription') {
    return `curl ${endpoint} -H "Authorization: Bearer $VALEFRONT_API_KEY" -F model=${model} -F file=@audio.mp3`;
  }
  return `curl ${endpoint} -H "Authorization: Bearer $VALEFRONT_API_KEY" -H "Content-Type: application/json" -d '${body}'`;
}