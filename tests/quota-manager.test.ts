import { QuotaManager } from '../src/core/quota-manager';
import { Quota } from '../src/core/types';

describe('QuotaManager', () => {
    let quotaManager: QuotaManager;

    beforeEach(() => {
        quotaManager = new QuotaManager();
    });

    it('should allow requests when under quota', () => {
        const provider = 'test-provider';
        const quota: Quota = { requestsPerMinute: 2, requestsPerDay: 10 };
        quotaManager.setQuota(provider, quota);

        expect(quotaManager.checkQuota(provider)).toBe(true);
        quotaManager.incrementUsage(provider);
        expect(quotaManager.checkQuota(provider)).toBe(true);
        quotaManager.incrementUsage(provider);
    });

    it('should block requests when quota exceeded', () => {
        const provider = 'test-provider';
        const quota: Quota = { requestsPerMinute: 1, requestsPerDay: 10 };
        quotaManager.setQuota(provider, quota);

        quotaManager.incrementUsage(provider);
        expect(quotaManager.checkQuota(provider)).toBe(false);
    });

    it('should track different providers separately', () => {
        const provider1 = 'p1';
        const provider2 = 'p2';
        const quota: Quota = { requestsPerMinute: 1, requestsPerDay: 10 };
        quotaManager.setQuota(provider1, quota);
        quotaManager.setQuota(provider2, quota);

        quotaManager.incrementUsage(provider1);
        expect(quotaManager.checkQuota(provider1)).toBe(false);
        expect(quotaManager.checkQuota(provider2)).toBe(true);
    });
});
