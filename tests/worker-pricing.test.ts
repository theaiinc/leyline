import { buildRouter } from '../src/index';
import { MemorySecretStore } from '../src/core/secret-store';

describe('Worker provider wiring pricing regression', () => {
  it('registers BytePlus through the production router wiring and exposes every configured free-tier model with finite pricing', async () => {
    const { router } = await buildRouter(new MemorySecretStore());
    const provider = router.getProviders().find(candidate => candidate.name === 'BytePlus');

    expect(provider).toBeDefined();

    const models = await provider!.getModels();
    const required = [
      'seed-2-0-lite-260428',
      'seed-2-0-mini-260428',
      'deepseek-v4-1-flash-261017',
      'deepseek-v4-flash-ga-260731',
      'glm-5-3-flash-260828',
    ];

    for (const id of required) {
      const model = models.find(candidate => candidate.id === id);
      expect(model).toBeDefined();
      expect(model?.pricing).toEqual(expect.objectContaining({
        input: expect.any(Number),
        output: expect.any(Number),
      }));
      expect(model?.pricing?.input).toBeGreaterThanOrEqual(0);
      expect(model?.pricing?.output).toBeGreaterThanOrEqual(0);
    }
  });
});