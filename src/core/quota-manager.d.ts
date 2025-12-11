import { Quota } from './types';
export declare class QuotaManager {
    private requestCounts;
    private quotas;
    constructor();
    setQuota(providerName: string, quota: Quota): void;
    checkQuota(providerName: string): boolean;
    incrementUsage(providerName: string): void;
}
//# sourceMappingURL=quota-manager.d.ts.map