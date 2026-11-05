import { estimateMediaCost, mediaRunLabel, parameterDefaults } from './media-playground';

describe('media playground helpers', () => {
  it('generates sensible defaults from a parameter schema', () => {
    expect(parameterDefaults({
      prompt: { type: 'string', required: true },
      size: { type: 'string', enum: ['1024x1024', '1792x1024'] },
      steps: { type: 'number', minimum: 4, maximum: 40 },
      async: { type: 'boolean', default: true },
    })).toEqual({
      prompt: '',
      size: '1024x1024',
      steps: 4,
      async: true,
    });
  });

  it('estimates a served priced media run from published units', () => {
    const model = {
      id: 'image-model',
      kind: 'image' as const,
      served: true,
      parameters: {},
      price: { input: 2.5 },
    };
    expect(estimateMediaCost(model, 1_000_000)).toBe(2.5);
    expect(mediaRunLabel(model, estimateMediaCost(model, 1_000_000))).toBe('Run · $2.500000');
  });

  it('refuses to guess when a model has no published price', () => {
    const model = {
      id: 'unpriced-model',
      kind: 'video' as const,
      served: true,
      parameters: {},
    };
    expect(estimateMediaCost(model)).toBeUndefined();
    expect(mediaRunLabel(model, undefined)).toBe('Run · no price set');
  });
});