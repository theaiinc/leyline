import { buildRouter } from '../src/index';
import { MemorySecretStore } from '../src/core/secret-store';
import { BYTEPLUS_CATALOG_PRICING } from '../src/providers/byteplus';
import { toPublicPricingModel } from '../src/core/pricing';

describe('Worker provider wiring pricing regression', () => {
  it('registers BytePlus through the production router wiring and exposes every configured free-tier model with finite pricing', async () => {
    const { router } = await buildRouter(new MemorySecretStore());
    const provider = router.getProviders().find(candidate => candidate.name === 'BytePlus');

    expect(provider).toBeDefined();

    // Token-priced models only (image/video models are priced in src/core/media-catalog.ts).
    const models = (await provider!.getModels()).filter(model => model.pricing);
    expect(models.map(model => model.id)).toEqual(Object.keys(BYTEPLUS_CATALOG_PRICING));
    for (const model of models) {
      expect(model.pricing).toEqual(BYTEPLUS_CATALOG_PRICING[model.id]);
      expect(toPublicPricingModel('BytePlus', model)).toMatchObject({
        id: model.id,
        input: model.pricing?.input,
        output: model.pricing?.output,
      });
      expect(model.pricing).not.toHaveProperty('cached_input');
    }

    const freeTierModels = models.filter(model => ['seed-2-0-lite-260428', 'seed-2-0-mini-260428', 'deepseek-v4-flash-ga-260731'].includes(model.id));
    expect(freeTierModels).toHaveLength(3);
    expect(freeTierModels.every(model => model.pricing?.input !== undefined && model.pricing?.output !== undefined)).toBe(true);
  });
});