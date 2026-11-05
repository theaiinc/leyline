import {
  estimateMediaCost,
  mediaRunLabel,
  parameterDefaults,
  type MediaModel,
} from '../dashboard/src/lib/media-playground';

describe('media playground helpers', () => {
  const speech: MediaModel = {
    id: 'tts-1',
    name: 'Speech model',
    kind: 'audio',
    served: true,
    parameters: {
      voice: { type: 'string', enum: ['alloy', 'nova'], default: 'nova' },
      speed: { type: 'number', minimum: 0.5, maximum: 2 },
      stream: { type: 'boolean' },
    },
    price: { input: 1500 },
  };

  it('generates schema defaults for enum, number, and boolean inputs', () => {
    expect(parameterDefaults(speech.parameters)).toEqual({
      voice: 'nova',
      speed: 0.5,
      stream: false,
    });
  });

  it('estimates a published price from input units', () => {
    expect(estimateMediaCost(speech, 1000)).toBe(1.5);
    expect(mediaRunLabel(speech, estimateMediaCost(speech, 1000))).toBe('Run · $1.500000');
  });

  it('refuses to estimate when the model has no published price', () => {
    const unpriced = { ...speech, price: undefined };
    expect(estimateMediaCost(unpriced, 1000)).toBeUndefined();
    expect(mediaRunLabel(unpriced, undefined)).toBe('Run · no price set');
  });
});