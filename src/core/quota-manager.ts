import { Quota } from './types';

export class QuotaManager {
  private requestCounts: Map<string, { minute: number; day: number; lastResetMinute: number; lastResetDay: number }> = new Map();
  private quotas: Map<string, Quota> = new Map();

  constructor() {}

  setQuota(providerName: string, quota: Quota) {
    this.quotas.set(providerName, quota);
  }

  checkQuota(providerName: string): boolean {
    const quota = this.quotas.get(providerName);
    if (!quota) return true; // No quota set means unlimited

    const now = Date.now();
    const currentMinute = Math.floor(now / 60000);
    const currentDay = Math.floor(now / 86400000);

    let stats = this.requestCounts.get(providerName);
    if (!stats) {
      stats = { minute: 0, day: 0, lastResetMinute: currentMinute, lastResetDay: currentDay };
      this.requestCounts.set(providerName, stats);
    }

    if (stats.lastResetMinute !== currentMinute) {
      stats.minute = 0;
      stats.lastResetMinute = currentMinute;
    }

    if (stats.lastResetDay !== currentDay) {
      stats.day = 0;
      stats.lastResetDay = currentDay;
    }

    if (stats.minute >= quota.requestsPerMinute) {
      console.log(`[QuotaManager] ${providerName} exceeded minute quota. Current: ${stats.minute}, Limit: ${quota.requestsPerMinute}`);
      return false;
    }

    if (stats.day >= quota.requestsPerDay) {
      console.log(`[QuotaManager] ${providerName} exceeded daily quota. Current: ${stats.day}, Limit: ${quota.requestsPerDay}`);
      return false;
    }

    return true;
  }

  incrementUsage(providerName: string) {
    const now = Date.now();
    const currentMinute = Math.floor(now / 60000);
    const currentDay = Math.floor(now / 86400000);

    let stats = this.requestCounts.get(providerName);
    if (!stats) {
      stats = { minute: 0, day: 0, lastResetMinute: currentMinute, lastResetDay: currentDay };
      this.requestCounts.set(providerName, stats);
    }
    
    // Check reset logic in increment too
    if (stats.lastResetMinute !== currentMinute) {
        stats.minute = 0;
        stats.lastResetMinute = currentMinute;
    }

    if (stats.lastResetDay !== currentDay) {
        stats.day = 0;
        stats.lastResetDay = currentDay;
    }

    stats.minute++;
    stats.day++;
  }

  getStats(): Record<string, { minute: number; day: number; quota: Quota | undefined }> {
    const stats: Record<string, { minute: number; day: number; quota: Quota | undefined }> = {};
    const allProviders = new Set([...this.quotas.keys(), ...this.requestCounts.keys()]);

    for (const provider of allProviders) {
        const counts = this.requestCounts.get(provider) || { minute: 0, day: 0 };
        stats[provider] = {
            minute: counts.minute,
            day: counts.day,
            quota: this.quotas.get(provider)
        };
    }
    return stats;
  }
}
