import { BUYER, WORLDFIRST, billingFixture, workspace } from './helpers/billing-fixture';
import { SETTINGS } from '../src/core/billing-service';

// Launch offer (Steve, 2026-11-05): 1M free tokens at sign-up; the first paid top-up unlocks 4M more, once.
describe('free tokens: the first top-up unlocks the bonus', () => {
  it('adds 4M once, on the first paid order, and gives at least 30 more days', async () => {
    const f = billingFixture({ free: { tokens: 1_000_000, bonusTokens: 4_000_000, expiresAfterDays: 30, models: ['deepseek-v4-flash-ga-260731'], tokensPerDay: 250_000, globalTokensPerDay: 20_000_000 } });
    await f.store.saveSetting(SETTINGS.account, WORLDFIRST, 'admin');
    const ws = await workspace(f.store, { at: f.clock.now - 25 * 86_400_000 });
    await f.service.saveProfile(ws, BUYER);
    expect((await f.store.grant(ws.id))!.tokens).toBe(1_000_000);
    const order = async (k: string) => (await f.service.createOrder(ws, { amountCents: 1000, method: 'worldfirst', idempotencyKey: 'bonus-test-' + k })).order;
    const first = await order('a1');
    await f.service.markPaid(first.id, { by: 'admin' });
    const g = (await f.store.grant(ws.id))!;
    expect(g.tokens).toBe(5_000_000);
    expect(g.expiresAt).toBeGreaterThanOrEqual(f.clock.now + 30 * 86_400_000);
    const billing = await f.service.overview(ws);
    expect(billing.free).toMatchObject({ bonusTokens: 4_000_000, bonusUnlocked: true });
    const second = await order('a2');
    await f.service.markPaid(second.id, { by: 'admin' });
    expect((await f.store.grant(ws.id))!.tokens).toBe(5_000_000);
  });
});
