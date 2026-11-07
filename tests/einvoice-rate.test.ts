import { SETTINGS } from '../src/core/billing-service';
import { billingFixture } from './helpers/billing-fixture';

describe('the USD -> VND rate VAT e-invoices use', () => {
  it("is the day's published rate (as dash shows) when none is set on the admin host", async () => {
    const f = billingFixture({ vndRate: async () => ({ vnd_per_usd: 26380, date: '2026-11-07', source: 'vietcombank' }) });
    expect(await f.service.einvoiceRate()).toEqual({ vndPerUsd: 26380, date: '2026-11-07', source: 'vietcombank' });
  });

  it('is the admin-set rate when one is set, over the daily one', async () => {
    const f = billingFixture({ vndRate: async () => ({ vnd_per_usd: 26380, date: '2026-11-07', source: 'vietcombank' }) });
    await f.store.saveSetting(SETTINGS.exchangeRate, { vndPerUsd: 25500, date: '2026-11-01' }, 'a');
    expect(await f.service.einvoiceRate()).toEqual({ vndPerUsd: 25500, date: '2026-11-01', source: 'admin' });
  });

  it('is null only when neither is available', async () => {
    const f = billingFixture({ vndRate: async () => null });
    expect(await f.service.einvoiceRate()).toBeNull();
  });
});
